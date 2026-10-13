#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.55.0"]
# ///
"""Records the README demo from a running JellyStation (Chromium with H.264, e.g. Arch's /usr/bin/chromium).

  demo.py OUT_DIR [--host 192.168.0.137] [--jellyfin 18096] [--epgstation 18888] [--user admin --password ...]
  then:  make_video.sh OUT_DIR media/

Uses what is in the stack: the series, episode, film and channel below (change them for another stack). Only free
channels are shown. The EPGStation scene opens a programme's reservation dialog and closes it again (no reservation).
"""
import argparse, json, pathlib, sys, urllib.parse, urllib.request

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from playwright.sync_api import sync_playwright  # noqa: E402
from rec import Recorder, esc  # noqa: E402

SERIES = '豊臣兄弟!'
EPISODE_CONTAINS = '茶々の本心'
MOVIE = '日本女侠伝 真赤な度胸花'
CHANNEL_NUMBER = '101.1'         # NHK BS

LOG = """<span class="d">$ docker compose up -d</span>
tuner devices:
  PX4-S0: /dev/px4video0 <span class="k">(BS, CS)</span>
  PX4-S1: /dev/px4video1 <span class="k">(BS, CS)</span>
  PX4-T2: /dev/px4video2 <span class="k">(GR)</span>
  PX4-T3: /dev/px4video3 <span class="k">(GR)</span>
<span class="g">found 4 tuners (2 terrestrial, 2 satellite)</span>
<span class="g">B-CAS card reader: found</span>
channel scan GR done: <span class="y">11 channels</span>
channel scan BS done: <span class="y">75 channels</span>
channel scan CS done: <span class="y">47 channels</span>
<span class="g">Live TV guide refresh started</span>"""


def card_title():
    return ('<div class="wrap"><div class="big">Jelly<span class="x">Station</span></div>'
            '<div class="sub">Mirakurun・EPGStation・Jellyfin を、ひとつのコンテナに</div>'
            '<div class="subsub">Japanese TV in Jellyfin, from one Docker container</div></div>')


def card_setup():
    return ('<div class="wrap"><h1>チューナーを渡すだけ</h1><div class="en">Pass in your tuners: JellyStation does the rest</div>'
            f'<div class="row"><pre>{LOG}</pre><ul>'
            '<li>チューナーを自動で検出<small>PLEX PX-W3U4 / Q3U4 / MLT, PT3 など</small></li>'
            '<li>recisdb で選局、B-CAS で復号<small>Tuned with recisdb, descrambled with your card</small></li>'
            '<li>地デジ・CATV・BS・CS をスキャン<small>Terrestrial, cable, BS and CS</small></li>'
            '<li>ライブTV の番組表もそのまま<small>Jellyfin Live TV with Mirakurun’s guide</small></li>'
            '</ul></div></div>')


def card_library(examples):
    rows = ''.join(f'<span class="d">{esc(a)}</span>\n→ <span class="g">{esc(b)}</span>\n\n' for a, b in examples)
    return ('<div class="wrap"><h1>録画が終わると、Jellyfin のライブラリへ</h1>'
            '<div class="en">Finished recordings land in Jellyfin’s TV and movie libraries</div>'
            f'<div class="row"><pre>{rows.rstrip()}</pre><ul>'
            '<li>番組情報から NFO<small>Title, episode, plot, cast and genres from the EPG</small></li>'
            '<li>サムネイルとポスター<small>Thumbnails and series artwork</small></li>'
            '<li>ARIB 字幕を .srt に<small>Captions as subtitles for every client</small></li>'
            '<li>ハードリンクで容量そのまま<small>Hardlinks: no extra disk</small></li>'
            '</ul></div></div>')


def card_end():
    return ('<div class="wrap"><div class="big">Jelly<span class="x">Station</span></div>'
            '<div class="sub">録画・ライブラリ・ライブTV を、ひとつに</div>'
            '<div class="subsub">Mirakurun + EPGStation + Jellyfin, unmodified: JellyStation only adds configuration</div>'
            '<div class="subsub" style="margin-top:40px">github.com/MyFeetHurt/jellystation</div></div>')


