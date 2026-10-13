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

/** Scans the types listed in SCAN_FILE, one after the other, then removes the file. A failed scan is retried next start. */
async function scanChannels() {
  let types;
  try { types = fs.readFileSync(SCAN_FILE, 'utf8').split(/\s+/).filter(Boolean); } catch { return; }
  for (;;) {
    try { await get('/api/version'); break; } catch { await sleep(5000); }
  }
  let configured = 0;
  for (const type of types) {
    log(`channel scan ${type} started`);
    const res = await fetch(`${url}/api/config/channels/scan?type=${type}&setDisabledOnAdd=false`,
      { method: 'PUT', signal: AbortSignal.timeout(3 * 3600 * 1000) });
    const text = await res.text();
    const found = (text.match(/total \d+\/\d+ .*channels configured/) || ['no summary'])[0];
    if (!res.ok || /Error during scan/.test(text)) { log(`channel scan ${type} failed: ${text.slice(-300)}`); return; }
    log(`channel scan ${type} done: ${found}`);
    configured += Number((found.match(/total (\d+)/) || [0, 0])[1]);
  }
  // Nothing found (no aerial or dish connected?): try again on the next start.
  if (!configured) { log('channel scan found no channels; it runs again on the next start'); return; }
  fs.unlinkSync(SCAN_FILE);
  // Mirakurun reads the new channel list on start only (its own restart API needs an INIT_PID it doesn't have here).
  execFileSync('/command/s6-svc', ['-r', '/run/service/mirakurun']);
  log('Mirakurun restarted with the new channel list');
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
