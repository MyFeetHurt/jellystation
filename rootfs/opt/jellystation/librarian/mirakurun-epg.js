/**
 * First-start EPG for Mirakurun. Mirakurun gathers EPG at :20 and :50, per network it already knows. On a first start
 * the channel scan is still finding services when the first run happens, so networks found later (often all of GR)
 * would wait up to 30 minutes for a guide. After the scan, run the EPG gatherer once if any service has no EPG yet, then call onReady (Jellyfin guide refresh).
 *
 * With local tuners, the first start also runs the channel scan itself: init leaves <state>/channel-scan with the
 * types to scan (GR, BS, CS) when it generated tuners.yml and there was no channel list.
 */
'use strict';
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const url = (process.env.JELLYSTATION_MIRAKURUN_URL || 'http://127.0.0.1:40772').replace(/\/$/, '');
const log = (...args) => console.log(new Date().toISOString(), 'mirakurun:', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => (await fetch(url + p, { signal: AbortSignal.timeout(30000) })).json();

const SCAN_FILE = path.join(process.env.JELLYSTATION_STATE_DIR || '/config/jellystation', 'channel-scan');
const CHANNELS_FILE = path.join(process.env.MIRAKURUN_CONFIG_DIR || '/config/mirakurun', 'channels.yml');
// Scans by name. CATV: terrestrial channels that cable TV passes through on cable frequencies (C13-C63). BS with
// subchannel names (BS01_0), the format recisdb understands. Pay channels (WOWOW, SKY PerfecTV e2, ...) are part of
// the BS and CS scans; whether they play depends on the B-CAS card's contract.
const SCANS = {
  GR: { type: 'GR' },
  CATV: { type: 'GR', channelNameFormat: 'C{ch}', minCh: 13, maxCh: 63 },
  BS: { type: 'BS', useSubCh: true },
  CS: { type: 'CS' },
};
// Shown when a scan starts: Mirakurun logs every frequency without a signal as a warning ("respawning because request
// has not closed"), which looks like a failure but is how a scan goes.
const SCAN_NOTES = {
  GR: 'terrestrial UHF 13-62, about 15 min',
  CATV: 'cable TV frequencies C13-C63, about 20 min; without cable TV nothing is found here',
  BS: 'about 5 min',
  CS: 'about 5 min',
};

/**
 * Scans what SCAN_FILE lists, writes channels.yml and restarts Mirakurun, then removes SCAN_FILE. Every scan is a dry
 * run: Mirakurun's scan replaces all channels of its type, so a CATV scan would drop the UHF channels of a GR scan.
 * The results are merged here instead, all enabled. A scan that fails or finds nothing runs again on the next start.
 */
async function scanChannels() {
  let scans;
  try { scans = fs.readFileSync(SCAN_FILE, 'utf8').split(/\s+/).filter(n => SCANS[n]); } catch { return; }
  for (;;) {
    try { await get('/api/version'); break; } catch { await sleep(5000); }
  }
  const channels = [];
  for (const name of scans) {
    log(`channel scan ${name} started (${SCAN_NOTES[name]}). Frequencies without a signal show up as Mirakurun ` +
      `warnings "respawning because request has not closed": that is normal during a scan`);
    const q = new URLSearchParams({ ...SCANS[name], dryRun: true, refresh: true });
    const res = await fetch(`${url}/api/config/channels/scan?${q}`, { method: 'PUT', signal: AbortSignal.timeout(3 * 3600 * 1000) });
    const text = await res.text();
    if (!res.ok || /Error during scan/.test(text)) { log(`channel scan ${name} failed: ${text.slice(-300)}`); return; }
    const found = text.split('\n').filter(l => l.startsWith('-> {')).map(l => ({ ...JSON.parse(l.slice(3)), isDisabled: false }));
    log(`channel scan ${name} done: ${found.length} channels` + (found.length ? ` (${found.map(c => c.name).slice(0, 8).join(', ')}${found.length > 8 ? ', ...' : ''})` : ''));
    channels.push(...found);
  }
  // Nothing found (no aerial or dish connected?): try again on the next start.
  if (!channels.length) { log('channel scan found no channels; it runs again on the next start'); return; }
  const yaml = require(require.resolve('js-yaml', { paths: ['/opt/mirakurun'] }));
  fs.writeFileSync(CHANNELS_FILE, yaml.dump(channels));
  fs.unlinkSync(SCAN_FILE);
  // Mirakurun reads the channel list on start only (its own restart API needs an INIT_PID it doesn't have here).
  execFileSync('/command/s6-svc', ['-r', '/run/service/mirakurun']);
  log(`${channels.length} channels written to ${CHANNELS_FILE}, Mirakurun restarted`);
  await sleep(10000);
}

/** onReady(serviceCount): called once the channel scan is done and EPG is in (or given up on). */
async function run(onReady) {
  try { await scanChannels(); } catch (e) { log('channel scan:', e.message); }
  // The scan is taken as done when there are services and their number has not changed for 2.5 minutes. (Mirakurun's
  // job list is no good signal: scan and re-check jobs can wait in "standby"/"queued" for a long time.)
  for (let stablePolls = 0, lastCount = -1; stablePolls < 5;) {
    await sleep(30000);
    let count;
    try { count = (await get('/api/services')).length; } catch { stablePolls = 0; continue; }
    stablePolls = count > 0 && count === lastCount ? stablePolls + 1 : 0;
    lastCount = count;
  }
  let services = await get('/api/services');
  const missing = services.filter(s => !s.epgReady).length;
  if (missing) {
    const res = await fetch(url + '/api/job-schedules/EPG.Gatherer/run', { method: 'PUT', signal: AbortSignal.timeout(30000) });
    log(`channel scan done, ${missing} of ${services.length} services without EPG: EPG gathering started (HTTP ${res.status})`);
    for (let i = 0; i < 40 && services.some(s => !s.epgReady); i++) { await sleep(15000); services = await get('/api/services'); }
  }
  // Jellyfin read Mirakurun's playlist when it was still empty (first start): refresh its channels and guide now.
  if (onReady) await onReady(services.length);
}

module.exports = { run };
