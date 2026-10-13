#!/usr/bin/env node
/**
 * librarian — keeps the Jellyfin library in step with EPGStation.
 *
 * Every pass (timer, or POST /sync from EPGStation's recordingFinishCommand / encodingFinishCommand):
 *   1. list all recordings from the EPGStation API (a failed or partial list aborts the pass, nothing is removed);
 *   2. place each finished recording in LIBRARY/TV/<Show>/ or LIBRARY/Movies/<Title> (<Year>)/ as a hardlink with an
 *      NFO and the EPGStation thumbnail (naming and metadata: epgmeta.js, ported from epgXport);
 *   3. when the preferred video changes (an encode finished), the library file is swapped;
 *   4. recordings deleted in EPGStation lose their library files (only files this service created, tracked in STATE);
 *   5. when anything changed, Jellyfin is asked to scan its libraries.
 * On start it also runs the Jellyfin first-time setup (jellyfin-setup.js) unless JELLYSTATION_JELLYFIN_SETUP=false.
 *
 * Settings (environment): see CONFIG below. No npm dependencies (Node.js 22).
 */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), { execFileSync } = require('child_process');
const meta = require('./epgmeta');
const jellyfinSetup = require('./jellyfin-setup');
const mirakurunEpg = require('./mirakurun-epg');
const livetv = require('./livetv');

const env = process.env;
const CONFIG = {
  epgstation: (env.JELLYSTATION_EPGSTATION_URL || 'http://127.0.0.1:8888').replace(/\/$/, ''),
  jellyfin: (env.JELLYSTATION_JELLYFIN_URL || 'http://127.0.0.1:8096').replace(/\/$/, ''),
  library: env.JELLYSTATION_LIBRARY || '/media/library',
  tvDir: env.JELLYSTATION_TV_DIR || 'TV',
  movieDir: env.JELLYSTATION_MOVIE_DIR || 'Movies',
  recordedDirs: (env.JELLYSTATION_RECORDED_DIRS || '/media/recorded:/media/encoded').split(':').filter(Boolean),
  prefer: env.JELLYSTATION_PREFER || 'encoded', // 'encoded': an encoded file when there is one, else the TS; 'ts': always the TS
  stateDir: env.JELLYSTATION_STATE_DIR || '/config/jellystation',
  interval: +(env.JELLYSTATION_SYNC_INTERVAL || 600) * 1000,
  listen: +(env.JELLYSTATION_LIBRARIAN_PORT || 40780),
  massDelete: /^(1|true|yes)$/i.test(env.JELLYSTATION_ALLOW_MASS_DELETE || ''),
  // ARIB captions as sidecar files: 'srt' (any client), 'ass' (position and colour), 'both', or 'false'
  subtitles: { srt: ['srt'], ass: ['ass'], both: ['ass', 'srt'] }[(env.JELLYSTATION_SUBTITLES || 'srt').toLowerCase()] || [],
  subtitleFfmpeg: env.JELLYSTATION_SUBTITLE_FFMPEG || '/opt/ffmpeg-arib/bin/ffmpeg',
};
/** Changes when the caption setting changes, so existing library entries get (or keep) the right sidecars. */
const SUBS_KEY = CONFIG.subtitles.join('+') || 'none';
const STATE_FILE = path.join(CONFIG.stateDir, 'librarian.json');
const VIDEO_EXT = /\.(m2ts|ts|mp4|mkv|webm)$/i;

const log = (...args) => console.log(new Date().toISOString(), ...args);

// --- EPGStation API ---------------------------------------------------------------------------------------------------

