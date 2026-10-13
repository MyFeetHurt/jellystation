"""Screen recording helpers for the demo: Chrome's screencast (CDP) at high JPEG quality, title cards rendered as
HTML in the same page, and a caption overlay. frames/ + frames.txt become a video with make_video.sh.

The screencast only sends a frame when the page changes; each frame is shown until the next one (ffmpeg concat
durations), so still scenes cost nothing.
"""
import base64, html, pathlib, time

W, H = 1920, 1080
CARD_CSS = """
body{margin:0;width:1920px;height:1080px;background:radial-gradient(ellipse at 20% 0%,#1f2f4d 0%,#111a2c 55%,#0b1120 100%);
 color:#e8edf5;font-family:'Noto Sans CJK JP','Noto Sans JP',sans-serif;overflow:hidden}
.wrap{position:absolute;left:120px;top:120px;right:120px}
h1{font-size:64px;font-weight:700;margin:0 0 12px}
h1 .x{color:#5b9bff}
.en{font-size:30px;color:#8fa1bd;margin:0 0 48px}
.big{font-size:150px;font-weight:700;letter-spacing:-2px;margin:220px 0 10px}
.big .x{color:#5b9bff}
.sub{font-size:44px;color:#c9d4e6;margin:0 0 8px}
.subsub{font-size:28px;color:#8fa1bd}
pre{font-family:'Noto Sans Mono CJK JP',monospace;font-size:27px;line-height:1.55;background:#0a0f1a;border:1px solid #24324d;
 border-radius:14px;padding:30px 38px;margin:0;color:#c8d3e6;white-space:pre}
.k{color:#7fb2ff}.g{color:#7ee0a1}.y{color:#ffd479}.d{color:#6b7a94}
ul{margin:0;padding:0;list-style:none}
li{font-size:36px;margin:0 0 26px;padding-left:34px;position:relative}
li:before{content:'';position:absolute;left:0;top:18px;width:12px;height:12px;border-radius:6px;background:#5b9bff}
li small{display:block;font-size:24px;color:#8fa1bd;margin-top:4px}
.row{display:flex;gap:60px;align-items:flex-start}
"""
CAPTION_JS = """(text) => {
  let el = document.getElementById('__demo_caption');
  if (!text) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div'); el.id = '__demo_caption';
    el.style.cssText = 'position:fixed;left:28px;bottom:28px;z-index:2147483647;background:rgba(10,14,22,.86);color:#fff;' +
      'font:600 30px "Noto Sans CJK JP",sans-serif;padding:12px 22px;border-radius:8px;pointer-events:none;' +
      'box-shadow:0 4px 18px rgba(0,0,0,.35)';
    document.documentElement.appendChild(el);
  }
  el.textContent = text;
}"""


CURSOR_JS = """([x, y]) => {
  let c = document.getElementById('__demo_cursor');
  if (!c) {
    c = document.createElement('div'); c.id = '__demo_cursor';
    c.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.5 4 8-3 1.5-4-8L4 19z" ' +
      'fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
    c.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))';
    document.documentElement.appendChild(c);
  }
  c.style.left = (x - 4) + 'px'; c.style.top = (y - 2) + 'px';
}"""
RIPPLE_JS = """([x, y]) => {
  const r = document.createElement('div');
  r.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:22px;` +
    'border:3px solid rgba(91,155,255,.9);z-index:2147483646;pointer-events:none;transition:all .45s ease-out;opacity:1';
  document.documentElement.appendChild(r);
  requestAnimationFrame(() => { r.style.transform = 'scale(1.8)'; r.style.opacity = '0'; });
  setTimeout(() => r.remove(), 600);
}"""


