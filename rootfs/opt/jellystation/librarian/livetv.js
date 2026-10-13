/**
 * The Live TV playlist Jellyfin's tuner reads: Mirakurun's own M3U (/api/iptv/playlist) with the channel numbers from
 * Mirakurun's XMLTV added as tvg-chno (1.1 NHK総合, 101.1 NHK BS, ...) and the channel logos Mirakurun has collected.
 * Without tvg-chno Jellyfin numbers the channels by Mirakurun's service id (3211240960, 400101), which also sorts
 * terrestrial last. The streams still come straight from Mirakurun.
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
  return m3u.replace(/^#EXTINF:-1 tvg-id="(\d+)"/gm, (line, id) =>
    line + (numbers.has(id) ? ` tvg-chno="${numbers.get(id)}"` : '') + (logos.has(id) ? ` tvg-logo="${url}/api/services/${id}/logo"` : ''));
}

module.exports = { playlist };
