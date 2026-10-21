"""画面で楽譜を読み込ませる: ページを開き、楽譜のファイルを渡して importScore を呼び、描画が済んだら画面を撮る。
使い方: python cdp_import.py <楽譜> <画像の出力先>"""
import asyncio
import base64
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

import aiohttp

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
score, out_png = Path(sys.argv[1]), sys.argv[2]
port = 9334
prof = tempfile.mkdtemp(prefix="cdp_")
proc = subprocess.Popen([CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                         f"--remote-debugging-port={port}", f"--user-data-dir={prof}", "--window-size=1600,1000",
                         "--hide-scrollbars", "about:blank"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


async def main():
    for _ in range(50):
        try:
            tabs = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/json").read())
            break
        except Exception:
            await asyncio.sleep(0.2)
    ws_url = next(t["webSocketDebuggerUrl"] for t in tabs if t["type"] == "page")
    async with aiohttp.ClientSession() as s, s.ws_connect(ws_url, max_msg_size=0) as ws:
        n = 0

        async def call(method, params=None):
            nonlocal n
            n += 1
            await ws.send_json({"id": n, "method": method, "params": params or {}})
            while True:
                m = await ws.receive_json()
                if m.get("id") == n:
                    return m

        async def ev(expr, await_promise=False):
            r = await call("Runtime.evaluate", {"expression": expr, "awaitPromise": await_promise, "returnByValue": True})
            return r["result"]["result"].get("value")

        await call("Page.navigate", {"url": "http://127.0.0.1:8090/?importtest=1"})
        for _ in range(60):  # エンジンにつながるまで
            if "実験版" in (await ev("document.querySelector('.brand .tag')?.textContent ?? ''") or ""):
                break
            await asyncio.sleep(0.5)
        b64 = base64.b64encode(score.read_bytes()).decode()
        js = f"""(async () => {{
          const bin = atob("{b64}"); const u = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
          await window.__svs.files.importScore(new File([u], {json.dumps(score.name)}));
          return document.getElementById('status').textContent;
        }})()"""
        print("読み込み:", await ev(js, True))
        t0 = time.time()
        while time.time() - t0 < 90:  # 描画が済むまで
            st = await ev("document.querySelector('.engine-state')?.textContent ?? ''") or ""
            if "描画済み" in st:
                break
            await asyncio.sleep(0.5)
        print("エンジン:", st, f"（{time.time() - t0:.1f} 秒）")
        await asyncio.sleep(1.0)
        shot = await call("Page.captureScreenshot", {"format": "png"})
        Path(out_png).write_bytes(base64.b64decode(shot["result"]["data"]))


try:
    asyncio.run(main())
finally:
    proc.terminate()
