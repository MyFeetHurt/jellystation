/**
 * Jellyfin first-time setup and library refresh, through Jellyfin's HTTP API. Every step checks first, so it is safe
 * to run on every start; settings the user changed in Jellyfin afterwards are left alone.
 *
 *   - startup wizard: language, admin user (JELLYSTATION_JELLYFIN_USER / JELLYSTATION_JELLYFIN_PASSWORD; a random password is
 *     generated and written to <state>/jellyfin-admin.txt when none is given);
 *   - an API key "jellystation" for the librarian (stored in <state>/jellyfin.key);
 *   - server name JellyStation (JELLYSTATION_SERVER_NAME) instead of the container's hostname;
 *   - libraries "TV" (tvshows, NFO only: EPG titles match the wrong online shows) and "Movies" (NFO + online metadata),
 *     named テレビ番組 and 映画 when the language is Japanese;
 *   - Live TV: Mirakurun's M3U playlist as tuner and its XMLTV as guide, with the ARIB genres mapped to Jellyfin's
 *     movie/sports/news/kids categories;
 *   - the EPGStation plugin (copied in by bin/init): pointed at the EPGStation in this container while its URL is
 *     empty, and its plugin repository added once so Jellyfin keeps it updated.
 */
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');

const env = process.env;
const AUTH = 'MediaBrowser Client="jellystation", Device="jellystation", DeviceId="jellystation-librarian", Version="1.0"';
let base = 'http://127.0.0.1:8096', apiKey = null, keyFile = null;

