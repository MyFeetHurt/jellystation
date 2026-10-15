# JellyStation: Mirakurun + EPGStation + Jellyfin in one container, supervised by s6-overlay.
#
#   Mirakurun  :40772  tuners (local PT3/PX devices via recisdb, or another Mirakurun)
#   EPGStation :8888   recording; finished recordings are put in the Jellyfin library by the librarian
#   Jellyfin   :8096   TV + Movies libraries from the recordings, Live TV from Mirakurun
ARG JELLYFIN_VERSION=12.2
ARG NODE_VERSION=22

# --- build: EPGStation, Mirakurun, s6-overlay ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie AS build
ARG EPGSTATION_VERSION=v2.10.0
ARG MIRAKURUN_VERSION=4.1.5
ARG S6_OVERLAY_VERSION=3.2.3.2
ARG TARGETARCH
ENV npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
# EPGStation's sqlite3 has no prebuilt binary for Node 22 and its node-gyp 8 fails with Python 3.13: install without
# scripts, replace node-gyp with a current one, then run the install scripts.
RUN npm install -g node-gyp@11

RUN git clone --depth 1 --branch ${EPGSTATION_VERSION} https://github.com/l3tnun/EPGStation.git /opt/epgstation
WORKDIR /opt/epgstation
RUN npm install --no-save --ignore-scripts \
    && rm -rf node_modules/node-gyp && cp -r /usr/local/lib/node_modules/node-gyp node_modules/node-gyp \
    && npm rebuild && (cd client && npm install --no-save) \
    && npm run build \
    && npm prune --omit=dev \
    && find client -mindepth 1 -maxdepth 1 ! -name dist -exec rm -rf {} + \
    && rm -rf .git config/*.template img doc \
    && for d in config data thumbnail logs drop; do rm -rf $d && ln -s /config/epgstation/$d $d; done

WORKDIR /opt/mirakurun
RUN npm install --omit=dev --no-save mirakurun@${MIRAKURUN_VERSION}

# ffmpeg with ARIB caption decoders (libaribcaption), only for writing caption files (Jellyfin keeps jellyfin-ffmpeg).
# BtbN's rolling "latest" build of the branch: its dated autobuilds are deleted after a few weeks.
ARG FFMPEG_ARIB_BRANCH=8.1
RUN arch=$(case "${TARGETARCH:-amd64}" in arm64) echo linuxarm64;; *) echo linux64;; esac) \
    && mkdir -p /opt/ffmpeg-arib/bin \
    && curl -fsSL "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-n${FFMPEG_ARIB_BRANCH}-latest-${arch}-gpl-${FFMPEG_ARIB_BRANCH}.tar.xz" \
       | tar -xJ -C /opt/ffmpeg-arib --strip-components=1 --wildcards '*/bin/ffmpeg' '*/LICENSE.txt' \
    && /opt/ffmpeg-arib/bin/ffmpeg -hide_banner -decoders | grep -q libaribcaption

RUN mkdir /s6 && arch=$(case "${TARGETARCH:-amd64}" in arm64) echo aarch64;; *) echo x86_64;; esac) \
    && for f in noarch $arch; do \
         curl -fsSL "https://github.com/just-containers/s6-overlay/releases/download/v${S6_OVERLAY_VERSION}/s6-overlay-$f.tar.xz" \
         | tar -C /s6 -Jxp; \
       done

# --- runtime ---------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS node
FROM jellyfin/jellyfin:${JELLYFIN_VERSION}
ARG RECISDB_VERSION=1.3.0
ARG TARGETARCH

RUN apt-get update \
    && apt-get install -y --no-install-recommends jq unzip dvb-tools pcscd libccid pcsc-tools libpcsclite1 tzdata ca-certificates \
    && curl -fsSL -o /tmp/recisdb.deb \
       "https://github.com/kazuki0824/recisdb-rs/releases/download/${RECISDB_VERSION}/recisdb_${RECISDB_VERSION}-1_${TARGETARCH:-amd64}.deb" \
    && apt-get install -y --no-install-recommends /tmp/recisdb.deb \
    && rm -rf /tmp/recisdb.deb /var/lib/apt/lists/*

# Jellyfin plugin for EPGStation reservations (https://github.com/MyFeetHurt/jellyfin-plugin-epgstation); the build
# for Jellyfin 12 ends in .12 (10.11: .11). Installed into Jellyfin on the first start (bin/init).
ARG EPGSTATION_PLUGIN_VERSION=0.2.0
ARG EPGSTATION_PLUGIN_ABI=12
RUN mkdir -p /opt/jellystation/jellyfin-plugins/EPGStation \
    && curl -fsSL -o /tmp/plugin.zip "https://github.com/MyFeetHurt/jellyfin-plugin-epgstation/releases/download/v${EPGSTATION_PLUGIN_VERSION}/epgstation_${EPGSTATION_PLUGIN_VERSION}.${EPGSTATION_PLUGIN_ABI}.zip" \
    && unzip -q /tmp/plugin.zip -d /opt/jellystation/jellyfin-plugins/EPGStation \
    && rm /tmp/plugin.zip

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /s6/ /
COPY --from=build /opt/epgstation /opt/epgstation
COPY --from=build /opt/mirakurun /opt/mirakurun
COPY --from=build /opt/ffmpeg-arib /opt/ffmpeg-arib
COPY rootfs/ /

# The base image preloads jemalloc for every process; only Jellyfin gets it (see its run script).
ENV LD_PRELOAD= \
    TZ=Asia/Tokyo \
    S6_KEEP_ENV=1 \
    S6_BEHAVIOUR_IF_STAGE2_FAILS=2 \
    S6_CMD_WAIT_FOR_SERVICES_MAXTIME=0 \
    S6_KILL_GRACETIME=10000

VOLUME ["/config", "/cache", "/media"]
EXPOSE 8096 8888 40772
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s \
    CMD curl -fsS http://127.0.0.1:8096/health && curl -fsS http://127.0.0.1:8888/api/version >/dev/null \
        && curl -fsS http://127.0.0.1:40772/api/version >/dev/null || exit 1
ENTRYPOINT ["/init"]
