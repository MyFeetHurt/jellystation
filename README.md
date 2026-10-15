# JellyStation

Japanese TV in Jellyfin from one container: **Mirakurun** (tuners), **EPGStation** (recording) and **Jellyfin**
(library and Live TV), supervised by s6-overlay.

![JellyStation demo: the TV library with posters, a series and an episode playing with Japanese captions, films, the Live TV guide with channel numbers and logos, and a live BS channel](media/demo.gif)

Full video (1:21): [jellystation-demo.mp4](https://cdn.jsdelivr.net/gh/MyFeetHurt/jellystation@main/media/jellystation-demo.mp4) · Screenshots: [TV library](media/screenshot-tv.png) · [series](media/screenshot-series.png) · [Live TV guide](media/screenshot-guide.png) · [live TV](media/screenshot-live.png) · [EPGStation](media/screenshot-epgstation.png)

- Finished EPGStation recordings show up in Jellyfin's **TV** and **Movies** libraries, with titles, episode numbers,
  plots, cast, genres and thumbnails taken from the EPG (NFO files). They are hardlinks, so they don't use extra disk.
- When EPGStation finishes an encode, the encoded file replaces the TS in the library. When you delete a recording in
  EPGStation, it leaves the library too.
- Jellyfin **Live TV** uses Mirakurun's channels, numbered like a TV (1.1 NHK総合, 101.1 NHK BS) and with their logos,
  and its EPG (XMLTV) is the programme guide. Movies, sports, news and kids programmes are tagged from the ARIB genres.
- ARIB captions become subtitle files next to each recording (`.ja.srt`, optionally `.ja.ass`), so every Jellyfin
  client can show them.
- Schedule recordings without leaving Jellyfin: the [EPGStation plugin](https://github.com/MyFeetHurt/jellyfin-plugin-epgstation)
  is installed and connected to the bundled EPGStation (guide, search, reservations and rules, for every user).
- Includes a fix for Jellyfin 12, which otherwise can't play Japanese broadcast TS (see [Notes](#notes)).

| Port  | Service    |
|-------|------------|
| 8096  | Jellyfin   |
| 8888  | EPGStation |
| 40772 | Mirakurun  |

## Quick start

```yaml
services:
  jellystation:
    image: ghcr.io/myfeethurt/jellystation:latest
    container_name: jellystation
    restart: unless-stopped
    cap_add:
      - SYS_NICE # Mirakurun raises its own priority
    environment:
      JELLYSTATION_JELLYFIN_PASSWORD: change-me
    devices: # your tuners (see Tuners), and the B-CAS card reader
      - /dev/px4video0:/dev/px4video0 # e.g. PLEX PX-W3U4 (px4_drv)
      - /dev/px4video1:/dev/px4video1
      - /dev/px4video2:/dev/px4video2
      - /dev/px4video3:/dev/px4video3
      # - /dev/dvb:/dev/dvb       # PT1/PT2/PT3, PX-S1UD and other DVB tuners
      - /dev/bus/usb:/dev/bus/usb # card reader (pcscd)
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

JellyStation runs on Linux (x86-64) with [Docker](https://docs.docker.com/engine/install/). Tuners and the card
reader must be visible to the container, which Docker Desktop on Windows and macOS can't do; there it only works with
tuners on another machine (`JELLYSTATION_REMOTE_MIRAKURUN`, see [Settings](#settings)).

1. Install the tuner driver on the host if your tuner needs one (see [Tuners](#tuners)), plug in the card reader
   with the B-CAS card, save the file above as `compose.yaml` and run `docker compose up -d`.
2. On the first start JellyStation writes `config/mirakurun/tuners.yml` for the tuners it finds and scans the
   channels: terrestrial, cable (CATV), BS and CS, about 30 to 60 minutes. `docker logs jellystation` shows what it
   found. During the scan Mirakurun logs many `respawning because request has not closed` warnings: those are
   frequencies without a signal, which is normal (all of the cable range when you don't have cable TV).
3. Open EPGStation at `http://<host>:8888` and add reservations or rules.
4. Open Jellyfin at `http://<host>:8096` and log in as `admin` with `JELLYSTATION_JELLYFIN_PASSWORD`. The libraries
   and Live TV are already set up. Recordings can also be scheduled in Jellyfin at `http://<host>:8096/EpgStation/Web/`
   (administrators also find it under Dashboard → Plugins; add it to the home screen or bookmark it for other users).

## Tuners

Tuner drivers are kernel modules, so they are installed on the **host**, not in the container. JellyStation tunes
with [recisdb](https://github.com/kazuki0824/recisdb-rs) (a recpt1 replacement written in Rust), which handles both
kinds of Linux tuner device:

| Tuners | Host driver | Pass to the container |
|---|---|---|
| PLEX PX-W3U4, PX-Q3U4, PX-W3PE4, PX-Q3PE4, PX-W3PE5, PX-Q3PE5 | [px4_drv](https://github.com/tsukumijima/px4_drv): `sudo apt install ./px4-drv-dkms_*_all.deb` | `/dev/px4video*` |
| PLEX PX-MLT5PE, PX-MLT8PE, PX-M1UR, PX-S1UR; e-Better DTV02A-1T1S-U, DTV02A-4TS-P, DTV03A-1TU | px4_drv | `/dev/pxmlt5video*`, `/dev/pxmlt8video*`, `/dev/pxm1urvideo*`, `/dev/pxs1urvideo*`, `/dev/isdb2056video*`, `/dev/isdb6014video*`, `/dev/isdbt2071video*` |
| Earthsoft PT1, PT2, PT3 | built into Linux (`earth_pt1`, `earth_pt3`) | `/dev/dvb` |
| Earthsoft PT1, PT2, PT3 with the older pt1_drv / pt3_drv | the out-of-tree driver | `/dev/pt1video*`, `/dev/pt3video*` |
| PLEX PX-S1UD, PX-Q1UD and other ISDB DVB tuners | built into Linux; some USB sticks need a firmware file (PX-S1UD: `isdbt_rio.inp` in `/lib/firmware`) | `/dev/dvb` |

`ls /dev/px* /dev/pt* /dev/isdb* /dev/dvb` on the host shows what the driver created.

px4_drv (and other out-of-tree drivers) are built by DKMS, which needs the kernel headers: install them before the
driver (`sudo apt install linux-headers-amd64` on Debian, `linux-headers-generic` on Ubuntu), or run
`sudo dkms autoinstall` afterwards. `sudo dkms status` should say `installed`, not just `added`.

With **Secure Boot** on, the kernel refuses the self-built module (`modprobe: ERROR: could not insert 'px4_drv': Key
was rejected by service`). Enroll the DKMS signing key once: `sudo mokutil --import /var/lib/dkms/mok.pub` (choose a
one-time password), reboot, and on the blue "Shim UEFI key management" screen press a key at once (it waits only a few
seconds), then Enroll MOK → Continue → Yes → the password → Reboot. Or turn Secure Boot off in the firmware settings.
Drivers that are part of Linux (PT1/PT2/PT3, PX-S1UD) are signed and need neither.

**B-CAS card.** Almost all channels, including NHK, are scrambled, so you need a B-CAS card and a smart card reader
(a USB CCID reader such as the NTT Communications SCR3310 or ACS ACR39). The card slot built into some PLEX
tuners (PX-W3U4, PX-Q3U4 and others) is not a standard reader and can't be used on Linux. Pass
`/dev/bus/usb`; pcscd in the container finds the reader and recisdb descrambles with it. The log warns when no
reader is found.

**First start.** When `config/mirakurun/tuners.yml` doesn't exist, JellyStation writes one with a tuner for every
device it finds: px4_drv devices by their names (PX-W3/Q3: satellite, satellite, terrestrial, terrestrial per group
of four), DVB adapters by what their frontend reports. A new channel list is then scanned once Mirakurun runs; a scan
that finds nothing (aerial not connected?) runs again on the next start.

**Channels.** The scan covers terrestrial channels on UHF 13-62 and, for cable TV, on cable frequencies C13-C63
(pass-through; skip it with `JELLYSTATION_CATV=false`), plus all BS and 110° CS channels, including pay channels
such as WOWOW, Star Channel and SKY PerfecTV! e2. Pay channels play when the B-CAS card has a contract for them.
Cable TV that is only delivered through the cable company's set-top box (transmodulation) and SKY PerfecTV! premium
(124/128°) need other hardware and are not supported.

**Adding or changing tuners.** Pass the new devices, then run `docker exec jellystation jellystation-tuners` to see
what it finds and `docker exec jellystation jellystation-tuners --write` to replace `tuners.yml` (the old one is kept
as `tuners.yml.bak`), and restart. To scan again, delete `config/mirakurun/channels.yml` and `tuners.yml` before
restarting, or use Mirakurun's scan API. The tuner command is `/opt/jellystation/bin/tune DEVICE <type> <channel>`;
`JELLYSTATION_RECISDB_ARGS` adds recisdb options to it (e.g. `--lnb 15v` when the tuner powers the dish).

## Layout

```
/config/mirakurun/    server.yml, tuners.yml, channels.yml, data/
/config/epgstation/   config/config.yml, data/ (SQLite), thumbnail/, logs/
/config/jellyfin/     Jellyfin data, config and logs
/config/jellystation/      librarian state, Jellyfin API key (and generated admin password)
/cache/               Jellyfin cache and transcodes
/media/recorded/      EPGStation recordings: <title> 2026-10-10 13-15.ts (title, date, start time; no seconds)
/media/encoded/       EPGStation encodes
/media/library/TV/    TV/<Show>/<Show> - 2026-10-10 1315 - <subtitle>.ts + .nfo + -thumb.jpg + .ja.srt,
                      tvshow.nfo, poster.jpg / landscape.jpg / fanart.jpg (from an episode thumbnail)
/media/library/Movies/  Movies/<Title> (<Year>)/<Title> (<Year>).ts + .nfo
```

Config files are only written when they don't exist, so your changes are kept.

## Settings

| Variable | Default | |
|---|---|---|
| `TZ` | `Asia/Tokyo` | time zone (EPGStation file names, guide) |
| `JELLYSTATION_JELLYFIN_USER` / `JELLYSTATION_JELLYFIN_PASSWORD` | `admin` / random | Jellyfin admin created on first start; a random password is written to `/config/jellystation/jellyfin-admin.txt` |
| `JELLYSTATION_LANGUAGE` | `ja` | Jellyfin UI and metadata language |
| `JELLYSTATION_SERVER_NAME` | `JellyStation` | Jellyfin's server name, set on the first start |
| `JELLYSTATION_TV_LIBRARY_NAME` / `JELLYSTATION_MOVIE_LIBRARY_NAME` | `テレビ番組` / `映画` (`TV` / `Movies` in other languages) | names of the libraries created on the first start |
| `JELLYSTATION_JELLYFIN_SETUP` | `true` | `false`: don't touch Jellyfin's setup (the library refresh still needs `/config/jellystation/jellyfin.key`) |
| `JELLYSTATION_LIVETV` | `true` | add Mirakurun as Jellyfin Live TV tuner and guide |
| `JELLYSTATION_EPGSTATION_PLUGIN` | `true` | install the Jellyfin EPGStation plugin on the first start and connect it to the bundled EPGStation; its repository is added so Jellyfin updates it. Uninstalling it in Jellyfin is permanent |
| `JELLYSTATION_LIVETV_DUPLICATES` | `false` | `true`: also list subchannels that only simulcast another channel (MBS2, MBS3, ...) |
| `JELLYSTATION_TV_ONLINE_METADATA` | `false` | `true`: let Jellyfin look up TV shows online (EPG titles often match the wrong show) |
| `JELLYSTATION_SUBTITLES` | `srt` | ARIB captions as sidecar files: `srt` (plain text, any client), `ass` (keeps position and colour; Jellyfin's web player needs a Japanese fallback font for it), `both`, or `false` |
| `JELLYSTATION_PREFER` | `encoded` | which file goes into the library: `encoded` (when there is one) or `ts` |
| `JELLYSTATION_SYNC_INTERVAL` | `600` | seconds between library checks (EPGStation also triggers one when a recording or encode ends) |
| `JELLYSTATION_ALLOW_MASS_DELETE` | `false` | the librarian refuses to remove more than half of the library in one pass (e.g. after an EPGStation database reset) unless this is `true` |
| `JELLYSTATION_REMOTE_MIRAKURUN` | | `host:port` of another Mirakurun that has the tuners (and the B-CAS card). On first start the container's Mirakurun gets remote tuners that let that server descramble, and copies its channel list; EPGStation is configured to use that Mirakurun directly (see Notes) |
| `JELLYSTATION_REMOTE_TUNERS` | `2` | number of remote tuner slots |
| `JELLYSTATION_EPGSTATION_REC_PRIORITY` / `JELLYSTATION_EPGSTATION_CONFLICT_PRIORITY` | EPGStation's (2 / 1) | tuner priorities for a new `config.yml`, e.g. lower them when sharing a tuner server with another EPGStation |
| `JELLYSTATION_CATV` | `true` | also scan cable TV frequencies (C13-C63) on the first start |
| `JELLYSTATION_LIVE_PROBESIZE` | `10M` | how much of a live stream Jellyfin's ffmpeg/ffprobe read before starting (see Notes) |
| `JELLYSTATION_RECISDB_ARGS` | | extra recisdb options for local tuners, e.g. `--lnb 15v` |
| `JELLYSTATION_PCSCD` | `auto` | start pcscd when `/dev/bus/usb` is passed in; `false` to disable |

Mirakurun's own Docker variables (`LOG_LEVEL`, `EPG_GATHERING_JOB_SCHEDULE`, `LOGO_DATA_INTERVAL`, ...) work as usual.

## Build

The image on ghcr.io is built from this repository by GitHub Actions (`latest` = main, `X.Y.Z` = releases). To build
it yourself:

```sh
docker build -t jellystation .
# versions: --build-arg JELLYFIN_VERSION=12.2 EPGSTATION_VERSION=v2.10.0 MIRAKURUN_VERSION=4.1.5 RECISDB_VERSION=1.3.0
```

## Notes

- **Jellyfin 12 and Japanese TS.** Broadcast TS contains streams that ffprobe can't identify (`codec_type` missing).
  Jellyfin 12.2 fails while reading them (`Nullable object must have a value` in `ProbeResultNormalizer.GetAspectRatio`),
  loses all stream information and then sends MPEG-2 unconverted, which browsers can't play. The image's ffprobe
  (`/opt/jellystation/ffmpeg/ffprobe`) leaves those streams out of the result. Jellyfin 10.11 doesn't need this.
- **Live TV start-up.** Jellyfin opens live streams with `-probesize 1G`, and ffprobe/ffmpeg keep reading until they
  have identified every stream, which the ARIB data streams never are: live playback waited minutes. The image's
  ffprobe and ffmpeg wrappers use 10 MB for live (http) inputs (`JELLYSTATION_LIVE_PROBESIZE`); playback starts in
  about 10 seconds.
- File names and metadata come from the EPG. EPG text is inconsistent, so some show names will be imperfect. To fix a
  show's folder, set a directory in its EPGStation rule: the rule's directory becomes the show name.
- **Remote tuners.** EPGStation learns programmes from Mirakurun's event stream, and EPG that one Mirakurun copies
  from another produces no events. So with `JELLYSTATION_REMOTE_MIRAKURUN`, EPGStation talks to the tuner server's
  Mirakurun, and the container's Mirakurun feeds Jellyfin Live TV. On first start the channel scan takes about 15
  minutes with two remote tuners; when it is done, the EPG gatherer is started once so the guide doesn't wait for
  Mirakurun's next :20/:50 run.
- Mirakurun, EPGStation and Jellyfin run unmodified; JellyStation only adds configuration and its own helper scripts.
- **Captions.** jellyfin-ffmpeg has no ARIB caption decoder, so the image adds a static ffmpeg from
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) (`/opt/ffmpeg-arib`, with libaribcaption) that only
  the librarian uses. Captions are decoded with `-fix_sub_duration` (ARIB captions have no duration). Live TV has no
  captions. Changing `JELLYSTATION_SUBTITLES` adds the new files to recordings already in the library.

## Development

`dev/compose.yaml` runs the stack with another Mirakurun as remote tuners. `node --test tests/` runs the librarian tests.
`tools/jf_playtest.py` checks that Jellyfin can transcode every video, and `tools/e2e_record.py` records one short
programme and checks that it reaches the library. `tools/epgs_import.py` copies finished recordings from another
EPGStation (programme data and the TS) into a test stack. `dev/compose.local.yaml` runs a second stack with local tuners.

## Credits

[Mirakurun](https://github.com/Chinachu/Mirakurun), [EPGStation](https://github.com/l3tnun/EPGStation),
[Jellyfin](https://jellyfin.org), [recisdb](https://github.com/kazuki0824/recisdb-rs),
[s6-overlay](https://github.com/just-containers/s6-overlay). EPG naming is ported from
[epgXport](https://github.com/MyFeetHurt/epgXport); scheduling in Jellyfin is
[jellyfin-plugin-epgstation](https://github.com/MyFeetHurt/jellyfin-plugin-epgstation).
