#!/usr/bin/env python3
"""Playback smoke test for a Jellyfin server: finish the setup wizard if needed, make sure a library exists,
then ask for every video's PlaybackInfo with a browser-like profile (H.264/AAC in HLS) and fetch the first
HLS segment. Exit code 1 when any item fails.

usage: jf_playtest.py BASE_URL [--user U --password P] [--library NAME:TYPE:PATH ...]
"""
import argparse, json, sys, time, urllib.error, urllib.parse, urllib.request

AUTH = 'MediaBrowser Client="tvstack-test", Device="cli", DeviceId="tvstack-playtest", Version="1.0"'

# A web browser without MPEG-2 or AC-3: everything Japanese broadcast TS carries must be transcoded.
PROFILE = {
    "MaxStreamingBitrate": 20000000,
    "DirectPlayProfiles": [{"Container": "mp4", "Type": "Video", "VideoCodec": "h264", "AudioCodec": "aac"}],
    "TranscodingProfiles": [{"Container": "ts", "Type": "Video", "VideoCodec": "h264", "AudioCodec": "aac",
                             "Protocol": "hls", "Context": "Streaming", "MaxAudioChannels": "2", "BreakOnNonKeyFrames": True}],
    "CodecProfiles": [], "SubtitleProfiles": [{"Format": "vtt", "Method": "External"}],
}


class Jf:
    def __init__(self, base):
        self.base, self.token = base.rstrip('/'), None

    def call(self, method, path, body=None, raw=False, timeout=60):
        hdr = AUTH + (f', Token="{self.token}"' if self.token else '')
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method,
                                     headers={'Authorization': hdr, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read()
        if raw:
            return payload
        return json.loads(payload) if payload else None


def wait_up(jf, seconds=180):
    end = time.time() + seconds
    while time.time() < end:
        try:
            jf.call('GET', '/System/Info/Public')
            return
        except Exception:
            time.sleep(2)
    raise SystemExit(f'{jf.base} did not answer within {seconds} s')


def setup(jf, user, password):
    info = jf.call('GET', '/System/Info/Public')
    if not info.get('StartupWizardCompleted'):
        jf.call('POST', '/Startup/Configuration', {"UICulture": "ja", "MetadataCountryCode": "JP", "PreferredMetadataLanguage": "ja"})
        jf.call('GET', '/Startup/User')
        jf.call('POST', '/Startup/User', {"Name": user, "Password": password})
        jf.call('POST', '/Startup/Complete')
    auth = jf.call('POST', '/Users/AuthenticateByName', {"Username": user, "Pw": password})
    jf.token = auth['AccessToken']
    return auth['User']['Id'], info.get('Version')


def ensure_library(jf, name, ctype, path):
    if any(f['Name'] == name for f in jf.call('GET', '/Library/VirtualFolders')):
        return False
    q = urllib.parse.urlencode({'name': name, 'collectionType': ctype, 'paths': path, 'refreshLibrary': 'true'})
    jf.call('POST', f'/Library/VirtualFolders?{q}', {"LibraryOptions": {"PathInfos": [{"Path": path}]}})
    return True


def videos(jf, user_id):
    q = urllib.parse.urlencode({'Recursive': 'true', 'IncludeItemTypes': 'Episode,Movie,Video', 'userId': user_id})
    return jf.call('GET', f'/Items?{q}')['Items']


def play(jf, user_id, item):
    info = jf.call('POST', f'/Items/{item["Id"]}/PlaybackInfo?userId={user_id}',
                   {"DeviceProfile": PROFILE, "UserId": user_id, "MaxStreamingBitrate": 20000000, "AutoOpenLiveStream": True})
    if info.get('ErrorCode'):
        return f'PlaybackInfo error {info["ErrorCode"]}'
    src = info['MediaSources'][0]
    streams = ', '.join(f'{s["Type"]}:{s.get("Codec")}' + ('(external ' + str(s.get('Language')) + ')' if s.get('IsExternal') else '')
                        for s in src.get('MediaStreams', []))
    url = src.get('TranscodingUrl')
    if not url:
        return f'no TranscodingUrl (direct={src.get("SupportsDirectPlay")}) [{streams}]'
    master = jf.call('GET', url, raw=True).decode()
    variant = next(l for l in master.splitlines() if l and not l.startswith('#'))
    base = url.split('?')[0].rsplit('/', 1)[0]
    vurl = variant if variant.startswith('/') else f'{base}/{variant}'
    playlist = jf.call('GET', vurl, raw=True).decode()
    seg = next(l for l in playlist.splitlines() if l and not l.startswith('#'))
    surl = seg if seg.startswith('/') else f'{vurl.split("?")[0].rsplit("/", 1)[0]}/{seg}'
    data = jf.call('GET', surl, raw=True, timeout=120)
    jf.call('DELETE', f'/Videos/ActiveEncodings?deviceId=tvstack-playtest&playSessionId={info["PlaySessionId"]}')
    reasons = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get('TranscodeReasons', ['?'])[0]
    return f'OK segment {len(data)} bytes, reasons={reasons} [{streams}]' if len(data) > 1000 else f'segment too small ({len(data)} B)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('base')
    ap.add_argument('--user', default='admin')
    ap.add_argument('--password', default='tvstack-dev')
    ap.add_argument('--library', action='append', default=[], help='NAME:TYPE:PATH, e.g. TV:tvshows:/media/TV')
    ap.add_argument('--wait', type=int, default=120, help='seconds to wait for the scan to find videos')
    a = ap.parse_args()
    jf = Jf(a.base)
    wait_up(jf)
    user_id, version = setup(jf, a.user, a.password)
    print(f'Jellyfin {version} at {a.base}')
    for spec in a.library:
        name, ctype, path = spec.split(':', 2)
        if ensure_library(jf, name, ctype, path):
            print(f'created library {name} ({ctype}) -> {path}')
    end = time.time() + a.wait
    while not (items := videos(jf, user_id)) and time.time() < end:
        time.sleep(3)
    if not items:
        print('no videos found'); return 1
    failed = 0
    for item in items:
        try:
            result = play(jf, user_id, item)
        except urllib.error.HTTPError as e:
            result = f'HTTP {e.code} {e.read()[:200]!r}'
        except Exception as e:
            result = f'{type(e).__name__}: {e}'
        ok = result.startswith('OK')
        failed += not ok
        print(f'{"PASS" if ok else "FAIL"} {item["Type"]} {item["Name"]}: {result}')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main())