async function api(pathAndQuery, { raw = false, timeout = 30000 } = {}) {
  const res = await fetch(CONFIG.epgstation + '/api' + pathAndQuery, { signal: AbortSignal.timeout(timeout) });
  if (!res.ok) throw new Error(`EPGStation ${pathAndQuery}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
}

/** All recordings; throws when the list is incomplete. */
async function allRecorded() {
  const records = [];
  for (let offset = 0; ; offset += 100) {
    const page = await api(`/recorded?isHalfWidth=false&offset=${offset}&limit=100`);
    records.push(...page.records);
    if (!page.records.length || records.length >= page.total) {
      if (records.length < page.total) throw new Error(`recorded list stopped at ${records.length} of ${page.total}`);
      return records;
    }
  }
}

// --- files ------------------------------------------------------------------------------------------------------------

/** basename → [full paths] for every video under the recorded directories. */
function indexRecordedFiles() {
  const index = new Map();
  const walk = dir => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && VIDEO_EXT.test(e.name)) index.set(e.name, [...(index.get(e.name) || []), full]);
    }
  };
  CONFIG.recordedDirs.forEach(walk);
  return index;
}

/** The video to put in the library for a recording, with its full path, or undefined. */
function chooseVideo(rec, index) {
  const files = (rec.videoFiles || []).map(v => {
    const full = (index.get(v.filename) || []).find(p => { try { return fs.statSync(p).size === v.size; } catch { return false; } });
    return full && { ...v, full };
  }).filter(Boolean);
  const ts = files.find(v => v.type === 'ts'), encoded = files.filter(v => v.type === 'encoded');
  if (CONFIG.prefer === 'ts') return ts || encoded[0];
  return encoded[encoded.length - 1] || ts;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return { items: {} }; throw e; }
}

function saveState(state) {
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 1));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}

/** Remove one recording's library files; the folder too when no video is left in it. */
function removeEntry(entry) {
  for (const file of entry.files) fs.rmSync(file, { force: true });
  const folder = path.dirname(entry.dst);
  let left;
  try { left = fs.readdirSync(folder); } catch { return; }
  if (!left.some(f => VIDEO_EXT.test(f))) {
    for (const f of left) if (f === 'tvshow.nfo' || /\.(nfo|jpg|ass|srt)$/.test(f)) fs.rmSync(path.join(folder, f), { force: true });
    try { fs.rmdirSync(folder); } catch { /* someone else's files: keep the folder */ }
  }
}

/**
 * Series images for a show folder that has none yet, from an episode thumbnail: poster.jpg (centre crop to 2:3),
 * landscape.jpg (Jellyfin's thumb) and fanart.jpg (backdrop). Images already there (the user's) are left alone.
 */
function showArt(folder, thumb) {
  if (!fs.existsSync(thumb)) return;
  for (const [name, crop] of [['poster.jpg', 'crop=ih*2/3:ih'], ['landscape.jpg'], ['fanart.jpg']]) {
    const file = path.join(folder, name);
    if (fs.existsSync(file)) continue;
    try {
      if (crop) execFileSync(CONFIG.subtitleFfmpeg, ['-v', 'error', '-y', '-i', thumb, '-vf', crop, '-q:v', '2', file]);
      else fs.copyFileSync(thumb, file);
    } catch (e) { log(`${file}: ${e.message}`); }
  }
}

// --- placing one recording --------------------------------------------------------------------------------------------

const caches = { channels: null, rules: new Map() };

async function channelName(id) {
  if (!caches.channels) caches.channels = new Map((await api('/channels')).map(c => [c.id, c.name]));
  return caches.channels.get(id) || '';
}

async function ruleDirectory(ruleId) {
  if (!ruleId) return '';
  if (!caches.rules.has(ruleId)) {
    let dir = '';
    try { dir = (await api(`/rules/${ruleId}`)).saveOption?.directory || ''; } catch { /* rule deleted */ }
    caches.rules.set(ruleId, dir);
  }
  return caches.rules.get(ruleId);
}

/** EPGStation's thumbnail for the recording, downloaded to a temporary file (undefined when there is none). */
async function fetchThumbnail(rec) {
  const id = (rec.thumbnails || [])[0];
  if (id === undefined) return undefined;
  const file = path.join(CONFIG.stateDir, `thumb-${id}.jpg`);
  fs.writeFileSync(file, await api(`/thumbnails/${id}`, { raw: true }));
  return file;
}

/** Place a recording (same steps as epgXport's main()); returns the state entry. */
async function place(rec, video) {
  const genres = [1, 2, 3].map(i => [rec[`genre${i}`], rec[`subGenre${i}`]]).filter(([g]) => g !== undefined && g !== null).map(g => g.map(Number));
  const dir = path.basename((await ruleDirectory(rec.ruleId)).trim()).normalize('NFKC');
  const channel = meta.norm(await channelName(rec.channelId));
  const parsed = meta.norm(rec.name) ? meta.parse({ name: rec.name, genres, dir }) : { kind: 'tv', show: dir || channel || '_', subtitle: '' };

  const start = rec.startAt, endAt = rec.endAt;
  const jst = new Date(start + 9 * 3600e3).toISOString(), date = jst.slice(0, 10), hhmm = jst.slice(11, 13) + jst.slice(14, 16);
  const rawName = meta.norm(rec.name), desc = rec.description || '', extendedText = rec.extended || '';
  const { plot, people } = meta.extended(desc, extendedText);
  const { showFields, flagTags } = meta.genreFields(genres, channel, rawName);
  const nfoItem = (extraTags, plotSuffix) => [['outline', desc.trim()], ['plot', [plot, plotSuffix].filter(Boolean).join('\n\n')],
    ['runtime', Math.round((endAt - start) / 60000) || undefined], ...showFields, ...[...new Set([...extraTags, ...flagTags])].map(t => ['tag', t]), ...people];
  const ext = path.extname(video.full) || '.ts';
  const cfg = { library: CONFIG.library, tvDir: CONFIG.tvDir, movieDir: CONFIG.movieDir, link: 'hardlink', remux: false,
    subtitles: CONFIG.subtitles, subtitleFfmpeg: CONFIG.subtitleFfmpeg };

  const target = parsed.kind === 'movie'
    ? meta.movieTarget({ cfg, parsed, desc, extendedText, nfoItem, rawName })
    : meta.tvTarget({ cfg, parsed, dir, date, hhmm, ext, nfoItem, rawName, showFields });
  fs.mkdirSync(target.folderPath, { recursive: true });
  if (target.showNfo) {
    try { fs.writeFileSync(path.join(target.folderPath, 'tvshow.nfo'), target.showNfo, { flag: 'wx' }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const thumbnail = await fetchThumbnail(rec).catch(e => { log(`recorded ${rec.id}: no thumbnail (${e.message})`); });
  try {
    const { dst, how, subtitles } = meta.placeRecording(video.full, target.folderPath, target.base, ext, target.nfo, thumbnail,
      meta.THUMB_SUFFIXES[parsed.kind], cfg);
    const base = dst.slice(0, -ext.length);
    const files = [dst, base + '.nfo', ...meta.THUMB_SUFFIXES[parsed.kind].map(s => base + s),
      ...Object.values(meta.SUBTITLE).map(f => base + f.suffix)];
    log(`recorded ${rec.id}: ${how} ${video.full} -> ${dst}${subtitles.length ? `; captions ${subtitles.join(', ')}` : ''}`);
    if (parsed.kind === 'tv' && thumbnail) showArt(target.folderPath, base + '-thumb.jpg');
    return { source: video.full, videoFileId: video.id, dst, files, kind: parsed.kind, thumb: !!thumbnail, subs: SUBS_KEY };
  } finally {
    if (thumbnail) fs.rmSync(thumbnail, { force: true });
  }
}

// --- one pass ---------------------------------------------------------------------------------------------------------

let running = null, again = false;

/** Run a pass; a request during a pass runs one more pass afterwards. */
function sync(reason) {
  if (running) { again = true; return running; }
  running = (async () => {
    try {
      do { again = false; await pass(reason); reason = 'queued'; } while (again);
    } catch (e) { log(`sync failed: ${e.message}`); } finally { running = null; }
  })();
  return running;
}

async function pass(reason) {
  caches.channels = null; caches.rules.clear();
  const records = await allRecorded();
  const index = indexRecordedFiles();
  const state = loadState();
  let changed = 0, retrySoon = false;
  const seen = new Set();

  for (const rec of records) {
    const id = String(rec.id);
    seen.add(id);
    if (rec.isRecording) continue;
    const video = chooseVideo(rec, index);
    if (!video) continue;
    const old = state.items[id];
    // Thumbnails appear a moment after the recording ends: wait up to 3 minutes for one.
    if (!(rec.thumbnails || []).length && Date.now() - rec.endAt < 180e3) { retrySoon = true; continue; }
    const same = old && old.source === video.full && fs.existsSync(old.dst);
    if (same && old.subs === SUBS_KEY) continue;
    try {
      // Same video, other caption setting: placing again keeps the files and adds the missing sidecars.
      if (old && !same) { removeEntry(old); log(`recorded ${id}: replacing ${old.dst}`); }
      state.items[id] = await place(rec, video);
      changed++;
      saveState(state);
    } catch (e) { log(`recorded ${id}: ${e.message}`); }
  }

  const gone = Object.keys(state.items).filter(id => !seen.has(id));
  const known = Object.keys(state.items).length;
  if (gone.length && !CONFIG.massDelete && gone.length > 5 && gone.length > known / 2) {
    log(`refusing to remove ${gone.length} of ${known} library entries at once (EPGStation database reset?); ` +
      'set JELLYSTATION_ALLOW_MASS_DELETE=true to allow');
  } else {
    for (const id of gone) {
      removeEntry(state.items[id]);
      log(`recorded ${id}: deleted in EPGStation, removed ${state.items[id].dst}`);
      delete state.items[id];
      changed++;
    }
  }
  saveState(state);
  log(`pass (${reason}): ${records.length} recordings, ${Object.keys(state.items).length} in library, ${changed} changed`);
  if (changed) await jellyfinSetup.refreshLibrary().catch(e => log(`Jellyfin refresh failed: ${e.message}`));
  if (retrySoon) setTimeout(() => sync('waiting for thumbnail'), 30e3).unref();
}

// --- main -------------------------------------------------------------------------------------------------------------

async function main() {
  fs.mkdirSync(CONFIG.stateDir, { recursive: true });
  for (const d of [CONFIG.tvDir, CONFIG.movieDir]) fs.mkdirSync(path.join(CONFIG.library, d), { recursive: true });

  http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/sync') { sync('notify'); res.writeHead(202).end('queued\n'); }
    else if (req.method === 'GET' && req.url === '/livetv.m3u') {
      livetv.playlist().then(m3u => res.writeHead(200, { 'Content-Type': 'audio/x-mpegurl; charset=utf-8' }).end(m3u),
        e => { log(`Live TV playlist: ${e.message}`); res.writeHead(502).end(); });
    } else res.writeHead(404).end();
  }).listen(CONFIG.listen, '127.0.0.1');

  mirakurunEpg.run(async count => {
    log(`Mirakurun ready (${count} services)`);
    await jellyfinSetup.refreshGuide();
  }).catch(e => log(`Mirakurun first-start step failed: ${e.message}`));
  if (!/^(0|false|no)$/i.test(env.JELLYSTATION_JELLYFIN_SETUP || '')) {
    await jellyfinSetup.run(CONFIG).catch(e => log(`Jellyfin setup failed: ${e.stack || e.message}`));
  } else {
    await jellyfinSetup.loadKey(CONFIG).catch(() => {});
  }
  // EPGStation may still be starting: retry the first pass until the API answers.
  for (;;) {
    try { await api('/version'); break; } catch { await new Promise(r => setTimeout(r, 5000)); }
  }
  await sync('start');
  setInterval(() => sync('timer'), CONFIG.interval);
}

if (require.main === module) main().catch(e => { log(e.stack || e.message); process.exit(1); });
module.exports = { chooseVideo, pass, CONFIG, STATE_FILE };
