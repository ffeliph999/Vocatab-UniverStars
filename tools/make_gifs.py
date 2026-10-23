"""README 用の GIF を作る: ヘッドレス Chrome でエディタを台本どおりに操作し、画面を撮って GIF にする（Pillow。ffmpeg は要らない）。

    python tools/make_gifs.py [--out docs/gif] [--only 01 03] [--fps 8] [--width 800]

このフォルダを http で配り（ポート 8103）、Chrome（CDP、ポート 9338）で ui/ を開き、マウスとキーの操作を CDP で送る。
偽のカーソルと字幕はページに差し込んで描く。1 本 10〜20 秒。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import aiohttp
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HTTP_PORT, CDP_PORT = 8103, 9338
W, H = 1280, 800

INJECT = """(() => {
  if (document.getElementById('__cur')) return 'ok';
  const s = document.createElement('style');
  s.textContent = `#__cur{position:fixed;left:0;top:0;width:22px;height:30px;pointer-events:none;z-index:99999;
      transition:transform .08s linear;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6))}
    #__cur.down svg path{fill:#ffd166}
    #__cap{position:fixed;left:50%;bottom:34px;transform:translateX(-50%);padding:8px 18px;border-radius:999px;
      background:rgba(11,13,22,.88);color:#fff;font:600 16px 'Hiragino Sans',sans-serif;z-index:99998;pointer-events:none;
      border:1px solid rgba(144,157,255,.5);white-space:nowrap;opacity:0;transition:opacity .2s}
    #__cap.on{opacity:1}`;
  document.head.appendChild(s);
  const c = document.createElement('div'); c.id = '__cur';
  c.innerHTML = '<svg viewBox="0 0 22 30" width="22" height="30"><path d="M2 2 L2 24 L8 18 L12 28 L16 26 L12 17 L20 17 Z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>';
  document.body.appendChild(c);
  const cap = document.createElement('div'); cap.id = '__cap'; document.body.appendChild(cap);
  window.__cur = (x, y, down) => { c.style.transform = `translate(${x}px,${y}px)`; c.classList.toggle('down', !!down); };
  window.__cap = (t) => { cap.textContent = t; cap.classList.toggle('on', !!t); };
  return 'ok';
})()"""

WAIT_DONE = """(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    const s = document.querySelector('.engine-state')?.textContent ?? '';
    if (s.includes('レンダリング完了')) return s;
    await new Promise(r => setTimeout(r, 200));
  }
  return 'timeout';
})()"""


class Page:
    def __init__(self, ws, fps: int):
        self.ws, self.fps = ws, fps
        self.n = 0
        self.frames: list[Image.Image] = []
        self.recording = False
        self.paused = False
        self.mouse = (W / 2, H / 2)
        self._task: asyncio.Task | None = None
        # 返事は 1 本の読み取りの仕事が受けて id ごとに配る（撮影と操作が同時に呼ぶため。receive は 1 つしか居られない）
        self.pending: dict[int, asyncio.Future] = {}
        self._reader = asyncio.create_task(self._read())

    async def _read(self):
        async for msg in self.ws:
            if msg.type != aiohttp.WSMsgType.TEXT:
                break
            m = json.loads(msg.data)
            fut = self.pending.pop(m.get("id"), None)
            if fut and not fut.done():
                fut.set_result(m)

    async def close(self):
        self._reader.cancel()

    async def call(self, method, params=None):
        self.n += 1
        fut = asyncio.get_running_loop().create_future()
        self.pending[self.n] = fut
        await self.ws.send_json({"id": self.n, "method": method, "params": params or {}})
        m = await fut
        if "error" in m:
            raise RuntimeError(f"{method}: {m['error']}")
        return m.get("result", {})

    async def ev(self, expr: str):
        r = await self.call("Runtime.evaluate", {"expression": expr, "awaitPromise": True, "returnByValue": True})
        return r.get("result", {}).get("value")

    async def shot(self) -> Image.Image:
        r = await self.call("Page.captureScreenshot", {"format": "jpeg", "quality": 85})
        return Image.open(io.BytesIO(base64.b64decode(r["data"]))).convert("RGB")

    # ── 録画: 一定の間隔で撮る（操作の間も撮れるよう、操作は await の合間に進む） ──
    async def _rec(self):
        period = 1 / self.fps
        nxt = time.monotonic()
        while self.recording:
            if self.paused:  # エンジンの待ちの間は撮らない（撮影が CPU を取ってレンダリングが遅くなり、GIF も間延びする）
                await asyncio.sleep(0.1)
                nxt = time.monotonic()
                continue
            try:
                self.frames.append(await self.shot())
            except Exception as e:
                print("撮れなかった:", e)
            nxt += period
            await asyncio.sleep(max(0.0, nxt - time.monotonic()))

    async def wait_done(self):
        """レンダリングが済むまで待つ（その間は撮らない）"""
        self.paused = True
        try:
            await self.ev(WAIT_DONE)
        finally:
            self.paused = False

    def start(self):
        self.frames = []
        self.recording = True
        self._task = asyncio.create_task(self._rec())

    async def stop(self):
        self.recording = False
        if self._task:
            await self._task

    async def hold(self, sec: float):
        """撮りながら待つ"""
        await asyncio.sleep(sec)

    # ── 操作 ──
    async def cap(self, text: str):
        await self.ev(f"window.__cap({json.dumps(text)})")

    async def rect(self, selector: str, nth: int = 0) -> dict:
        r = await self.ev(f"""(() => {{ const e = document.querySelectorAll({json.dumps(selector)})[{nth}]; if (!e) return null;
            const r = e.getBoundingClientRect(); return {{x: r.left, y: r.top, w: r.width, h: r.height, cx: r.left + r.width / 2, cy: r.top + r.height / 2}}; }})()""")
        if not r:
            raise RuntimeError(f"要素が無い: {selector}[{nth}]")
        return r

    async def _mouse(self, kind: str, x: float, y: float, button="none", clicks=0, buttons=0):
        await self.call("Input.dispatchMouseEvent", {"type": kind, "x": x, "y": y, "button": button, "clickCount": clicks, "buttons": buttons})

    async def move(self, x: float, y: float, dur: float = 0.35, down=False):
        x0, y0 = self.mouse
        steps = max(2, int(dur * 40))
        for i in range(1, steps + 1):
            t = i / steps
            t = t * t * (3 - 2 * t)  # なめらかに
            px, py = x0 + (x - x0) * t, y0 + (y - y0) * t
            await self._mouse("mouseMoved", px, py, "left" if down else "none", 0, 1 if down else 0)
            await self.ev(f"window.__cur({px:.1f},{py:.1f},{'true' if down else 'false'})")
            await asyncio.sleep(dur / steps)
        self.mouse = (x, y)

    async def click(self, x: float, y: float, button="left", clicks=1):
        await self.move(x, y)
        await self._mouse("mousePressed", x, y, button, clicks, 1 if button == "left" else 2)
        await self.ev(f"window.__cur({x:.1f},{y:.1f},true)")
        await asyncio.sleep(0.08)
        await self._mouse("mouseReleased", x, y, button, clicks, 0)
        await self.ev(f"window.__cur({x:.1f},{y:.1f},false)")
        await asyncio.sleep(0.15)

    async def dblclick(self, x: float, y: float):
        await self.click(x, y)
        await self._mouse("mousePressed", x, y, "left", 2, 1)
        await self._mouse("mouseReleased", x, y, "left", 2, 0)
        await asyncio.sleep(0.15)

    async def drag(self, path: list[tuple[float, float]], dur: float = 1.0):
        x, y = path[0]
        await self.move(x, y)
        await self._mouse("mousePressed", x, y, "left", 1, 1)
        await self.ev(f"window.__cur({x:.1f},{y:.1f},true)")
        for px, py in path[1:]:
            await self.move(px, py, dur / max(1, len(path) - 1), down=True)
        await self._mouse("mouseReleased", x if len(path) == 1 else path[-1][0], y if len(path) == 1 else path[-1][1], "left", 1, 0)
        await self.ev(f"window.__cur({self.mouse[0]:.1f},{self.mouse[1]:.1f},false)")
        await asyncio.sleep(0.15)

    async def key(self, key: str, code: str | None = None, vk: int = 0, text: str | None = None):
        p = {"key": key, "code": code or key, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk}
        await self.call("Input.dispatchKeyEvent", {"type": "keyDown", **p, **({"text": text} if text else {})})
        await self.call("Input.dispatchKeyEvent", {"type": "keyUp", **p})
        await asyncio.sleep(0.1)

    async def type(self, text: str):
        await self.call("Input.insertText", {"text": text})
        await asyncio.sleep(0.2)


# ── 台本 ──

async def open_editor(pg: Page, query: str):
    await pg.call("Page.navigate", {"url": f"http://127.0.0.1:{HTTP_PORT}/ui/?{query}"})
    await asyncio.sleep(2.5)
    await pg.ev(INJECT)
    await pg.wait_done()
    await pg.ev("window.__svs.store.playTick = 0; window.__svs.store.changed('playhead')")
    await asyncio.sleep(0.5)


async def note_xy(pg: Page, tick: float, pitch: float) -> tuple[float, float]:
    r = await pg.rect("#pr-canvas")
    v = await pg.ev(f"(() => {{ const v = window.__svs.view; return [v.tickToX({tick}), v.pitchToY({pitch})]; }})()")
    return r["x"] + v[0], r["y"] + v[1]


async def scenario_01_notes(pg: Page):
    """鉛筆で音符を置き、歌詞を入れ、レンダリングされたら再生"""
    await open_editor(pg, "lang=ja&gif=1")
    # 5 小節目から見せる。置く音符（67〜71）が縦に収まるように上端の音高も合わせる（既定の 78 だと 67 が画面の下にはみ出す）
    await pg.ev("""(() => { const v = window.__svs.view; v.scrollTick = 480 * 4 * 4; v.topPitch = 75; v.scrollBy(0, 0); })()""")
    await asyncio.sleep(0.6)
    pg.start()
    await pg.cap("鉛筆（2）でドラッグして音符を置く")
    await pg.key("2", "Digit2", 50, "2")
    await pg.hold(0.3)
    notes = [(480 * 4 * 6, 480, 67, "さ"), (480 * 4 * 6 + 480, 480, 69, "く"), (480 * 4 * 6 + 960, 960, 71, "ら")]
    for tick, dur, pitch, _ in notes:
        x0, y = await note_xy(pg, tick, pitch)
        x1, _ = await note_xy(pg, tick + dur, pitch)
        await pg.drag([(x0 + 3, y), (x1 - 3, y)], 0.5)
        await pg.hold(0.3)
    await pg.cap("ダブルクリックで歌詞を入れる（かな・ローマ字・音素）")
    await pg.key("1", "Digit1", 49, "1")
    await pg.hold(0.3)
    for tick, dur, pitch, lyric in notes:
        x, y = await note_xy(pg, tick + dur / 2, pitch)
        await pg.dblclick(x, y)
        await pg.hold(0.3)
        await pg.type(lyric)
        await pg.hold(0.3)
        await pg.key("Enter", "Enter", 13)
        await pg.hold(0.3)
    await pg.cap("少し待つと自動でレンダリングされる")
    await pg.wait_done()
    await pg.hold(0.6)
    await pg.cap("Space で再生")
    await pg.ev("window.__svs.store.playTick = 480 * 4 * 5; window.__svs.store.changed('playhead')")
    await pg.key(" ", "Space", 32, " ")
    await pg.hold(4.0)
    await pg.key(" ", "Space", 32, " ")
    await pg.cap("")
    await pg.hold(0.5)
    await pg.stop()


async def scenario_02_pitch(pg: Page):
    """ピッチのペンで線を描き、パラメータの曲線でも調整"""
    await open_editor(pg, "lang=ja&gif=1")
    pg.start()
    await pg.cap("ピッチのペン（3）でピッチの線をなぞる")
    await pg.key("3", "Digit3", 51, "3")
    # 「ら」（B4 = 71、3 拍目から 2 拍）の上をうねらせる
    pts = []
    t0, t1 = 480 * 4 + 480 * 2, 480 * 4 + 480 * 4
    for i in range(0, 25):
        tick = t0 + (t1 - t0) * i / 24
        pitch = 71 + 0.7 * __import__("math").sin(i / 24 * 6.28 * 2)
        pts.append(await note_xy(pg, tick, pitch))
    await pg.drag(pts, 1.6)
    await pg.cap("離すとその部分だけレンダリングし直す")
    await pg.wait_done()
    await pg.hold(0.8)
    await pg.cap("パラメータのパネルでは曲線を描ける（抑揚・ビブラート・音量…）")
    r = await pg.rect(".param-panel canvas")
    x0, x1 = r["x"] + r["w"] * 0.25, r["x"] + r["w"] * 0.55
    ymid = r["y"] + r["h"] * 0.5
    pts = [(x0 + (x1 - x0) * i / 20, ymid - r["h"] * 0.28 * __import__("math").sin(i / 20 * 3.14)) for i in range(21)]
    await pg.drag(pts, 1.4)
    await pg.hold(1.5)
    await pg.cap("")
    await pg.hold(0.3)
    await pg.stop()


async def scenario_03_retake(pg: Page):
    """音符の小窓でリテイク"""
    await open_editor(pg, "lang=ja&gif=1")
    pg.start()
    await pg.cap("音符をクリックすると小窓が開く")
    x, y = await note_xy(pg, 480 * 4 + 480 * 3, 71)
    await pg.click(x, y)
    await pg.hold(0.8)
    await pg.cap("「リテイク」で、その音符だけ AI の生成をやり直す（ピッチ・声）")
    b = await pg.rect(".note-pop .retake-row button.small.primary", 0)
    await pg.click(b["cx"], b["cy"])
    await pg.wait_done()
    await pg.hold(1.0)
    b = await pg.rect(".note-pop .retake-row button.small.primary", 1)
    await pg.click(b["cx"], b["cy"])
    await pg.wait_done()
    await pg.hold(1.0)
    await pg.cap("「一つ前」「最初」で戻せる")
    b = await pg.rect(".note-pop .retake-row button.small", 1)
    await pg.click(b["cx"], b["cy"])
    await pg.wait_done()
    await pg.hold(1.0)
    await pg.cap("")
    await pg.hold(0.4)
    await pg.stop()


async def scenario_04_breath_fx(pg: Page):
    """ブレスを入れ、エフェクターを掛ける"""
    await open_editor(pg, "lang=ja&gif=1")
    await pg.ev("(async () => { const t0 = Date.now(); while (Date.now() - t0 < 10000) { if (window.__svs.derived().breaths.length) return 'ok'; await new Promise(r => setTimeout(r, 200)); } return 'no'; })()")
    pg.start()
    await pg.cap("音素のタイミングの「+ br」をクリックするとブレスが入る")
    b = await pg.ev("(() => { const d = window.__svs.derived(); const b = d.breaths[0]; const v = window.__svs.view; const spt = 60 / window.__svs.store.project.bpm / 480; return [v.tickToX((b.start + b.cut) / spt), v.tickToX(b.end / spt)]; })()")
    r = await pg.rect("#bottom-panels .bpanel canvas", 1)  # 2 つ目のパネル = 音素のタイミング
    await pg.click(r["x"] + (b[0] + b[1]) / 2, r["cy"])
    await pg.hold(1.5)
    await pg.cap("エフェクター: 声の地図の EQ、コンプレッサー、リバーブ")
    await pg.ev("document.querySelector('#side-body').scrollTo({top: 99999, behavior: 'smooth'})")
    await pg.hold(0.8)
    sw = await pg.rect(".side-sec .switch", 0)
    await pg.click(sw["cx"], sw["cy"])
    await pg.hold(0.5)
    eq = await pg.rect(".fx-graph", 0)
    px, py = eq["x"] + eq["w"] * 0.62, eq["y"] + eq["h"] * 0.5
    await pg.dblclick(px, py)
    await pg.hold(0.3)
    await pg.drag([(px, py), (px, py - eq["h"] * 0.22)], 0.6)
    await pg.hold(0.8)
    rv = await pg.rect(".fx-graph", 2)
    await pg.ev("document.querySelectorAll('.side-sec .switch')[2].click()")
    await pg.hold(0.4)
    await pg.cap("リバーブは残響の形を直接さわる（始まり・量・長さ）")
    # 量の点（山）を少し上へ
    await pg.drag([(rv["x"] + rv["w"] * 0.11, rv["y"] + rv["h"] * 0.4), (rv["x"] + rv["w"] * 0.11, rv["y"] + rv["h"] * 0.25)], 0.6)
    await pg.hold(1.2)
    await pg.cap("")
    await pg.hold(0.4)
    await pg.stop()


async def scenario_05_export(pg: Page):
    """WAV の書き出し"""
    await open_editor(pg, "lang=ja&gif=1")
    pg.start()
    await pg.cap("「書き出し」で WAV を書き出す（トラック別かミックス）")
    b = await pg.rect("#btn-export")
    await pg.click(b["cx"], b["cy"])
    await pg.hold(1.2)
    go = await pg.rect("#ex-go")
    await pg.ev("(async () => { const t0 = Date.now(); while (Date.now() - t0 < 60000) { const b = document.querySelector('#ex-go'); if (b && !b.disabled) return 'ok'; await new Promise(r => setTimeout(r, 200)); } return 'no'; })()")
    await pg.click(go["cx"], go["cy"])
    await pg.hold(2.5)
    await pg.cap("")
    await pg.hold(0.4)
    await pg.stop()


SCENARIOS = {"01_notes": scenario_01_notes, "02_pitch": scenario_02_pitch, "03_retake": scenario_03_retake,
             "04_breath_fx": scenario_04_breath_fx, "05_export": scenario_05_export}


def save_gif(frames: list[Image.Image], path: Path, fps: int, width: int):
    if not frames:
        print(f"{path.name}: フレームが無い")
        return
    scale = width / frames[0].width
    small = [f.resize((width, round(f.height * scale)), Image.LANCZOS) for f in frames]
    # 最初のフレームのパレットで全部を量子化（ちらつきを減らす）
    base = small[0].quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    pal = [f.quantize(colors=256, palette=base, dither=Image.Dither.FLOYDSTEINBERG) for f in small]
    pal[0].save(path, save_all=True, append_images=pal[1:], duration=round(1000 / fps), loop=0, optimize=True)
    print(f"{path}: {len(frames)} フレーム、{path.stat().st_size / 1e6:.1f} MB")


async def main_async(a):
    http = subprocess.Popen([sys.executable, "-m", "http.server", str(HTTP_PORT), "--bind", "127.0.0.1", "--directory", str(ROOT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    prof = tempfile.mkdtemp(prefix="gif_")
    chrome = subprocess.Popen([CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                               f"--remote-debugging-port={CDP_PORT}", f"--user-data-dir={prof}", f"--window-size={W},{H}",
                               "--hide-scrollbars", "--autoplay-policy=no-user-gesture-required", "--force-device-scale-factor=1",
                               "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tabs = []
        for _ in range(60):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json").read())
                break
            except Exception:
                await asyncio.sleep(0.25)
        ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
        async with aiohttp.ClientSession() as s, s.ws_connect(ws_url, max_msg_size=0) as ws:
            pg = Page(ws, a.fps)
            await pg.call("Emulation.setDeviceMetricsOverride", {"width": W, "height": H, "deviceScaleFactor": 1, "mobile": False})
            out = Path(a.out)
            out.mkdir(parents=True, exist_ok=True)
            for name, fn in SCENARIOS.items():
                if a.only and not any(name.startswith(o) for o in a.only):
                    continue
                print(f"── {name}")
                try:
                    await fn(pg)
                except Exception as e:
                    await pg.stop()
                    print(f"{name}: 失敗 {e!r}")
                    if a.debug:
                        (out / f"{name}_fail.png").write_bytes(base64.b64decode((await pg.call("Page.captureScreenshot"))["data"]))
                    continue
                save_gif(pg.frames, out / f"{name}.gif", a.fps, a.width)
                if a.debug and pg.frames:
                    pg.frames[len(pg.frames) // 2].save(out / f"{name}_mid.png")
            await pg.close()
    finally:
        chrome.terminate()
        http.terminate()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "gif"))
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--fps", type=int, default=8)
    ap.add_argument("--width", type=int, default=800)
    ap.add_argument("--debug", action="store_true", help="途中のフレームと失敗時の画面を PNG でも書く")
    asyncio.run(main_async(ap.parse_args()))


if __name__ == "__main__":
    main()
