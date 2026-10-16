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

## 必要なもの

- **x86-64 の Linux** が動く PC か NAS。Ubuntu 24.04・26.04、Debian 13、Fedora 44、TrueNAS 25.10、
  OpenMediaVault 8 で確認しています。Windows、macOS、ARM ボード(Raspberry Pi)ではコンテナからチューナーを
  使えません: [ほかのシステム](#ほかのシステム) を参照。
- Linux で使える **チューナー**([チューナー](#チューナー) を参照)。アンテナ(BS/CS はパラボラも)につなぎます。
- **B-CAS カード** と USB の **スマートカードリーダー**(NTT コミュニケーションズ SCR3310、ACS ACR39 など)。
  一部の PLEX チューナーの内蔵カードスロットは Linux では使えません。
- ディスク: 録画は 1 時間あたり約 7 GB(地デジ)〜 11 GB(BS)。

## インストール

以下のコマンドは Linux マシンのターミナル(または ssh)で入力します。`sudo` で始まるコマンドは管理者として動き、
パスワードを聞かれます。各手順の最後に、うまくいったかの確かめ方を書いています。

### 1. Docker を入れる

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo systemctl enable --now docker
```

Ubuntu、Debian、Fedora とその仲間(Linux Mint など)で使えます。ディストリビューションのパッケージでも構いません:
Ubuntu は `sudo apt install docker.io docker-compose-v2`(両方。2 つ目が `docker compose` です)、Fedora は
`sudo dnf install docker-cli moby-engine docker-compose`。

確認: `sudo docker compose version` でバージョンが出れば OK。

この README では `sudo docker ...` と書いています。`sudo` を付けないと `permission denied while trying to connect
to the docker API` になります(`sudo` を省きたいときは `sudo usermod -aG docker $USER` の後でログインし直します)。

### 2. チューナーのドライバーを入れる

チューナーのドライバーは Linux のカーネルで動くので、コンテナではなくマシン本体に入れます。お使いのチューナーを
[チューナー](#チューナー) で確認してください:

- **アースソフト PT1/PT2/PT3、PLEX PX-S1UD などの DVB チューナー** は Linux に入っているので不要です。下の確認へ。
- **PLEX PX-W3U4、PX-Q3U4、PX-W3PE4/5、PX-Q3PE4/5、PX-MLT、PX-M1UR、PX-S1UR、e-Better DTV02A/03A** には
  [px4_drv](https://github.com/tsukumijima/px4_drv) が必要です。Ubuntu、Debian とその仲間では:

  ```sh
  sudo apt install -y dkms linux-headers-$(uname -r)
  wget https://github.com/tsukumijima/px4_drv/releases/download/v0.6.1/px4-drv-dkms_0.6.1_all.deb
  sudo apt install -y ./px4-drv-dkms_0.6.1_all.deb
  ```

  カーネルの更新後もドライバーが作り直されるよう、更新に付いてくるヘッダーのパッケージも入れます:
  `sudo apt install linux-headers-generic`(Ubuntu)または `sudo apt install linux-headers-amd64`(Debian)。

  Fedora(など .deb のないディストリビューション)では、ソースから DKMS でビルドします:

  ```sh
  sudo dnf install -y dkms kernel-devel-$(uname -r) gcc make git
  git clone --depth 1 --branch v0.6.1 https://github.com/tsukumijima/px4_drv
  sudo cp -a px4_drv /usr/src/px4_drv-0.6.1
  sudo dkms add px4_drv/0.6.1 && sudo dkms install px4_drv/0.6.1
  ```

  Ubuntu のみ: PC が **セキュアブート** を使っていると、インストール中に青い「Configuring Secure Boot」画面で
  パスワードを聞かれます。8 文字以上で決めて控えてください。次の再起動で 1 回だけ使います(下を参照)。

確認: チューナーをつないで(USB のチューナーはドライバーを入れた後に抜き差し)、

```sh
ls /dev/px4video* /dev/pxmlt* /dev/pxm1ur* /dev/pxs1ur* /dev/isdb* /dev/dvb 2>/dev/null
```

でチューナーが出れば OK(px4_drv のチューナーは `/dev/px4video0` など、PT3 や DVB チューナーは `/dev/dvb`)。
何も出ないときは `sudo modprobe px4_drv`(px4_drv のチューナー)を実行して、表示を読みます:

- `Key was rejected by service`: **セキュアブート** が自分でビルドしたドライバーを拒否しています。ドライバーの
  鍵を一度だけ登録します:

  ```sh
  sudo mokutil --import /var/lib/shim-signed/mok/MOK.der   # Ubuntu
  sudo mokutil --import /var/lib/dkms/mok.pub              # Debian、Fedora など
  ```

  (どちらか片方のファイルだけがあります: `ls /var/lib/shim-signed/mok/MOK.der /var/lib/dkms/mok.pub`)

  一回限りのパスワードを決めて `sudo reboot` し、画面の前で待ちます: 青い **Shim UEFI key management** 画面が
  **10 秒** だけキー入力を待ちます。キーを押し、**Enroll MOK** → **Continue** → **Yes** → パスワード →
  **Reboot**。10 秒を逃すと登録の要求は消えるので、`mokutil` のコマンドからやり直してください。(インストール中の
  青い画面でパスワードを決めた Ubuntu の方は、再起動だけで OK。)ファームウェア設定でセキュアブートを無効にしても
  構いません。
- `Module px4_drv not found`: ドライバーがビルドされていません。`sudo dkms status` が `installed` なら OK。
  `added` のときはカーネルヘッダーがありませんでした。上のヘッダーを入れて `sudo dkms autoinstall`。

### 3. compose ファイルを作る

**compose ファイル**(`compose.yaml`)は、JellyStation をどう動かすか(使ってよいチューナー、データの置き場所)を
Docker に伝えるファイルです。JellyStation がこのマシン用に書いてくれます。フォルダーを作って中に入り、2 つ目の
コマンド(長い 1 行)を実行します:

```sh
mkdir ~/jellystation && cd ~/jellystation
sudo docker run --rm -v /dev:/dev:ro --entrypoint jellystation-compose ghcr.io/myfeethurt/jellystation > compose.yaml
```

初回は Docker がイメージ(約 1 GB、展開後 3.5 GB)をダウンロードします。その後、見つけたものを表示します。例:

```
tuners: /dev/px4video0 /dev/px4video1 /dev/px4video2 /dev/px4video3
card reader: found
Jellyfin login: admin / JZZqDFBIKS4j
next: sudo docker compose up -d
```

Jellyfin のパスワードを控えてください(`compose.yaml` にも書かれています)。`tuners: NONE found` やカードリーダーが
見つからないと出たら、手順 2 に戻ってからもう一度実行します(後から `compose.yaml` を手で直すこともできます。
[compose ファイル](#compose-ファイル) を参照)。

JellyStation のデータはすべてこのフォルダーに入ります: `config/`(設定、データベース)、`cache/`、`media/`
(録画と Jellyfin のライブラリ)。録画を大きなディスクに置くには、`compose.yaml` の `volumes:` にある `./media` を
そのディスクのフォルダーに変えます(例: `/mnt/bigdisk/tv:/media`)。

### 4. 起動する

```sh
sudo docker compose up -d
```

`compose.yaml` のあるフォルダーで実行します(`cd ~/jellystation`)。`-d` はバックグラウンドで動かす意味で、
ターミナルを閉じても動き続け、再起動後も自動で起動します。

確認: `sudo docker compose ps` が `Up`、1 分ほどで `(healthy)` になれば OK。

### 5. チャンネルスキャンを待つ

初回起動時、JellyStation はチャンネルを探します: 地デジ、BS、CS、ケーブルテレビで約 1 時間。チャンネルは
スキャンがすべて終わってから出てきます。進み具合を見るには:

```sh
sudo docker logs -f jellystation 2>&1 | grep -E "jellystation:|Z (mirakurun|jellyfin):|found [0-9]+ tuners|card reader"
```

(Ctrl+C で表示をやめます。JellyStation は動き続けます。)Mirakurun のページ `http://<host>:40772` でも見られます。
ログに `channel scan finished` と出たら、EPGStation にはチャンネルが 10 分ほどで、番組はその少し後に出てきます。
最初の予約はその後で。
`<host>` は Linux マシンのアドレスです(`hostname -I` で表示)。例: `http://192.168.1.20:40772`。

### 6. 見る・録る

- **Jellyfin** `http://<host>:8096`: `admin` と手順 3 のパスワードでログイン。テレビ番組・映画のライブラリと
  ライブ TV は設定済みです。家族のユーザーはダッシュボード → ユーザーで追加します。
- **EPGStation** `http://<host>:8888`: 番組表。予約やルール(シリーズの全話など)を追加します。Jellyfin の
  `http://<host>:8096/EpgStation/Web/` からも予約できます。
- 録画が終わると、数分で Jellyfin に出てきます。

## ふだん使うコマンド

JellyStation のフォルダー(`cd ~/jellystation`)で実行します。

| すること | コマンド |
|---|---|
| 動いているか | `sudo docker compose ps` |
| ログを見る(Ctrl+C でやめる) | `sudo docker compose logs -f` |
| 止める | `sudo docker compose down` |
| 起動する | `sudo docker compose up -d` |
| 再起動(設定ファイルを変えた後) | `sudo docker compose restart` |
| 最新版に更新 | `sudo docker compose pull && sudo docker compose up -d` |
| `compose.yaml` の変更を反映 | `sudo docker compose up -d` |
| JellyStation から見えるチューナー | `sudo docker exec jellystation jellystation-tuners` |

`down` や更新をしても、録画・設定・予約は消えません(コンテナではなくフォルダーにあります)。アンインストールは
`sudo docker compose down` の後でフォルダーを削除します(中の録画も消えます)。

## 困ったとき

| 表示 | すること |
|---|---|
| `permission denied while trying to connect to the docker API` | コマンドの前に `sudo` を付けます。 |
| `no configuration file provided: not found` | `compose.yaml` のあるフォルダーにいません: `cd ~/jellystation`。 |
| `empty compose file` | 手順 3 のコマンドが失敗して空のファイルが残っています。もう一度実行して、表示を読みます。 |
| `error while creating mount source path '/srv/...': read-only file system` | Docker が snap で入っています(Ubuntu Server のインストーラーが勧めるもの)。snap の Docker はホームフォルダーと `/mnt` しか使えません。データをそこに置くか、snap を消して(`sudo snap remove docker`)手順 1 のとおりに入れ直します。 |
| `error gathering device information while adding custom device "/dev/px4video0": no such file or directory` | `compose.yaml` にあるデバイスがありません(チューナーが抜けている、ドライバーが読み込まれていない: 手順 2)。直すか、その行を消します。 |
| `modprobe: ERROR: could not insert 'px4_drv': Key was rejected by service` | セキュアブート: ドライバーの鍵を登録します(手順 2)。 |
| `mkdir: cannot create directory '/config/...': Permission denied`(Fedora、RHEL) | SELinux: `volumes:` の各フォルダーの後に `:z` を付けます(`./config:/config:z`)。`jellystation-compose` は自動で付けます。 |
| ログに `no tuner devices found` | チューナーがコンテナに渡されていません。`compose.yaml` を作り直し(手順 3)、`sudo rm config/mirakurun/tuners.yml` の後 `sudo docker compose up -d --force-recreate`。 |
| `WARNING: no smart card reader found` / 録画やライブ TV が再生できない | B-CAS カードを入れたカードリーダーをつなぎ、`devices:` に `/dev/bus/usb` があるか確かめて `sudo docker compose restart`。 |
| `channel scan found no channels` | 電波がありません: アンテナ線を確かめます。次の起動時にもう一度スキャンします(`sudo docker compose restart`)。 |
| `respawning because request has not closed` の警告がたくさん | チャンネルスキャン中は正常です(電波のない周波数)。 |

## ほかのシステム

- **TrueNAS SCALE / Community Edition**(25.10 で確認): 設定・キャッシュ・メディア用のデータセットを作り、
  アプリ → Discover Apps → ⋮ → Install via YAML で、そのパス(`/mnt/<プール>/...`)にした compose ファイルを
  貼り付けます。TrueNAS ではカーネルドライバーを追加できないので、使えるのは Linux 本体にドライバーがある
  チューナーだけです: PT1/PT2/PT3 と PX-S1UD(PT3 で確認)。px4_drv のチューナー(PX-W3U4、PX-Q3U4 など)は下の
  チューナーサーバーを使います。
- **OpenMediaVault**(8 で確認): 中身は Debian なので、手順 2 のとおりチューナーのドライバーを入れます。
  omv-extras の Compose プラグインで、手順 3 の compose ファイルを追加します。`volumes:` では `.` の代わりに
  `CHANGE_TO_COMPOSE_DATA_PATH`(プラグインのデータフォルダー)を使います。
- **Windows、macOS、Raspberry Pi などの ARM ボード**: イメージは x86-64 の Linux 用で、Docker Desktop
  (Windows、macOS)はチューナーやカードリーダーをコンテナに渡せません。代わりに **チューナーサーバー**
  (チューナーとカードリーダーをつないで Mirakurun を動かすマシン)を使います。JellyStation はそのチューナーを
  ネットワーク越しに使います: `JELLYSTATION_REMOTE_MIRAKURUN=<チューナーサーバー>:40772`([設定](#設定) と
  [補足](#補足) を参照)。Linux では手順 3 のコマンドの `--rm` の後に
  `-e JELLYSTATION_REMOTE_MIRAKURUN=<チューナーサーバー>:40772` を足すと、そのための compose ファイルを書きます。
  Windows は [Windows](#windowsdocker-desktop) を参照。

## Windows(Docker Desktop)

Windows 10/11 の Docker Desktop で動きます。チューナーは **チューナーサーバー**(チューナーと B-CAS カードを
つないで Mirakurun を動かしている、同じネットワークの別の PC や NAS)のものを使います(Windows ではチューナーや
カードリーダーをコンテナに渡せません)。

1. [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/) をインストール(「Use WSL 2」は
   そのまま)して再起動。Docker Desktop が **WSL not installed** と言ったら、スタートを右クリック →「ターミナル
   (管理者)」で `wsl --install` を実行して、もう一度再起動します。
2. スタートメニューから Docker Desktop を起動し、**Engine running** になるまで待ちます。Settings → General の
   **Start Docker Desktop when you sign in to your computer** をオンに。
3. フォルダーを作り(例 `C:\Users\<名前>\jellystation`)、メモ帳に下の内容を貼り付け、チューナーサーバーの
   アドレスとパスワードを書き換えて、そのフォルダーに `compose.yaml` という名前で保存します。**ファイルの種類は
   「すべてのファイル」、文字コードは UTF-8**(そうしないと `compose.yaml.txt` になります):

```yaml
services:
  jellystation:
    image: ghcr.io/myfeethurt/jellystation:latest
    container_name: jellystation
    restart: unless-stopped
    stop_grace_period: 30s
    cap_add:
      - SYS_NICE
    environment:
      TZ: Asia/Tokyo
      JELLYSTATION_JELLYFIN_PASSWORD: change-me # Jellyfin login admin / this
      JELLYSTATION_REMOTE_MIRAKURUN: "192.168.1.10:40772" # your tuner server
      JELLYSTATION_REMOTE_TUNERS: "2"
    ports:
      - "8096:8096"
      - "8888:8888"
      - "40772:40772"
    volumes:
      - config:/config # settings and databases, inside Docker (fast)
      - cache:/cache
      - ./media:/media # recordings, in this folder; or a bigger drive: D:\TV:/media
volumes:
  config:
  cache:
```

   Windows では `devices:` は書きません。設定とデータベースは Docker 自身の保存場所(`config`、`cache`)に
   置きます。Windows のフォルダーに置くと EPGStation のデータベースが何分もロックされ、Jellyfin の番組表の
   読み込みに 1 時間近くかかります。録画は `media` フォルダーに入り、エクスプローラーで見られます。`/srv/tv` の
   ような Linux のパスは使わないでください: Docker Desktop の仮想マシンのメモリー上に置かれ、再起動で消えます。
4. フォルダーのアドレスバーに `powershell` と入力して Enter、`docker compose up -d`(Windows では `sudo` は
   不要)。「Docker Desktop Backend にネットワークへのアクセスを許可しますか」と聞かれたら **許可** を
   (しないとテレビやスマホから Jellyfin に届きません)。
5. 初回は約 20 分かかります(チューナーサーバーからチャンネル一覧、それから番組表)。`docker compose logs -f` で
   様子を見られます。
6. その PC では `http://localhost:8096`、ほかの機器からは `http://<PC のアドレス>:8096`(`ipconfig` の
   IPv4 アドレス)。

JellyStation は Docker Desktop が動いている間、つまり Windows にサインインしていて PC がスリープしていない間
だけ動きます。夜中も録画するならスリープを「なし」に(設定 → システム → 電源)。`media\library` の録画は
`media\recorded` のハードリンクです。エクスプローラーには両方見えますが、ディスクは 1 回分しか使いません。
Docker には PC のメモリーの半分が割り当てられます(8 GB の PC で動作確認)。

## 外出先から見る(Tailscale)

[Tailscale](https://tailscale.com)(個人利用は無料)を使うと、ルーターのポートを開けずに、スマホやノート PC から
インターネット越しに家のマシンへつなげます。代わりに 8888 や 40772 のポートをインターネットに開けるのはやめて
ください。EPGStation と Mirakurun にはログインがありません。

簡単な方法: Linux マシン自体に Tailscale を入れ(`curl -fsSL https://tailscale.com/install.sh | sh` の後
`sudo tailscale up`)、スマホにも Tailscale アプリを入れます。Jellyfin は `http://<マシン名>:8096` になります。

または、マシンには何も入れずに、Tailscale を JellyStation の隣の 2 つ目のコンテナとして動かします。`compose.yaml`
の最後にこれを追加します(`tailscale:` は `jellystation:` と同じ深さ、`configs:` は行の先頭から):

```yaml
  tailscale:
    image: tailscale/tailscale:stable
    container_name: jellystation-tailscale
    hostname: jellystation # its name on your Tailscale network
    restart: unless-stopped
    environment:
      TS_STATE_DIR: /var/lib/tailscale
      TS_SERVE_CONFIG: /serve.json
    configs:
      - source: tailscale-serve
        target: /serve.json
    volumes:
      - ./tailscale:/var/lib/tailscale

configs:
  tailscale-serve: # Tailscale ports 8096 (Jellyfin) and 8888 (EPGStation) lead to JellyStation
    content: |
      {"TCP": {"8096": {"TCPForward": "jellystation:8096"}, "8888": {"TCPForward": "jellystation:8888"}}}
```

`sudo docker compose up -d` の後、`sudo docker logs jellystation-tailscale 2>&1 | grep login.tailscale.com` で出る
リンクを一度開いて Tailscale にログインすると、マシンが追加されます。スマホ(Tailscale アプリをオン)の Jellyfin
アプリは `http://jellystation:8096` に、EPGStation は `http://jellystation:8888` でつながります。ログイン情報は
`./tailscale` に残ります。

## チューナー

| チューナー | Linux のドライバー | `compose.yaml` の `devices:` |
|---|---|---|
| PLEX PX-W3U4, PX-Q3U4, PX-W3PE4, PX-Q3PE4, PX-W3PE5, PX-Q3PE5 | [px4_drv](https://github.com/tsukumijima/px4_drv)(手順 2) | `/dev/px4video*` |
| PLEX PX-MLT5PE, PX-MLT8PE, PX-M1UR, PX-S1UR; e-Better DTV02A-1T1S-U, DTV02A-4TS-P, DTV03A-1TU | px4_drv | `/dev/pxmlt5video*`, `/dev/pxmlt8video*`, `/dev/pxm1urvideo*`, `/dev/pxs1urvideo*`, `/dev/isdb2056video*`, `/dev/isdb6014video*`, `/dev/isdbt2071video*` |
| アースソフト PT1, PT2, PT3 | Linux に標準で入っています(`earth_pt1`、`earth_pt3`) | `/dev/dvb` |
| アースソフト PT1, PT2, PT3(旧 pt1_drv / pt3_drv を使う場合) | そのドライバー | `/dev/pt1video*`, `/dev/pt3video*` |
| PLEX PX-S1UD, PX-Q1UD など ISDB の DVB チューナー | Linux に標準で入っています。USB のものはファームウェアが必要な場合あり(PX-S1UD: `/lib/firmware` に `isdbt_rio.inp`) | `/dev/dvb` |

確認済み(2026 年 10 月): px4_drv 0.6.1 は Ubuntu 24.04(カーネル 6.8)・26.04(7.0)、Debian 13(6.12)、
Fedora 44(7.2)でビルド・読み込みでき、セキュアブート有効でも鍵の登録後に動きます。PX-Q3U4 と PT3(`earth_pt3`)は
これらすべてで録画できました。`earth_pt3` はこれらのディストリビューションの通常のカーネルに入っています(Ubuntu の
クラウド・VM 向けの最小カーネル `linux-image-virtual` には入っていないので、`sudo apt install linux-generic`)。

JellyStation は [recisdb](https://github.com/kazuki0824/recisdb-rs)(Rust で書かれた recpt1 の代わり)で選局し、
コンテナ内の pcscd 経由で B-CAS カードを使ってデスクランブルします。カードリーダーは `/dev/bus/usb` として渡し、
リーダーが見つからないとログに警告が出ます。

**初回起動。** `config/mirakurun/tuners.yml` がなければ、見つけたデバイスごとにチューナーを書きます。px4_drv の
デバイスは名前から(PX-W3/Q3 は 4 つ単位で 衛星、衛星、地デジ、地デジ)、DVB アダプターはフロントエンドの
報告から。続いて Mirakurun の起動後にチャンネルをスキャンし、最後に一度だけ Mirakurun を再起動して読み込ませます
(チャンネル一覧が変わると Mirakurun は EPG を捨てるので、部分ごとに再起動すると、先に見つかったチャンネルの番組が
消えてしまいます)。何も見つからなかった場合(アンテナ未接続?)は次の起動時にもう一度スキャンします。

**チャンネル。** 地デジは UHF 13〜62 と、ケーブルテレビ向けにケーブル周波数 C13〜C63(パススルー。
`JELLYSTATION_CATV=false` で省略)、さらに BS と 110 度 CS の全チャンネルをスキャンします。WOWOW、スターチャンネル、
スカパー!などの有料チャンネルも含みます。有料チャンネルは B-CAS カードに契約があれば映ります。ケーブル会社の
セットトップボックス経由でしか届かないもの(トランスモジュレーション)と、スカパー!プレミアム(124/128 度)は
別のハードウェアが必要で、対応していません。

**チューナーの追加・変更。** 新しいデバイスを渡し(`jellystation-compose` をもう一度実行するか、`compose.yaml` の
`devices:` に追加)、`sudo docker compose up -d`。`sudo docker exec jellystation jellystation-tuners` で見つかる
ものを確認し、`sudo docker exec jellystation jellystation-tuners --write` で `tuners.yml` を書き換えて(元のものは
`tuners.yml.bak` に残ります)`sudo docker compose restart`。スキャンし直すには再起動前に
`config/mirakurun/channels.yml` と `tuners.yml` を削除するか、Mirakurun のスキャン API を使います。選局コマンドは
`/opt/jellystation/bin/tune DEVICE <type> <channel>` で、`JELLYSTATION_RECISDB_ARGS` で recisdb のオプションを
追加できます(チューナーからアンテナに給電する場合の `--lnb 15v` など)。

## compose ファイル

`jellystation-compose`(手順 3)が書いてくれます。自分で書く場合は、持っているチューナーの `devices:` の行だけを
残します(書いたデバイスがないと Docker は起動しません):

```yaml
services:
  jellystation:
    image: ghcr.io/myfeethurt/jellystation:latest
    container_name: jellystation
    restart: unless-stopped
    stop_grace_period: 30s # time to finish recordings and close databases (Docker's 10 s is too short)
    cap_add:
      - SYS_NICE # Mirakurun raises its own priority
    environment:
      TZ: Asia/Tokyo
      JELLYSTATION_JELLYFIN_PASSWORD: change-me # Jellyfin login admin / this, set on the first start
    devices:
      - /dev/px4video0:/dev/px4video0 # PLEX PX-W3U4 / PX-Q3U4 / ... (px4_drv): one line per /dev/px4video*
      - /dev/px4video1:/dev/px4video1
      - /dev/px4video2:/dev/px4video2
      - /dev/px4video3:/dev/px4video3
      # - /dev/dvb:/dev/dvb       # PT1/PT2/PT3, PX-S1UD and other DVB tuners
      - /dev/bus/usb:/dev/bus/usb # B-CAS card reader
      # - /dev/dri:/dev/dri       # Intel/AMD GPU for Jellyfin hardware transcoding
    ports:
      - "8096:8096"   # Jellyfin
      - "8888:8888"   # EPGStation
      - "40772:40772" # Mirakurun
    volumes:
      - ./config:/config
      - ./cache:/cache
      - ./media:/media # recordings and the Jellyfin library: one filesystem (hardlinks)
```

Fedora など SELinux のシステムで Fedora の docker パッケージを使う場合は、各 volume に `:z` を付けます
(`./config:/config:z`)。

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
  次の :20/:50 を待つことはありません。チャンネルのロゴは各チャンネルを選局して取ります(Mirakurun の
  `LOGO_DATA_INTERVAL`)。リモートチューナーではチューナーサーバーのチューナーを使うので、チューナーサーバーがほかの
  録画もしている場合は `LOGO_DATA_INTERVAL: "999999999"`(ロゴなし)がおすすめです。
- Mirakurun、EPGStation、Jellyfin は改変せずに動かしています。JellyStation が加えるのは設定と自前の補助スクリプト
  だけです。
- **字幕。** jellyfin-ffmpeg には ARIB 字幕のデコーダーがないので、イメージには
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds) の静的な ffmpeg(`/opt/ffmpeg-arib`、libaribcaption
  入り)を追加しており、librarian だけが使います。ARIB 字幕には表示時間がないので `-fix_sub_duration` で
  デコードします。ライブ TV には字幕はありません。`JELLYSTATION_SUBTITLES` を変えると、ライブラリにある録画にも
  新しいファイルが追加されます。

## 開発

`dev/compose.yaml` は別の Mirakurun をリモートチューナーとして使う構成です。`node --test tests/*.test.js` で librarian の
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
