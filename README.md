# tvstack

Japanese TV in Jellyfin from one container: **Mirakurun** (tuners), **EPGStation** (recording) and **Jellyfin**
(library and Live TV), supervised by s6-overlay.

- Finished EPGStation recordings show up in Jellyfin's **TV** and **Movies** libraries, with titles, episode numbers,
  plots, cast, genres and thumbnails taken from the EPG (NFO files). They are hardlinks, so they don't use extra disk.
- When EPGStation finishes an encode, the encoded file replaces the TS in the library. When you delete a recording in
  EPGStation, it leaves the library too.
- Jellyfin **Live TV** uses Mirakurun's channels and its EPG (XMLTV) is the programme guide. Movies, sports, news
  and kids programmes are tagged from the ARIB genres.
- ARIB captions become subtitle files next to each recording (`.ja.srt`, optionally `.ja.ass`), so every Jellyfin
  client can show them.
- Includes a fix for Jellyfin 12, which otherwise can't play Japanese broadcast TS (see [Notes](#notes)).

| Port  | Service    |
|-------|------------|
| 8096  | Jellyfin   |
| 8888  | EPGStation |
| 40772 | Mirakurun  |

## Quick start

```yaml
services:
  tvstack:
    image: tvstack:latest
    container_name: tvstack
    restart: unless-stopped
    cap_add:
      - SYS_NICE # Mirakurun raises its own priority
    environment:
      TVSTACK_JELLYFIN_PASSWORD: change-me
    devices:
      - /dev/pt3video0:/dev/pt3video0 # your tuner devices
      - /dev/pt3video1:/dev/pt3video1
      - /dev/pt3video2:/dev/pt3video2
      - /dev/pt3video3:/dev/pt3video3
      - /dev/bus/usb:/dev/bus/usb # B-CAS card reader (pcscd)
      # - /dev/dri:/dev/dri       # Intel/AMD hardware transcoding for Jellyfin
    ports:
      - "8096:8096"
      - "8888:8888"
      - "40772:40772"
    volumes:
      - ./config:/config
      - ./cache:/cache
      - /srv/tv:/media # recordings and the Jellyfin library: keep them on one filesystem (hardlinks)
```

1. Start it once, then enable your tuners in `config/mirakurun/tuners.yml` (PT3 and PX4 examples are in the file) and
   restart the container.
2. Scan channels (or edit `config/mirakurun/channels.yml`):
   `curl -X PUT "http://<host>:40772/api/config/channels/scan?type=GR&setDisabledOnAdd=false"` (also `type=BS`, `type=CS`).
3. Open EPGStation at `http://<host>:8888` and add reservations or rules.
4. Open Jellyfin at `http://<host>:8096` and log in as `admin` with `TVSTACK_JELLYFIN_PASSWORD`. The libraries
   and Live TV are already set up.

## Layout

```
/config/mirakurun/    server.yml, tuners.yml, channels.yml, data/
/config/epgstation/   config/config.yml, data/ (SQLite), thumbnail/, logs/
/config/jellyfin/     Jellyfin data, config and logs
/config/tvstack/      librarian state, Jellyfin API key (and generated admin password)
/cache/               Jellyfin cache and transcodes
/media/recorded/      EPGStation recordings (TS)
/media/encoded/       EPGStation encodes
/media/library/TV/    TV/<Show>/<Show> - 2026-10-10 1315 - <subtitle>.m2ts + .nfo + -thumb.jpg + .ja.srt, tvshow.nfo
/media/library/Movies/  Movies/<Title> (<Year>)/<Title> (<Year>).m2ts + .nfo
```

Config files are only written when they don't exist, so your changes are kept.

## Settings

