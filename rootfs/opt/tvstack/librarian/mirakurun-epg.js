/**
 * First-start EPG for Mirakurun. Mirakurun gathers EPG at :20 and :50, per network it already knows. On a first start
 * the channel scan is still finding services when the first run happens, so networks found later (often all of GR)
 * would wait up to 30 minutes for a guide. After the scan, run the EPG gatherer once if any service has no EPG yet, then call onReady (Jellyfin guide refresh).
 */
'use strict';
const url = (process.env.TVSTACK_MIRAKURUN_URL || 'http://127.0.0.1:40772').replace(/\/$/, '');
const log = (...args) => console.log(new Date().toISOString(), 'mirakurun:', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => (await fetch(url + p, { signal: AbortSignal.timeout(30000) })).json();

/** onReady(serviceCount): called once the channel scan is done and EPG is in (or given up on). */
async function run(onReady) {
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
