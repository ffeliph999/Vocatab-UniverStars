"""ヘッドレスの Chrome を実時間で動かし、状態のバー（#status）に指定の文字が出るまで待って表示する。
使い方: python cdp_wait.py <URL> <待つ文字> [秒]"""
import asyncio
import json
import subprocess
import sys
import tempfile
import time
import urllib.request

import aiohttp

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
url, needle = sys.argv[1], sys.argv[2]
limit = float(sys.argv[3]) if len(sys.argv) > 3 else 90
port = 9333
prof = tempfile.mkdtemp(prefix="cdp_")
proc = subprocess.Popen([CHROME, "--headless=new", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
                         f"--remote-debugging-port={port}", f"--user-data-dir={prof}", "--window-size=1600,1000",
                         "--autoplay-policy=no-user-gesture-required", "about:blank"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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

        await call("Page.navigate", {"url": url})
        t0 = time.time()
        while time.time() - t0 < limit:
            r = await call("Runtime.evaluate", {"expression": "document.getElementById('status')?.textContent ?? ''"})
            text = r["result"]["result"].get("value", "")
            if needle in text:
                print(f"{time.time() - t0:.1f} 秒: {text}")
                return
            await asyncio.sleep(0.5)
        print(f"{limit} 秒待っても出なかった。最後の状態: {text}")


try:
    asyncio.run(main())
finally:
    proc.terminate()
