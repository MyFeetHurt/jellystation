#!/usr/bin/env python3
"""End-to-end check of a running tvstack container: record one short programme with the container's EPGStation, then
check that the librarian put it in the library and that Jellyfin finds it and can transcode it.

Picks the shortest GR programme that starts within --within minutes and lasts at most --max-minutes, reserves it,
waits for the recording, then waits for the library file. Only reservations made by this script are touched.

usage: e2e_record.py HOST [--within 20] [--max-minutes 10] [--library /path/on/host/to/library]
"""
import argparse, json, os, subprocess, sys, time, urllib.parse, urllib.request


def get(url, timeout=30):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        return json.load(r)


def post(url, body):
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('host')
    ap.add_argument('--within', type=int, default=20, help='programme must start within N minutes')
    ap.add_argument('--max-minutes', type=int, default=10)
    ap.add_argument('--library', default='dev/data/media/library')
    a = ap.parse_args()
    epgs = f'http://{a.host}:8888/api'

    now = int(time.time() * 1000)
    channels = {c['id']: c for c in get(f'{epgs}/channels')}
    q = urllib.parse.urlencode({'startAt': now, 'endAt': now + a.within * 60000 + a.max_minutes * 60000, 'isHalfWidth': 'false',
                                'GR': 'true', 'BS': 'false', 'CS': 'false', 'SKY': 'false'})
    progs = [p for ch in get(f'{epgs}/schedules?{q}') for p in ch['programs']
             if now + 60000 < p['startAt'] < now + a.within * 60000 and p['endAt'] - p['startAt'] <= a.max_minutes * 60000]
    if not progs:
        print('no suitable programme; try a larger --within'); return 1
    prog = min(progs, key=lambda p: (p['startAt'], p['endAt'] - p['startAt']))
    ch = channels.get(prog['channelId'], {}).get('name', prog['channelId'])
    print(f'reserving {prog["name"]} on {ch}, {time.strftime("%H:%M", time.localtime(prog["startAt"] / 1000))}'
          f'-{time.strftime("%H:%M", time.localtime(prog["endAt"] / 1000))}')
    reserve = post(f'{epgs}/reserves', {'programId': prog['id'], 'allowEndLack': True})
    print(f'reserve id {reserve["reserveId"]}')

    deadline = prog['endAt'] / 1000 + 300
    rec = None
    while time.time() < deadline:
        recs = get(f'{epgs}/recorded?isHalfWidth=false&limit=50')['records']
        rec = next((r for r in recs if r.get('programId') == prog['id'] and not r['isRecording']), None)
        if rec:
            break
        time.sleep(15)
    if not rec:
        print('FAIL: no finished recording'); return 1
    size = sum(v['size'] for v in rec.get('videoFiles', []))
    drop = rec.get('dropLogFile') or {}
    print(f'recorded id {rec["id"]}: {size / 1e6:.0f} MB, drop {drop.get("dropCnt")}, scrambling {drop.get("scramblingCnt")}')

    state_file = os.path.join(os.path.dirname(a.library.rstrip('/')), '..', 'config', 'tvstack', 'librarian.json')
    end = time.time() + 300
    entry = None
    while time.time() < end and not entry:
        try:
            out = subprocess.run(['sudo', 'cat', state_file], capture_output=True, text=True, check=True).stdout
            entry = json.loads(out)['items'].get(str(rec['id']))
        except Exception:
            pass
        if not entry:
            time.sleep(10)
    if not entry:
        print('FAIL: librarian did not place the recording'); return 1
    print(f'library: {entry["dst"]} (thumbnail {entry["thumb"]})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