const log = (...args) => console.log(new Date().toISOString(), 'jellyfin:', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(method, p, body, token = apiKey) {
  const res = await fetch(base + p, {
    method, signal: AbortSignal.timeout(60000),
    headers: { Authorization: AUTH + (token ? `, Token="${token}"` : ''), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p}: HTTP ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** Mirakurun's XMLTV categories ("大分類 - 小分類") for Jellyfin's programme types. */
const sub = (lv1, names) => names.split('|').map(n => `${lv1} - ${n}`);
const CATEGORIES = {
  MovieCategories: sub('映画', '洋画|邦画|アニメ|その他'),
  SportsCategories: sub('スポーツ', 'スポーツニュース|野球|サッカー|ゴルフ|その他の球技|相撲・格闘技|オリンピック・国際大会|マラソン・陸上・水泳|モータースポーツ|マリン・ウィンタースポーツ|競馬・公営競技|その他'),
  NewsCategories: sub('ニュース／報道', '定時・総合|天気|特集・ドキュメント|政治・国会|経済・市況|海外・国際|解説|討論・会談|報道特番|ローカル・地域|交通|その他'),
  KidsCategories: sub('アニメ／特撮', '国内アニメ|海外アニメ|特撮|その他'),
};

async function waitUp() {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(base + '/System/Info/Public', { signal: AbortSignal.timeout(5000) });
      // While Jellyfin 12 migrates its database at start, a setup server answers without Version and
      // StartupWizardCompleted: wait for the real server, or the wizard would be run on a set-up Jellyfin.
      const info = res.ok ? await res.json() : null;
      if (info?.Version) return info;
    } catch { /* starting */ }
    if (i % 12 === 0) log('waiting for Jellyfin...');
    await sleep(5000);
  }
}

async function wizard(stateDir, user, info) {
  let password = env.JELLYSTATION_JELLYFIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(12).toString('base64url');
    fs.writeFileSync(path.join(stateDir, 'jellyfin-admin.txt'), `user: ${user}\npassword: ${password}\n`, { mode: 0o600 });
  }
  const lang = env.JELLYSTATION_LANGUAGE || 'ja';
  // The wizard endpoints answer 503 for a moment after Jellyfin reports ready.
  for (let i = 0; ; i++) {
    try { await call('POST', '/Startup/Configuration', { UICulture: lang, MetadataCountryCode: 'JP', PreferredMetadataLanguage: lang }, null); break; } catch (e) {
      if (i > 30) throw e;
      await sleep(3000);
    }
  }
  await call('GET', '/Startup/User', undefined, null);
  await call('POST', '/Startup/User', { Name: user, Password: password }, null);
  await call('POST', '/Startup/Complete', undefined, null);
  log(`setup wizard done (Jellyfin ${info.Version}), admin user "${user}"` + (env.JELLYSTATION_JELLYFIN_PASSWORD ? '' : `, password in ${stateDir}/jellyfin-admin.txt`));
  return password;
}

async function ensureKey(stateDir, user, password) {
  // The stored key still works: done.
  if (apiKey) { try { await call('GET', '/System/Info'); return; } catch { apiKey = null; } }
  if (!password) throw new Error(`no working API key in ${keyFile} and no JELLYSTATION_JELLYFIN_PASSWORD to create one`);
  const auth = await call('POST', '/Users/AuthenticateByName', { Username: user, Pw: password }, null);
  const token = auth.AccessToken;
  let key = (await call('GET', '/Auth/Keys', undefined, token)).Items.find(k => k.AppName === 'jellystation');
  if (!key) {
    await call('POST', '/Auth/Keys?app=jellystation', undefined, token);
    key = (await call('GET', '/Auth/Keys', undefined, token)).Items.find(k => k.AppName === 'jellystation');
  }
  apiKey = key.AccessToken;
  fs.writeFileSync(keyFile, apiKey + '\n', { mode: 0o600 });
  log('API key "jellystation" stored');
}

async function ensureLibraries(cfg) {
  const folders = await call('GET', '/Library/VirtualFolders');
  const has = dir => folders.some(f => (f.Locations || []).some(l => path.resolve(l) === path.resolve(dir)));
  const lang = env.JELLYSTATION_LANGUAGE || 'ja';
  const common = { PreferredMetadataLanguage: lang, MetadataCountryCode: 'JP', EnableRealtimeMonitor: true, SaveLocalMetadata: false,
    LocalMetadataReaderOrder: ['Nfo'], EnableEmbeddedTitles: false, EnableChapterImageExtraction: false };
  const nfoOnly = type => ({ Type: type, MetadataFetchers: [], MetadataFetcherOrder: [], ImageFetchers: [], ImageFetcherOrder: [] });
  const tvOnline = /^(1|true|yes)$/i.test(env.JELLYSTATION_TV_ONLINE_METADATA || '');
  const ja = lang.startsWith('ja');
  const libs = [
    { name: env.JELLYSTATION_TV_LIBRARY_NAME || (ja ? 'テレビ番組' : 'TV'), type: 'tvshows', dir: path.join(cfg.library, cfg.tvDir),
      options: { ...common, TypeOptions: tvOnline ? [] : ['Series', 'Season', 'Episode'].map(nfoOnly) } },
    { name: env.JELLYSTATION_MOVIE_LIBRARY_NAME || (ja ? '映画' : 'Movies'), type: 'movies', dir: path.join(cfg.library, cfg.movieDir), options: common },
  ];
  for (const lib of libs) {
    if (has(lib.dir)) continue;
    const q = new URLSearchParams({ name: lib.name, collectionType: lib.type, refreshLibrary: 'true' });
    await call('POST', `/Library/VirtualFolders?${q}`, { LibraryOptions: { ...lib.options, PathInfos: [{ Path: lib.dir }] } });
    log(`library "${lib.name}" (${lib.type}) -> ${lib.dir}`);
  }
}

/** A server name instead of the container's hostname (only when none is set). */
async function ensureServerName() {
  const conf = await call('GET', '/System/Configuration');
  if (conf.ServerName) return;
  conf.ServerName = env.JELLYSTATION_SERVER_NAME || 'JellyStation';
  await call('POST', '/System/Configuration', conf);
  log(`server name "${conf.ServerName}"`);
}

async function ensureLiveTv() {
  if (/^(0|false|no)$/i.test(env.JELLYSTATION_LIVETV || '')) return;
  const mirakurun = (env.JELLYSTATION_MIRAKURUN_URL || 'http://127.0.0.1:40772').replace(/\/$/, '');
  // The librarian's copy of Mirakurun's playlist, with channel numbers and logos (livetv.js).
  const playlist = `http://127.0.0.1:${env.JELLYSTATION_LIBRARIAN_PORT || 40780}/livetv.m3u`;
  const conf = await call('GET', '/System/Configuration/livetv');
  const hosts = conf.TunerHosts || [];
  const old = hosts.find(t => t.Url === `${mirakurun}/api/iptv/playlist`); // set up by an earlier version
  if (old) {
    await call('POST', '/LiveTv/TunerHosts', { ...old, Url: playlist });
    log('Live TV tuner: now with channel numbers');
  } else if (!hosts.some(t => t.Url === playlist || (t.Url || '').startsWith(mirakurun))) {
    let tuners = 0;
    try { tuners = (await (await fetch(mirakurun + '/api/tuners')).json()).length; } catch { /* Mirakurun still starting */ }
    await call('POST', '/LiveTv/TunerHosts', { Type: 'm3u', Url: playlist, FriendlyName: 'Mirakurun',
      TunerCount: tuners, ImportFavoritesOnly: false, AllowHWTranscoding: true, EnableStreamLooping: false, AllowStreamSharing: true,
      IgnoreDts: true, ReadAtNativeFramerate: false });
    log(`Live TV tuner: Mirakurun (${tuners} tuners)`);
  }
  if (!(conf.ListingProviders || []).some(p => (p.Path || '').startsWith(mirakurun))) {
    await call('POST', '/LiveTv/ListingProviders?validateListings=false&validateLogin=false', {
      Type: 'xmltv', Path: `${mirakurun}/api/iptv/xmltv`, EnableAllTuners: true, ...CATEGORIES });
    log('Live TV guide: Mirakurun XMLTV');
  }
}

const PLUGIN_ID = '509fa560d8d947619d700151f18660cf';
const PLUGIN_REPO = { Name: 'EPGStation', Url: 'https://raw.githubusercontent.com/MyFeetHurt/jellyfin-plugin-epgstation/main/manifest.json', Enabled: true };

async function ensureEpgStationPlugin(stateDir) {
  if (/^(0|false|no)$/i.test(env.JELLYSTATION_EPGSTATION_PLUGIN || '')) return;
  const plugin = (await call('GET', '/Plugins')).find(p => p.Id.replace(/-/g, '') === PLUGIN_ID);
  if (!plugin) return; // not installed, or uninstalled by the user
  const conf = await call('GET', `/Plugins/${PLUGIN_ID}/Configuration`);
  if (!conf.EpgStationUrl) {
    conf.EpgStationUrl = 'http://127.0.0.1:8888';
    await call('POST', `/Plugins/${PLUGIN_ID}/Configuration`, conf);
    log(`EPGStation plugin ${plugin.Version}: EPGStation ${conf.EpgStationUrl}`);
  }
  const marker = path.join(stateDir, 'epgstation-plugin-repo');
  if (!fs.existsSync(marker)) {
    const repos = await call('GET', '/Repositories');
    if (!repos.some(r => r.Url === PLUGIN_REPO.Url)) {
      await call('POST', '/Repositories', [...repos, PLUGIN_REPO]);
      log('plugin repository: EPGStation');
    }
    fs.writeFileSync(marker, PLUGIN_REPO.Url + '\n');
  }
}

async function loadKey(cfg) {
  base = cfg.jellyfin;
  keyFile = path.join(cfg.stateDir, 'jellyfin.key');
  try { apiKey = fs.readFileSync(keyFile, 'utf8').trim() || null; } catch { apiKey = null; }
}

async function run(cfg) {
  await loadKey(cfg);
  const user = env.JELLYSTATION_JELLYFIN_USER || 'admin';
  const info = await waitUp();
  let password = env.JELLYSTATION_JELLYFIN_PASSWORD;
  if (!info.StartupWizardCompleted) password = await wizard(cfg.stateDir, user, info);
  await ensureKey(cfg.stateDir, user, password);
  await ensureServerName();
  await ensureLibraries(cfg);
  await ensureLiveTv();
  await ensureEpgStationPlugin(cfg.stateDir);
}

async function refreshLibrary() {
  if (!apiKey) return;
  await call('POST', '/Library/Refresh');
}

/**
 * Jellyfin keeps a downloaded XMLTV file for an hour, and a guide refresh within that hour reads the old copy. On a
 * first start that copy is the empty guide from before the channel scan, so the refreshes after the scan changed
 * nothing and the guide stayed empty for up to an hour. Remove the cached copies, so the refresh downloads the guide.
 */
function dropCachedGuide() {
  const dir = path.join(env.JELLYSTATION_JELLYFIN_CACHE || '/cache', 'xmltv');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.xml')); } catch { /* nothing cached yet */ }
  for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
}

/** Run Jellyfin's "Refresh Guide" task: re-reads the tuner playlist (channels) and the XMLTV guide. */
async function refreshGuide() {
  if (!apiKey || /^(0|false|no)$/i.test(env.JELLYSTATION_LIVETV || '')) return;
  const task = (await call('GET', '/ScheduledTasks')).find(t => t.Key === 'RefreshGuide');
  if (!task) return;
  dropCachedGuide();
  await call('POST', `/ScheduledTasks/Running/${task.Id}`);
  log('Live TV guide refresh started');
}

module.exports = { run, loadKey, refreshLibrary, refreshGuide, CATEGORIES };
