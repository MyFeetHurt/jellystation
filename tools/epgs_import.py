#!/usr/bin/env python3
"""Copy finished recordings from one EPGStation to another (e.g. into a test JellyStation), with their programme data.

For each recorded id on the source: read its programme data, create the recording on the target (POST /api/recorded)
and upload the TS from SOURCE_DIR (POST /api/videos/upload; EPGStation stores a copy in its recorded directory and
makes the thumbnail). The source and its files are only read. Recordings the target already has (same name and start
time) are skipped.

usage: epgs_import.py SOURCE_URL SOURCE_DIR TARGET_URL ID [ID ...]
   e.g. epgs_import.py http://192.168.0.202:8888 /mnt/Media1/epgs-kodi-dev/recorded http://192.168.0.137:18888 102 129
"""
import json, os, re, subprocess, sys, tempfile, urllib.request

FIELDS = ['channelId', 'startAt', 'endAt', 'name', 'description', 'extended', 'genre1', 'subGenre1', 'genre2', 'subGenre2',
          'genre3', 'subGenre3', 'videoType', 'videoResolution', 'videoStreamContent', 'videoComponentType',
          'audioSamplingRate', 'audioComponentType']


def call(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None,
                                 method='POST' if body is not None else 'GET', headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def main():
    if len(sys.argv) < 5:
        print(__doc__); return 2
    src, src_dir, dst = sys.argv[1].rstrip('/') + '/api', sys.argv[2], sys.argv[3].rstrip('/') + '/api'
    have = {(r['name'], r['startAt']) for r in call(f'{dst}/recorded?isHalfWidth=false&limit=10000')['records']}
    for rid in sys.argv[4:]:
        rec = call(f'{src}/recorded/{rid}?isHalfWidth=false')
        ts = next((v for v in rec.get('videoFiles') or [] if v['type'] == 'ts'), None)
        path = os.path.join(src_dir, ts['filename']) if ts else None
        if (rec['name'], rec['startAt']) in have:
            print(f'{rid}: already there: {rec["name"]}'); continue
        if not path or not os.path.isfile(path):
            print(f'{rid}: no TS file ({path})'); continue
        new = call(f'{dst}/recorded', {k: rec[k] for k in FIELDS if rec.get(k) is not None})['recordedId']
        size = os.path.getsize(path) / 1e9
        print(f'{rid} -> {new}: {rec["name"]} ({size:.1f} GB) ...', flush=True)
        # curl -F can't take ';' ',' '"' in names: upload through a plainly named link, with a cleaned file name
        with tempfile.TemporaryDirectory() as tmp:
            link = os.path.join(tmp, 'video.m2ts')
            os.symlink(path, link)
            name = re.sub(r'[;,"\\]', '_', os.path.basename(path))
            subprocess.run(['curl', '-fsS', '-o', '/dev/null', '-X', 'POST', f'{dst}/videos/upload',
                            '-F', f'recordedId={new}', '-F', 'parentDirectoryName=recorded', '-F', 'viewName=TS',
                            '-F', 'fileType=ts', '-F', f'file=@{link};filename="{name}"'], check=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
