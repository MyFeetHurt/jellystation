// node --test tests/*.test.js — librarian against a fake EPGStation API and temporary directories.
'use strict';
const test = require('node:test'), assert = require('node:assert');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jellystation-test-'));
const dirs = { recorded: path.join(root, 'recorded'), encoded: path.join(root, 'encoded'), library: path.join(root, 'library'), state: path.join(root, 'state') };
Object.values(dirs).forEach(d => fs.mkdirSync(d, { recursive: true }));

let records = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = body => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/recorded') {
    const offset = +url.searchParams.get('offset'), limit = +url.searchParams.get('limit');
    return json({ records: records.slice(offset, offset + limit), total: records.length });
  }
  if (url.pathname === '/api/channels') return json([{ id: 1, name: 'ＮＨＫ総合１・大阪' }]);
  if (url.pathname.startsWith('/api/rules/')) return json({ saveOption: {} });
  if (url.pathname.startsWith('/api/thumbnails/')) { res.writeHead(200); return res.end(Buffer.from('JPEGDATA')); }
  res.writeHead(404); res.end();
});

let lib;
test.before(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    JELLYSTATION_EPGSTATION_URL: `http://127.0.0.1:${server.address().port}`, JELLYSTATION_LIBRARY: dirs.library,
    JELLYSTATION_RECORDED_DIRS: `${dirs.recorded}:${dirs.encoded}`, JELLYSTATION_STATE_DIR: dirs.state, JELLYSTATION_SUBTITLES: 'false',
  });
  lib = require('../rootfs/opt/jellystation/librarian/librarian.js');
});
test.after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

const hour = 3600e3, start = Date.UTC(2026, 9, 10, 4, 15); // 13:15 JST
function recording(id, name, genre, file, extra = {}) {
  const full = path.join(dirs.recorded, file);
  fs.writeFileSync(full, `video ${id}`);
  return { id, channelId: 1, name, description: '説明', extended: '', startAt: start + id * hour, endAt: start + id * hour + 1800e3,
    genre1: genre, subGenre1: 0, isRecording: false, isEncoding: false, thumbnails: [id],
    videoFiles: [{ id: id * 10, name: 'TS', filename: file, type: 'ts', size: fs.statSync(full).size }], ...extra };
}
const libraryFiles = () => {
  const out = [];
  const walk = d => fs.readdirSync(d, { withFileTypes: true }).forEach(e => e.isDirectory() ? walk(path.join(d, e.name)) : out.push(path.relative(dirs.library, path.join(d, e.name))));
  walk(dirs.library);
  return out.sort();
};

test('places TV episodes and movies as hardlinks with NFO and thumbnail', async () => {
  records = [recording(1, 'TOKYO MER～走る緊急救命室～ #2[字]', 3, 'mer.m2ts'), recording(2, 'ローマの休日(1953)[字]', 6, 'roma.m2ts')];
  await lib.pass('test');
  const files = libraryFiles();
  assert.ok(files.includes('TV/TOKYO MER~走る緊急救命室~/tvshow.nfo'), files.join('\n'));
  const ep = files.find(f => f.startsWith('TV/') && f.endsWith('.m2ts'));
  assert.match(ep, /TOKYO MER~走る緊急救命室~ - 2026-10-10 1415\.m2ts$/);
  assert.ok(files.includes(ep.replace('.m2ts', '-thumb.jpg')));
  assert.ok(files.includes('Movies/ローマの休日 (1953)/ローマの休日 (1953).m2ts'), files.join('\n'));
  assert.strictEqual(fs.statSync(path.join(dirs.library, ep)).ino, fs.statSync(path.join(dirs.recorded, 'mer.m2ts')).ino);
  assert.match(fs.readFileSync(path.join(dirs.library, ep.replace('.m2ts', '.nfo')), 'utf8'), /<episode>2<\/episode>/);
});

test('a second pass changes nothing', async () => {
  const before = libraryFiles();
  await lib.pass('test');
  assert.deepStrictEqual(libraryFiles(), before);
});

test('an encoded file replaces the TS in the library', async () => {
  const enc = path.join(dirs.encoded, 'mer.mp4');
  fs.writeFileSync(enc, 'encoded video');
  records[0].videoFiles.push({ id: 11, name: 'H.264', filename: 'mer.mp4', type: 'encoded', size: fs.statSync(enc).size });
  await lib.pass('test');
  const files = libraryFiles().filter(f => f.startsWith('TV/'));
  assert.ok(files.some(f => f.endsWith('1415.mp4')), files.join('\n'));
  assert.ok(!files.some(f => f.endsWith('.m2ts')), files.join('\n'));
});

test('a recording deleted in EPGStation leaves the library; the folder goes when empty', async () => {
  records = records.filter(r => r.id !== 2);
  await lib.pass('test');
  assert.ok(!fs.existsSync(path.join(dirs.library, 'Movies', 'ローマの休日 (1953)')));
  assert.ok(fs.existsSync(path.join(dirs.recorded, 'roma.m2ts')), 'the recording itself is never touched');
});

test('refuses to remove most of the library at once', async () => {
  records = [3, 4, 5, 6, 7, 8, 9].map(id => recording(id, `番組${id} #1`, 5, `p${id}.m2ts`));
  await lib.pass('test');
  const count = libraryFiles().filter(f => /\.(m2ts|mp4)$/.test(f)).length;
  records = [];
  await lib.pass('test');
  assert.strictEqual(libraryFiles().filter(f => /\.(m2ts|mp4)$/.test(f)).length, count);
});

test('skips recordings in progress and recordings without a thumbnail yet', async () => {
  const now = Date.now();
  records = [recording(20, 'ニュース[字]', 0, 'n.m2ts', { isRecording: true }),
    recording(21, '天気予報', 0, 'w.m2ts', { thumbnails: [], startAt: now - 600e3, endAt: now - 10e3 })];
  const before = libraryFiles().length;
  process.env.JELLYSTATION_ALLOW_MASS_DELETE = '';
  await lib.pass('test');
  assert.ok(!libraryFiles().some(f => /ニュース|天気予報/.test(f)));
  assert.ok(libraryFiles().length <= before);
});

test('ARIB captions: ASS rows of one caption become one SRT cue, top to bottom', () => {
  const { assToSrt } = require('../rootfs/opt/jellystation/librarian/epgmeta.js');
  const ass = [
    '[Events]',
    'Dialogue: 0,0:00:01.13,0:00:03.30,Default,,0,0,0,,{\\an7}{\\pos(170,329)}{\\fsp4}人のプライベートに踏み込んで',
    'Dialogue: 0,0:00:01.13,0:00:03.30,Default,,0,0,0,,{\\an7}{\\pos(170,269)}{\\fsp4}いきなり',
    'Dialogue: 0,0:00:03.30,0:00:07.81,Default,,0,0,0,,{\\pos(210,299)}{\\1c&Hffff00&}去年, 中南米から',
    'Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,{\\pos(1,1)}',
  ].join('\n');
  assert.strictEqual(assToSrt(ass),
    '1\n00:00:01,130 --> 00:00:03,300\nいきなり\n人のプライベートに踏み込んで\n\n2\n00:00:03,300 --> 00:00:07,810\n去年, 中南米から\n');
});
