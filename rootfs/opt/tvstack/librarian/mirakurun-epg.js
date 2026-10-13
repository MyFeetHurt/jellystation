/**
 * First-start EPG for Mirakurun. Mirakurun gathers EPG at :20 and :50, per network it already knows. On a first start
 * the channel scan is still finding services when the first run happens, so networks found later (often all of GR)
 * would wait up to 30 minutes for a guide. After the scan, run the EPG gatherer once if any service has no EPG yet.
 */
'use strict';
const url = (process.env.TVSTACK_MIRAKURUN_URL || 'http://127.0.0.1:40772').replace(/\/$/, '');
const log = (...args) => console.log(new Date().toISOString(), 'mirakurun:', ...args);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => (await fetch(url + p, { signal: AbortSignal.timeout(30000) })).json();

async function run() {
  for (let quietPolls = 0; quietPolls < 3;) { // the scan queues jobs in waves: want three quiet polls in a row
    await sleep(30000);
    let jobs;
    try { jobs = await get('/api/jobs'); } catch { quietPolls = 0; continue; }
    const scanning = jobs.some(j => /^Service\./.test(j.key) && !['finished', 'aborted'].includes(j.status));
    quietPolls = scanning ? 0 : quietPolls + 1;
  }
  const services = await get('/api/services');
  const missing = services.filter(s => !s.epgReady).length;
  if (!missing) return;
  const res = await fetch(url + '/api/job-schedules/EPG.Gatherer/run', { method: 'PUT', signal: AbortSignal.timeout(30000) });
  log(`channel scan done, ${missing} of ${services.length} services without EPG: EPG gathering started (HTTP ${res.status})`);
}

module.exports = { run };