class Recorder:
    def __init__(self, page, out):
        self.page, self.out = page, pathlib.Path(out)
        (self.out / 'frames').mkdir(parents=True, exist_ok=True)
        self.frames = []  # (recording time, file); time spent paused is left out
        self.offset, self.paused_at = 0.0, None
        self.cursor = (W / 2, H / 2)
        self.cdp = page.context.new_cdp_session(page)
        self.cdp.on('Page.screencastFrame', self._frame)
        self.caption_text = None

    def _frame(self, ev):
        # always acknowledge: without an ack Chrome sends no more frames
        try:
            self.cdp.send('Page.screencastFrameAck', {'sessionId': ev['sessionId']})
        except Exception:
            pass
        if self.paused_at is not None:
            return
        f = self.out / 'frames' / f'{len(self.frames):06d}.jpg'
        f.write_bytes(base64.b64decode(ev['data']))
        self.frames.append((time.time() - self.offset, f.name))

    def start(self):
        self.cdp.send('Page.startScreencast', {'format': 'jpeg', 'quality': 92, 'maxWidth': W, 'maxHeight': H, 'everyNthFrame': 1})

    def pause(self):
        """Stop recording (page loads, logins); the video continues from the last frame."""
        if self.paused_at is None:
            self.paused_at = time.time()

    def resume(self, settle=0.3):
        if self.paused_at is not None:
            self.offset += time.time() - self.paused_at
            self.paused_at = None
            self.page.evaluate("document.documentElement.style.outline='0px solid transparent'")  # force a frame
            if self.caption_text:
                self.page.evaluate(CAPTION_JS, self.caption_text)
            self.page.evaluate(CURSOR_JS, list(self.cursor))
            self.hold(settle)

    def move(self, x, y, seconds=0.6):
        """Move the drawn cursor to x, y."""
        x0, y0 = self.cursor
        steps = max(int(seconds * 30), 1)
        for i in range(1, steps + 1):
            t = i / steps
            t = t * t * (3 - 2 * t)
            self.page.evaluate(CURSOR_JS, [x0 + (x - x0) * t, y0 + (y - y0) * t])
            self.page.wait_for_timeout(1000 / 30)
        self.cursor = (x, y)

    def click(self, locator, seconds=0.6, after=0.4, at=(0.5, 0.5)):
        """Move the cursor to an element (at = fraction of its width and height), click there, show a ripple."""
        locator.scroll_into_view_if_needed()
        box = locator.bounding_box()
        px, py = box['width'] * at[0], box['height'] * at[1]
        x, y = box['x'] + px, box['y'] + py
        self.move(x, y, seconds)
        self.page.evaluate(RIPPLE_JS, [x, y])
        locator.click(position={'x': px, 'y': py})
        self.hold(after)

    def click_at(self, x, y, seconds=0.6, after=0.4):
        """Move the cursor to x, y and click there."""
        self.move(x, y, seconds)
        self.page.evaluate(RIPPLE_JS, [x, y])
        self.page.mouse.click(x, y)
        self.hold(after)

    def hold(self, seconds):
        """Let time pass while recording (keeps handling screencast events)."""
        end = time.time() + seconds
        while time.time() < end:
            self.page.wait_for_timeout(50)

    def caption(self, text):
        """Caption box at the bottom left; survives only until the next navigation (call again after goto)."""
        self.caption_text = text
        self.page.evaluate(CAPTION_JS, text)

    def card(self, body, seconds):
        """A full-screen title card for `seconds`."""
        self.page.set_content(f'<!doctype html><html><head><meta charset="utf-8"><style>{CARD_CSS}</style></head>'
                              f'<body>{body}</body></html>')
        # nudge a repaint so the screencast sends the card even if nothing animates
        self.page.evaluate("document.body.style.opacity='0.999'")
        self.hold(0.1)
        self.page.evaluate("document.body.style.opacity='1'")
        self.hold(seconds)

    def stop(self):
        self.cdp.send('Page.stopScreencast')
        self.hold(0.3)
        lines, frames = [], self.frames
        for i, (t, name) in enumerate(frames):
            nxt = frames[i + 1][0] if i + 1 < len(frames) else t + 1.0
            lines += [f"file 'frames/{name}'", f'duration {max(nxt - t, 0.001):.4f}']
        lines.append(f"file 'frames/{frames[-1][1]}'")
        (self.out / 'frames.txt').write_text('\n'.join(lines) + '\n')
        return len(frames)


esc = html.escape
