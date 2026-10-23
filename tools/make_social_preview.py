"""GitHub の Social preview（1280x640 の PNG）を作る。

    python tools/make_social_preview.py [--out docs/social_preview.png]

英語 UI のエディタをヘッドレス Chrome で開き、見本曲のレンダリング（モデルの先読みと mel の計算まで）が終わった画面を撮って、
tools/social_preview.html（ブラウザの窓のまね＋文字）に流し込み、2 倍で撮ってから 1280x640 に縮める。
できた PNG は GitHub の Settings → Social preview にアップロードする（推奨 1280x640、1 MB 未満）。
Chrome と CDP の部品は make_gifs.py のもの。
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import io
import json
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

import aiohttp
from PIL import Image

import make_gifs as mg

ROOT = Path(__file__).resolve().parents[1]
HTML = Path(__file__).with_name("social_preview.html")

# レンダリング完了（英語 UI は "Rendered"）に加え、モデルの先読みと mel の計算も終わるまで待つ
WAIT_IDLE = """(async () => {
  const t0 = Date.now();
  while (Date.now() - t0 < 240000) {
    const st = document.querySelector('.engine-state')?.textContent ?? '';
    const body = document.body.innerText;
    const loading = /Loading models|モデルを読み込|読み込み中/.test(body);
    const computing = /Computing|計算中/.test(body);
    if ((st.includes('Rendered') || st.includes('レンダリング完了')) && !loading && !computing) return st;
    await new Promise(r => setTimeout(r, 300));
  }
  return 'timeout: ' + (document.querySelector('.engine-state')?.textContent ?? '');
})()"""

# 画面の整え: 2 小節目から、音符が縦に収まる高さ、再生位置は 3 小節目の途中、「実験版」の札は隠す
SETUP = """(() => { const v = window.__svs.view; v.scrollTick = 480 * 4; v.topPitch = 74; v.scrollBy(0, 0);
  const s = window.__svs.store; s.playTick = 480 * 4 * 3 + 240; s.changed('playhead');
  const tag = document.querySelector('.brand .tag'); if (tag) tag.style.display = 'none'; return 'ok'; })()"""


async def run(out: Path) -> None:
    work = Path(tempfile.mkdtemp(prefix="social_"))
    shutil.copy(HTML, work / HTML.name)
    http = subprocess.Popen([sys.executable, "-m", "http.server", str(mg.HTTP_PORT), "--bind", "127.0.0.1", "--directory", str(ROOT)],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    chrome = subprocess.Popen([mg.CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                               f"--remote-debugging-port={mg.CDP_PORT}", f"--user-data-dir={work / 'profile'}", "--window-size=1280,800",
                               "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        tabs: list[dict] = []
        for _ in range(60):
            try:
                tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{mg.CDP_PORT}/json").read())
                break
            except Exception:
                await asyncio.sleep(0.25)
        ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
        async with aiohttp.ClientSession() as s, s.ws_connect(ws_url, max_msg_size=0) as ws:
            pg = mg.Page(ws, 8)
            # 1. エディタの画面（2 倍の解像度で）
            await pg.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 800, "deviceScaleFactor": 2, "mobile": False})
            await pg.call("Page.navigate", {"url": f"http://127.0.0.1:{mg.HTTP_PORT}/ui/?lang=en"})
            await asyncio.sleep(2.5)
            print("render:", await pg.ev(WAIT_IDLE))
            await pg.ev(SETUP)
            await asyncio.sleep(1.0)
            await pg.ev(WAIT_IDLE)
            await asyncio.sleep(0.5)
            r = await pg.call("Page.captureScreenshot", {"format": "png"})
            (work / "editor_shot.png").write_bytes(base64.b64decode(r["data"]))
            # 2. 下絵に流し込んで撮る
            await pg.call("Emulation.setDeviceMetricsOverride", {"width": 1280, "height": 640, "deviceScaleFactor": 2, "mobile": False})
            await pg.call("Page.navigate", {"url": f"file://{work / HTML.name}"})
            await asyncio.sleep(1.5)
            r = await pg.call("Page.captureScreenshot", {"format": "png"})
            im = Image.open(io.BytesIO(base64.b64decode(r["data"]))).convert("RGB").resize((1280, 640), Image.LANCZOS)
            out.parent.mkdir(parents=True, exist_ok=True)
            im.save(out, optimize=True)
            print(f"{out}: {im.size[0]}x{im.size[1]}, {out.stat().st_size // 1024} KB")
            await pg.close()
    finally:
        chrome.terminate()
        http.terminate()
        shutil.rmtree(work, ignore_errors=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "docs" / "social_preview.png"))
    a = ap.parse_args()
    asyncio.run(run(Path(a.out)))


if __name__ == "__main__":
    main()