class Jf:
    """Jellyfin API, to find the items to show."""
    def __init__(self, base, user, password):
        self.base = base
        auth = self.call('POST', '/Users/AuthenticateByName', {'Username': user, 'Pw': password})
        self.token, self.user = auth['AccessToken'], auth['User']['Id']

    def call(self, method, path, body=None):
        hdr = 'MediaBrowser Client="demo", Device="demo", DeviceId="jellystation-demo", Version="1"'
        if getattr(self, 'token', None):
            hdr += f', Token="{self.token}"'
        req = urllib.request.Request(self.base + path, data=json.dumps(body).encode() if body is not None else None,
                                     method=method, headers={'Authorization': hdr, 'Content-Type': 'application/json'})
        with urllib.request.urlopen(req, timeout=60) as r:
            data = r.read()
        return json.loads(data) if data else None

    def items(self, **q):
        q = {'Recursive': 'true', 'userId': self.user, **q}
        return self.call('GET', '/Items?' + urllib.parse.urlencode(q))['Items']


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--host', default='192.168.0.137')
    ap.add_argument('--jellyfin', default='18096')
    ap.add_argument('--epgstation', default='18888')
    ap.add_argument('--user', default='admin')
    ap.add_argument('--password', default='jellystation-dev')
    ap.add_argument('--channel', default=CHANNEL_NUMBER, help='Live TV channel number to play (pick one with a suitable programme on air)')
    ap.add_argument('--shots', action='store_true', help='also save a screenshot per scene')
    a = ap.parse_args()
    jf_url, epgs_url = f'http://{a.host}:{a.jellyfin}', f'http://{a.host}:{a.epgstation}'
    out = pathlib.Path(a.out)

    jf = Jf(jf_url, a.user, a.password)
    views = {v['CollectionType']: v['Id'] for v in jf.call('GET', f'/UserViews?userId={jf.user}')['Items'] if v.get('CollectionType')}
    series = next(i for i in jf.items(IncludeItemTypes='Series') if i['Name'] == SERIES)
    episode = next(i for i in jf.items(IncludeItemTypes='Episode', ParentId=series['Id']) if EPISODE_CONTAINS in i['Name'])
    movie = next(i for i in jf.items(IncludeItemTypes='Movie') if i['Name'] == MOVIE)
    # earlier runs leave a resume point: start the episode unwatched
    jf.call('POST', f'/UserItems/{episode["Id"]}/UserData?userId={jf.user}', {'PlaybackPositionTicks': 0, 'Played': False})
    channel = next(c for c in jf.call('GET', f'/LiveTv/Channels?userId={jf.user}&limit=500')['Items'] if c.get('Number') == a.channel)
    examples = [('豊臣兄弟！（３９）茶々の本心[解][字]', f'テレビ番組/豊臣兄弟!/豊臣兄弟! - 2026-10-11 2000 - 茶々の本心.m2ts'),
                ('テレビアニメ「鬼滅の刃」シリーズ全編再放送[字][解][デ]【無限列車編】', 'テレビ番組/鬼滅の刃/鬼滅の刃 - 2026-10-11 0930 - 無限列車編.m2ts'),
                ('映画「日本女侠伝　真赤な度胸花」', '映画/日本女侠伝 真赤な度胸花/日本女侠伝 真赤な度胸花.m2ts')]

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium',
                                    args=['--autoplay-policy=no-user-gesture-required', '--hide-scrollbars'])
        page = browser.new_page(viewport={'width': 1920, 'height': 1080}, locale='ja-JP')
        r = Recorder(page, out)
        shot = (lambda name: page.screenshot(path=str(out / f'shot-{name}.png'))) if a.shots else (lambda name: None)

        def goto(url, wait_for=None, settle=2.5):
            r.pause()
            page.goto(url, wait_until='networkidle')
            if wait_for:
                page.wait_for_selector(wait_for, timeout=60000)
            page.wait_for_timeout(int(settle * 1000))
            r.resume()

        # log in to Jellyfin before recording starts
        page.goto(jf_url + '/web/#/login', wait_until='networkidle')
        page.wait_for_selector('#txtManualName:visible, button.btnManual:visible', timeout=60000)
        if not page.locator('#txtManualName').is_visible():
            page.locator('button.btnManual').click()
        page.fill('#txtManualName', a.user)
        page.fill('#txtManualPassword', a.password)
        page.locator('#txtManualPassword').press('Enter')
        page.wait_for_timeout(5000)

        r.start()
        r.card(card_title(), 4.5)
        r.card(card_setup(), 8)

        # EPGStation: guide, open a programme, close the dialog
        goto(epgs_url + '/#/guide?type=GR', wait_for='.programs', settle=3)
        r.caption('EPGStation・番組表から録画予約')
        r.hold(2)
        # the programme on air in the first column, just below the "now" line
        x, y = page.evaluate("""() => {
          const item = [...document.querySelectorAll('.programs .item')].map(e => [e, e.getBoundingClientRect()])
            .filter(([, b]) => b.left > 250 && b.width > 40 && b.top < 400 && b.bottom > 160)
            .sort((a, b) => a[1].left - b[1].left || a[1].top - b[1].top)[0][1];
          return [item.left + item.width / 2, Math.max(item.top, 120) + 40];
        }""")
        r.click_at(x, y, after=1.5)
        shot('epgs-dialog')
        reserve = page.locator('button:has-text("予約")').first
        if reserve.count():
            r.move(*_center(reserve), seconds=0.6)
            r.hold(1.5)
        page.keyboard.press('Escape')
        r.hold(0.8)
        r.caption(None)

        r.card(card_library(examples), 8)

        # Jellyfin TV library
        goto(f'{jf_url}/web/#/tv?topParentId={views["tvshows"]}', wait_for='.card:visible', settle=3)
        r.caption('Jellyfin・テレビ番組（ポスターも自動）')
        r.hold(3)
        shot('jf-tv')
        r.click(page.locator(f'.card[data-id="{series["Id"]}"]:visible').first, after=0, at=(0.5, 0.22))  # not the play button
        r.pause()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(2500)
        r.resume()
        r.caption('番組情報・話数は EPG から')
        r.hold(3)
        shot('jf-series')
        goto(f'{jf_url}/web/#/details?id={episode["Id"]}', wait_for='.btnPlay, button[data-action="resume"]', settle=2)
        r.caption('番組情報・話数は EPG から')
        r.hold(3)
        shot('jf-episode')
        play = page.locator('.mainDetailButtons :is(.btnPlay, [data-action="resume"]):visible').first
        r.click(play, after=0)
        r.pause()
        page.wait_for_selector('video', timeout=60000)
        page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 2; }", timeout=90000)
        page.evaluate("() => { const v = document.querySelector('video'); v.currentTime = 600; }")
        page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 603; }", timeout=90000)
        r.resume()
        r.caption('ARIB 字幕もそのまま表示')
        r.hold(7)
        shot('jf-play')
        r.caption(None)

        # Jellyfin movies
        goto(f'{jf_url}/web/#/movies?topParentId={views["movies"]}', wait_for='.card:visible', settle=3)
        r.caption('Jellyfin・映画（ポスターはオンラインから）')
        r.hold(3)
        shot('jf-movies')
        r.click(page.locator(f'.card[data-id="{movie["Id"]}"]:visible').first, after=0, at=(0.5, 0.22))
        r.pause()
        page.wait_for_load_state('networkidle')
        page.wait_for_timeout(2500)
        r.resume()
        r.hold(3)
        shot('jf-movie')

        # Live TV: guide, then one channel
        goto(f'{jf_url}/web/#/livetv?tab=1', wait_for='.channelPrograms, .programCell', settle=4)
        r.caption('ライブTV・Mirakurun の番組表とチャンネル')
        r.hold(4)
        shot('jf-guide')
        goto(f'{jf_url}/web/#/details?id={channel["Id"]}', wait_for='button.btnPlay.detailButton:visible', settle=2)
        r.click(page.locator('button.btnPlay.detailButton:visible').first, after=0)
        r.pause()
        page.wait_for_selector('video', timeout=60000)
        page.wait_for_function("() => { const v = document.querySelector('video'); return v && v.currentTime > 4; }", timeout=120000)
        r.resume()
        r.caption('ライブTV・地デジ / BS をそのまま視聴')
        r.hold(7)
        shot('jf-live')
        r.caption(None)
        r.pause()
        page.goto('about:blank')
        r.resume()

        r.card(card_end(), 5)
        n = r.stop()
        browser.close()
    print(f'{n} frames in {out}')


def _center(locator):
    box = locator.bounding_box()
    return box['x'] + box['width'] / 2, box['y'] + box['height'] / 2


if __name__ == '__main__':
    main()
