/**
 * The Live TV playlist Jellyfin's tuner reads: Mirakurun's own M3U (/api/iptv/playlist) with the channel numbers from
 * Mirakurun's XMLTV added as tvg-chno (1.1 NHK総合, 101.1 NHK BS, ...) and the channel logos Mirakurun has collected.
 * Without tvg-chno Jellyfin numbers the channels by Mirakurun's service id (3211240960, 400101), which also sorts
 * terrestrial last. The streams still come straight from Mirakurun.
 *
 * Subchannels that only simulcast another channel (MBS2 and MBS3 showing MBS's programmes) are left out: a channel
 * whose every programme is also on an earlier channel at the same time. A subchannel with a programme of its own
 * (split sports coverage) stays. JELLYSTATION_LIVETV_DUPLICATES=true keeps them all.
 */
'use strict';
const url = (process.env.JELLYSTATION_MIRAKURUN_URL || 'http://127.0.0.1:40772').replace(/\/$/, '');

async function text(p) {
  const res = await fetch(url + p, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`${p}: HTTP ${res.status}`);
  return res.text();
}

async function playlist() {
  const [m3u, xmltv, services] = await Promise.all([text('/api/iptv/playlist'), text('/api/iptv/xmltv'),
    text('/api/services').then(JSON.parse)]);
  // <channel id="3211240960"><display-name>ＮＨＫ総合１・大阪</display-name><display-name>1.1</display-name></channel>
  const numbers = new Map();
  for (const [, id, names] of xmltv.matchAll(/<channel id="(\d+)">([\s\S]*?)<\/channel>/g)) {
    const n = [...names.matchAll(/<display-name>([\d.]+)<\/display-name>/g)].pop();
    if (n) numbers.set(id, n[1]);
  }
  const logos = new Set(services.filter(s => s.hasLogoData).map(s => String(s.id)));
  const guide = new Map(); // channel id -> Set of "start title"
  for (const [, start, id, title] of xmltv.matchAll(/<programme start="(\d+)[^"]*"[^>]*channel="(\d+)">\s*<title>([^<]*)<\/title>/g)) {
    if (!guide.has(id)) guide.set(id, new Set());
    guide.get(id).add(start + ' ' + title);
  }
  const keepAll = /^(1|true|yes)$/i.test(process.env.JELLYSTATION_LIVETV_DUPLICATES || '');
  const kept = [];
  // Entries: "#KODIPROP…", "#EXTINF…", stream URL
  const [head, ...entries] = m3u.split(/^(?=#KODIPROP)/m);
  return head + entries.filter(entry => {
    const own = guide.get((entry.match(/tvg-id="(\d+)"/) || [])[1]);
    if (keepAll || !own || !own.size) return true;
    if (kept.some(other => [...own].every(p => other.has(p)))) return false;
    kept.push(own);
    return true;
  }).map(entry => entry.replace(/^#EXTINF:-1 tvg-id="(\d+)"/m, (line, id) =>
    line + (numbers.has(id) ? ` tvg-chno="${numbers.get(id)}"` : '') + (logos.has(id) ? ` tvg-logo="${url}/api/services/${id}/logo"` : ''))).join('');
}

module.exports = { playlist };