| Variable | Default | |
|---|---|---|
| `TZ` | `Asia/Tokyo` | time zone (EPGStation file names, guide) |
| `TVSTACK_JELLYFIN_USER` / `TVSTACK_JELLYFIN_PASSWORD` | `admin` / random | Jellyfin admin created on first start; a random password is written to `/config/tvstack/jellyfin-admin.txt` |
| `TVSTACK_LANGUAGE` | `ja` | Jellyfin UI and metadata language |
| `TVSTACK_JELLYFIN_SETUP` | `true` | `false`: don't touch Jellyfin's setup (the library refresh still needs `/config/tvstack/jellyfin.key`) |
| `TVSTACK_LIVETV` | `true` | add Mirakurun as Jellyfin Live TV tuner and guide |
| `TVSTACK_TV_ONLINE_METADATA` | `false` | `true`: let Jellyfin look up TV shows online (EPG titles often match the wrong show) |
| `TVSTACK_SUBTITLES` | `srt` | ARIB captions as sidecar files: `srt` (plain text, any client), `ass` (keeps position and colour; Jellyfin's web player needs a Japanese fallback font for it), `both`, or `false` |
| `TVSTACK_PREFER` | `encoded` | which file goes into the library: `encoded` (when there is one) or `ts` |
| `TVSTACK_SYNC_INTERVAL` | `600` | seconds between library checks (EPGStation also triggers one when a recording or encode ends) |
| `TVSTACK_ALLOW_MASS_DELETE` | `false` | the librarian refuses to remove more than half of the library in one pass (e.g. after an EPGStation database reset) unless this is `true` |
| `TVSTACK_REMOTE_MIRAKURUN` | | `host:port` of another Mirakurun that has the tuners (and the B-CAS card). On first start the container's Mirakurun gets remote tuners that let that server descramble, and copies its channel list; EPGStation is configured to use that Mirakurun directly (see Notes) |
| `TVSTACK_REMOTE_TUNERS` | `2` | number of remote tuner slots |
| `TVSTACK_EPGSTATION_REC_PRIORITY` / `TVSTACK_EPGSTATION_CONFLICT_PRIORITY` | EPGStation's (2 / 1) | tuner priorities for a new `config.yml`, e.g. lower them when sharing a tuner server with another EPGStation |
| `TVSTACK_PCSCD` | `auto` | start pcscd when `/dev/bus/usb` is passed in; `false` to disable |

Mirakurun's own Docker variables (`LOG_LEVEL`, `EPG_GATHERING_JOB_SCHEDULE`, `LOGO_DATA_INTERVAL`, ...) work as usual.

## Build

```sh
docker build -t tvstack .
# versions: --build-arg JELLYFIN_VERSION=12.2 EPGSTATION_VERSION=v2.10.0 MIRAKURUN_VERSION=4.1.5 RECISDB_VERSION=1.3.0
```

## Notes

- **Jellyfin 12 and Japanese TS.** Broadcast TS contains streams that ffprobe can't identify (`codec_type` missing).
  Jellyfin 12.2 fails while reading them (`Nullable object must have a value` in `ProbeResultNormalizer.GetAspectRatio`),
  loses all stream information and then sends MPEG-2 unconverted, which browsers can't play. The image's ffprobe
  (`/opt/tvstack/ffmpeg/ffprobe`) leaves those streams out of the result. Jellyfin 10.11 doesn't need this.
- File names and metadata come from the EPG. EPG text is inconsistent, so some show names will be imperfect. To fix a
  show's folder, set a directory in its EPGStation rule: the rule's directory becomes the show name.
- **Remote tuners.** EPGStation learns programmes from Mirakurun's event stream, and EPG that one Mirakurun copies
  from another produces no events. So with `TVSTACK_REMOTE_MIRAKURUN`, EPGStation talks to the tuner server's
  Mirakurun, and the container's Mirakurun feeds Jellyfin Live TV. On first start the channel scan takes about 15
  minutes with two remote tuners; when it is done, the EPG gatherer is started once so the guide doesn't wait for
  Mirakurun's next :20/:50 run.
- Mirakurun, EPGStation and Jellyfin run unmodified; tvstack only adds configuration and its own helper scripts.
- **Captions.** jellyfin-ffmpeg has no ARIB caption decoder, so the image adds a static ffmpeg from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`/opt/ffmpeg-arib`, with libaribcaption) that only
  the librarian uses. Captions are decoded with `-fix_sub_duration` (ARIB captions have no duration). Live TV has no
  captions. Changing `TVSTACK_SUBTITLES` adds the new files to recordings already in the library.

## Development

`dev/compose.yaml` runs the stack with another Mirakurun as remote tuners. `node --test tests/` runs the librarian tests.
`tools/jf_playtest.py` checks that Jellyfin can transcode every video, and `tools/e2e_record.py` records one short
programme and checks that it reaches the library.

## Credits

[Mirakurun](https://github.com/Chinachu/Mirakurun), [EPGStation](https://github.com/l3tnun/EPGStation),
[Jellyfin](https://jellyfin.org), [recisdb](https://github.com/kazuki0824/recisdb-rs),
[s6-overlay](https://github.com/just-containers/s6-overlay). EPG naming is ported from
[epgXport](https://github.com/MyFeetHurt/epgXport).
