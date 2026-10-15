# JellyStation

[English](README.md) | 日本語

日本のテレビを Jellyfin で。1 つのコンテナに **Mirakurun**(チューナー)、**EPGStation**(録画)、**Jellyfin**
(ライブラリとライブ TV)をまとめ、s6-overlay で動かします。

![JellyStation のデモ: ポスター付きのテレビ番組ライブラリ、字幕付きでのエピソード再生、映画、チャンネル番号とロゴ付きのライブ TV 番組表、BS の生放送](media/demo.gif)

動画(1:21): [jellystation-demo.mp4](https://cdn.jsdelivr.net/gh/MyFeetHurt/jellystation@main/media/jellystation-demo.mp4) · スクリーンショット: [テレビ番組](media/screenshot-tv.png) · [シリーズ](media/screenshot-series.png) · [ライブ TV 番組表](media/screenshot-guide.png) · [ライブ TV](media/screenshot-live.png) · [EPGStation](media/screenshot-epgstation.png)

- EPGStation で録画した番組が Jellyfin の **テレビ番組** と **映画** ライブラリに入ります。タイトル、話数、
  あらすじ、出演者、ジャンル、サムネイルは EPG から(NFO ファイル)。ハードリンクなのでディスクは増えません。
- EPGStation のエンコードが終わると、ライブラリの TS はエンコード済みファイルに置き換わります。EPGStation で録画を
  削除すると、ライブラリからも消えます。
- Jellyfin の **ライブ TV** は Mirakurun のチャンネルを使います。テレビと同じ番号(1.1 NHK総合、101.1 NHK BS)と
  ロゴ付きで、番組表は Mirakurun の EPG(XMLTV)。映画・スポーツ・ニュース・キッズは ARIB のジャンルから分類します。
- ARIB 字幕は録画の横に字幕ファイル(`.ja.srt`、必要なら `.ja.ass`)として書き出すので、どの Jellyfin
  クライアントでも表示できます。
- Jellyfin から離れずに録画予約: [EPGStation プラグイン](https://github.com/MyFeetHurt/jellyfin-plugin-epgstation)
  が入っていて、同梱の EPGStation につながっています(番組表、検索、予約、ルール。全ユーザーが使えます)。
- Jellyfin 12 で日本の放送 TS が再生できない問題の対策入り([補足](#補足) を参照)。

| ポート | サービス |
|-------|------------|
| 8096  | Jellyfin   |
| 8888  | EPGStation |
| 40772 | Mirakurun  |

## はじめかた

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

JellyStation は Linux(x86-64)と [Docker](https://docs.docker.com/engine/install/) で動きます。チューナーと
カードリーダーをコンテナから見える必要があり、Windows・macOS の Docker Desktop ではできません。そこでは別のマシンの
チューナーを使う場合だけ動きます(`JELLYSTATION_REMOTE_MIRAKURUN`、[設定](#設定) を参照)。

1. 必要ならホストにチューナーのドライバーを入れ([チューナー](#チューナー) を参照)、B-CAS カードを入れた
   カードリーダーをつなぎ、上の内容を `compose.yaml` として保存して `docker compose up -d`。
2. 初回起動時、見つけたチューナーで `config/mirakurun/tuners.yml` を書き、チャンネルをスキャンします:
   地デジ、BS、CS、ケーブル(CATV)で約 1 時間。終わった部分から Mirakurun に出てきます。進み具合は Mirakurun の
   Web UI(`http://<host>:40772`)、見つかったものは `docker logs jellystation` で。スキャン中 Mirakurun は
   `respawning because request has not closed` という警告をたくさん出しますが、電波のない周波数なので正常です
   (ケーブルテレビがなければケーブルの範囲は全部そうなります)。
3. EPGStation(`http://<host>:8888`)で予約やルールを追加。
4. Jellyfin(`http://<host>:8096`)に `admin` と `JELLYSTATION_JELLYFIN_PASSWORD` でログイン。ライブラリと
   ライブ TV は設定済みです。録画予約は Jellyfin の `http://<host>:8096/EpgStation/Web/` でもできます(管理者は
   ダッシュボード → プラグインからも。ほかのユーザーにはホーム画面に追加するかブックマークしてもらってください)。

## チューナー

チューナーのドライバーはカーネルモジュールなので、コンテナではなく **ホスト** に入れます。JellyStation は
[recisdb](https://github.com/kazuki0824/recisdb-rs)(Rust で書かれた recpt1 の代わり)で選局し、Linux の
2 種類のチューナーデバイスどちらにも対応します:

| チューナー | ホストのドライバー | コンテナに渡すもの |
|---|---|---|
| PLEX PX-W3U4, PX-Q3U4, PX-W3PE4, PX-Q3PE4, PX-W3PE5, PX-Q3PE5 | [px4_drv](https://github.com/tsukumijima/px4_drv): `sudo apt install ./px4-drv-dkms_*_all.deb` | `/dev/px4video*` |
| PLEX PX-MLT5PE, PX-MLT8PE, PX-M1UR, PX-S1UR; e-Better DTV02A-1T1S-U, DTV02A-4TS-P, DTV03A-1TU | px4_drv | `/dev/pxmlt5video*`, `/dev/pxmlt8video*`, `/dev/pxm1urvideo*`, `/dev/pxs1urvideo*`, `/dev/isdb2056video*`, `/dev/isdb6014video*`, `/dev/isdbt2071video*` |
| Earthsoft PT1, PT2, PT3 | Linux に標準で入っています(`earth_pt1`、`earth_pt3`) | `/dev/dvb` |
| Earthsoft PT1, PT2, PT3(旧 pt1_drv / pt3_drv を使う場合) | そのドライバー | `/dev/pt1video*`, `/dev/pt3video*` |
| PLEX PX-S1UD, PX-Q1UD など ISDB の DVB チューナー | Linux に標準で入っています。USB のものはファームウェアが必要な場合あり(PX-S1UD: `/lib/firmware` に `isdbt_rio.inp`) | `/dev/dvb` |

ドライバーが作ったデバイスはホストで `ls /dev/px* /dev/pt* /dev/isdb* /dev/dvb` で確認できます。

px4_drv など Linux 本体に入っていないドライバーは DKMS がビルドし、それにはカーネルヘッダーが必要です。ドライバーの
前に入れてください(Debian は `sudo apt install linux-headers-amd64`、Ubuntu は `linux-headers-generic`)。後から
入れた場合は `sudo dkms autoinstall`。`sudo dkms status` が `added` ではなく `installed` になっていれば OK です。

**セキュアブート** が有効だと、自分でビルドしたモジュールは拒否されます(`modprobe: ERROR: could not insert
'px4_drv': Key was rejected by service`)。DKMS の署名鍵を一度だけ登録します: `sudo mokutil --import
/var/lib/dkms/mok.pub`(一回限りのパスワードを決める)で再起動し、青い「Shim UEFI key management」画面ですぐに
キーを押し(数秒しか待ちません)、Enroll MOK → Continue → Yes → パスワード → Reboot。またはファームウェア設定で
セキュアブートを無効にします。Linux 本体のドライバー(PT1/PT2/PT3、PX-S1UD)は署名済みなので、どちらも不要です。

**B-CAS カード。** NHK を含めほぼ全チャンネルにスクランブルがかかっているので、B-CAS カードとスマートカード
リーダー(NTT コミュニケーションズ SCR3310、ACS ACR39 などの USB CCID リーダー)が必要です。一部の PLEX チューナー
(PX-W3U4、PX-Q3U4 など)の内蔵カードスロットは標準のリーダーではなく、Linux では使えません。`/dev/bus/usb` を
渡すと、コンテナ内の pcscd がリーダーを見つけ、recisdb がそれでデスクランブルします。リーダーが見つからないと
ログに警告が出ます。

**初回起動。** `config/mirakurun/tuners.yml` がなければ、見つけたデバイスごとにチューナーを書きます。px4_drv の
デバイスは名前から(PX-W3/Q3 は 4 つ単位で 衛星、衛星、地デジ、地デジ)、DVB アダプターはフロントエンドの
報告から。続いて Mirakurun の起動後にチャンネルをスキャンします。何も見つからなかった場合(アンテナ未接続?)は
次の起動時にもう一度スキャンします。

**チャンネル。** 地デジは UHF 13〜62 と、ケーブルテレビ向けにケーブル周波数 C13〜C63(パススルー。
`JELLYSTATION_CATV=false` で省略)、さらに BS と 110 度 CS の全チャンネルをスキャンします。WOWOW、スターチャンネル、
スカパー!などの有料チャンネルも含みます。有料チャンネルは B-CAS カードに契約があれば映ります。ケーブル会社の
セットトップボックス経由でしか届かないもの(トランスモジュレーション)と、スカパー!プレミアム(124/128 度)は
別のハードウェアが必要で、対応していません。

**チューナーの追加・変更。** 新しいデバイスを渡してから、`docker exec jellystation jellystation-tuners` で見つかる
ものを確認し、`docker exec jellystation jellystation-tuners --write` で `tuners.yml` を書き換えて(元のものは
`tuners.yml.bak` に残ります)再起動します。スキャンし直すには再起動前に `config/mirakurun/channels.yml` と
`tuners.yml` を削除するか、Mirakurun のスキャン API を使います。選局コマンドは
`/opt/jellystation/bin/tune DEVICE <type> <channel>` で、`JELLYSTATION_RECISDB_ARGS` で recisdb のオプションを
追加できます(チューナーからアンテナに給電する場合の `--lnb 15v` など)。

## 構成

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

設定ファイルはないときだけ書くので、変更した内容は残ります。

## 設定

| 変数 | 既定値 | |
|---|---|---|
| `TZ` | `Asia/Tokyo` | タイムゾーン(EPGStation のファイル名、番組表) |
| `JELLYSTATION_JELLYFIN_USER` / `JELLYSTATION_JELLYFIN_PASSWORD` | `admin` / ランダム | 初回起動時に作る Jellyfin 管理者。ランダムなパスワードは `/config/jellystation/jellyfin-admin.txt` に書かれます |
| `JELLYSTATION_LANGUAGE` | `ja` | Jellyfin の表示とメタデータの言語 |
| `JELLYSTATION_SERVER_NAME` | `JellyStation` | 初回起動時に設定する Jellyfin のサーバー名 |
| `JELLYSTATION_TV_LIBRARY_NAME` / `JELLYSTATION_MOVIE_LIBRARY_NAME` | `テレビ番組` / `映画`(ほかの言語では `TV` / `Movies`) | 初回起動時に作るライブラリの名前 |
| `JELLYSTATION_JELLYFIN_SETUP` | `true` | `false`: Jellyfin の設定には触れない(ライブラリの更新には `/config/jellystation/jellyfin.key` が必要) |
| `JELLYSTATION_LIVETV` | `true` | Mirakurun を Jellyfin のライブ TV のチューナーと番組表に追加 |
| `JELLYSTATION_EPGSTATION_PLUGIN` | `true` | 初回起動時に Jellyfin の EPGStation プラグインを入れ、同梱の EPGStation につなぐ。リポジトリも追加するので Jellyfin が更新します。Jellyfin でアンインストールすると、そのままになります |
| `JELLYSTATION_LIVETV_DUPLICATES` | `false` | `true`: ほかのチャンネルを同時放送しているだけのサブチャンネル(MBS2、MBS3 など)も表示 |
| `JELLYSTATION_TV_ONLINE_METADATA` | `false` | `true`: テレビ番組を Jellyfin がネットで調べる(EPG のタイトルは別の番組に当たりがち) |
| `JELLYSTATION_SUBTITLES` | `srt` | ARIB 字幕の書き出し: `srt`(テキスト、どのクライアントでも)、`ass`(位置と色を保持。Jellyfin の Web プレーヤーでは日本語のフォールバックフォントが必要)、`both`、`false` |
| `JELLYSTATION_PREFER` | `encoded` | ライブラリに入れるファイル: `encoded`(あれば)か `ts` |
| `JELLYSTATION_SYNC_INTERVAL` | `600` | ライブラリを確認する間隔(秒)。録画やエンコードが終わると EPGStation からも知らせます |
| `JELLYSTATION_ALLOW_MASS_DELETE` | `false` | 1 回でライブラリの半分以上を消す処理(EPGStation のデータベースを初期化した後など)は、`true` にしない限り行いません |
| `JELLYSTATION_REMOTE_MIRAKURUN` | | チューナー(と B-CAS カード)を持つ別の Mirakurun の `host:port`。初回起動時、コンテナの Mirakurun にそのサーバーでデスクランブルするリモートチューナーを作り、チャンネル一覧をコピーします。EPGStation はその Mirakurun を直接使います(補足を参照) |
| `JELLYSTATION_REMOTE_TUNERS` | `2` | リモートチューナーの数 |
| `JELLYSTATION_EPGSTATION_REC_PRIORITY` / `JELLYSTATION_EPGSTATION_CONFLICT_PRIORITY` | EPGStation の既定(2 / 1) | 新しい `config.yml` のチューナー優先度。チューナーサーバーをほかの EPGStation と共有するときに下げるなど |
| `JELLYSTATION_CATV` | `true` | 初回起動時にケーブル周波数(C13〜C63)もスキャン |
| `JELLYSTATION_LIVE_PROBESIZE` | `10M` | ライブ再生の前に Jellyfin の ffmpeg/ffprobe が読む量(補足を参照) |
| `JELLYSTATION_RECISDB_ARGS` | | ローカルチューナーで recisdb に追加するオプション(例: `--lnb 15v`) |
| `JELLYSTATION_PCSCD` | `auto` | `/dev/bus/usb` が渡されていれば pcscd を起動。`false` で無効 |

Mirakurun の Docker 用の変数(`LOG_LEVEL`、`EPG_GATHERING_JOB_SCHEDULE`、`LOGO_DATA_INTERVAL` など)もそのまま使えます。

## ビルド

ghcr.io のイメージはこのリポジトリから GitHub Actions でビルドしています(`latest` = main、`X.Y.Z` = リリース)。
自分でビルドするには:

```sh
docker build -t jellystation .
# versions: --build-arg JELLYFIN_VERSION=12.2 EPGSTATION_VERSION=v2.10.0 MIRAKURUN_VERSION=4.1.5 RECISDB_VERSION=1.3.0
```

## 補足

- **Jellyfin 12 と日本の TS。** 放送の TS には ffprobe が識別できないストリーム(`codec_type` なし)が含まれます。
  Jellyfin 12.2 はそれを読むときに失敗し(`ProbeResultNormalizer.GetAspectRatio` で `Nullable object must have a
  value`)、ストリーム情報をすべて失って MPEG-2 をそのまま送るので、ブラウザで再生できません。イメージの ffprobe
  (`/opt/jellystation/ffmpeg/ffprobe`)はそれらのストリームを結果から除きます。Jellyfin 10.11 では不要です。
- **ライブ TV の開始。** Jellyfin はライブストリームを `-probesize 1G` で開き、ffprobe/ffmpeg はすべての
  ストリームを識別するまで読み続けますが、ARIB のデータストリームは識別されないので、ライブ再生が数分待ちに
  なっていました。イメージの ffprobe と ffmpeg のラッパーはライブ(http)入力を 10 MB にします
  (`JELLYSTATION_LIVE_PROBESIZE`)。再生は 10 秒ほどで始まります。
- ファイル名とメタデータは EPG から作ります。EPG の書き方はまちまちなので、番組名が不完全なこともあります。
  番組のフォルダーを直すには、EPGStation のルールで保存ディレクトリを指定してください。ルールのディレクトリが
  番組名になります。
- **リモートチューナー。** EPGStation は Mirakurun のイベントから番組を知りますが、ある Mirakurun が別の
  Mirakurun からコピーした EPG ではイベントが出ません。そのため `JELLYSTATION_REMOTE_MIRAKURUN` では EPGStation は
  チューナーサーバーの Mirakurun を直接使い、コンテナの Mirakurun は Jellyfin のライブ TV に使います。初回の
  チャンネルスキャンはリモートチューナー 2 つで約 15 分。終わると EPG の取得を一度始めるので、番組表が Mirakurun の
  次の :20/:50 を待つことはありません。
- Mirakurun、EPGStation、Jellyfin は改変せずに動かしています。JellyStation が加えるのは設定と自前の補助スクリプト
  だけです。
- **字幕。** jellyfin-ffmpeg には ARIB 字幕のデコーダーがないので、イメージには
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の静的な ffmpeg(`/opt/ffmpeg-arib`、libaribcaption
  入り)を追加しており、librarian だけが使います。ARIB 字幕には表示時間がないので `-fix_sub_duration` で
  デコードします。ライブ TV には字幕はありません。`JELLYSTATION_SUBTITLES` を変えると、ライブラリにある録画にも
  新しいファイルが追加されます。

## 開発

`dev/compose.yaml` は別の Mirakurun をリモートチューナーとして使う構成です。`node --test tests/` で librarian の
テスト。`tools/jf_playtest.py` は Jellyfin がすべての動画をトランスコードできるか確認し、`tools/e2e_record.py` は
短い番組を 1 つ録画してライブラリに入るか確認します。`tools/epgs_import.py` は別の EPGStation の録画(番組情報と
TS)をテスト環境にコピーします。`dev/compose.local.yaml` はローカルチューナーで 2 つ目の構成を動かします。

## クレジット

[Mirakurun](https://github.com/Chinachu/Mirakurun)、[EPGStation](https://github.com/l3tnun/EPGStation)、
[Jellyfin](https://jellyfin.org)、[recisdb](https://github.com/kazuki0824/recisdb-rs)、
[s6-overlay](https://github.com/just-containers/s6-overlay)。EPG からの名前付けは
[epgXport](https://github.com/MyFeetHurt/epgXport) から移植、Jellyfin からの予約は
[jellyfin-plugin-epgstation](https://github.com/MyFeetHurt/jellyfin-plugin-epgstation) です。

## ライセンス

MIT(JellyStation 自身のスクリプトと設定)。イメージには Mirakurun(Apache-2.0)、EPGStation(MIT)、
Jellyfin(GPL-2.0)、recisdb(GPL-3.0)、FFmpeg(GPL)、s6-overlay(ISC)、EPGStation プラグイン(GPL-3.0)も
含まれ、それぞれのライセンスに従います。
