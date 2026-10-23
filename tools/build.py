"""画面（ui/dist/app.js）とブラウザ版のエンジン（ui/dist/engine-worker.js）を esbuild で作る。

使い方: python tools/build.py
  エンジンは Web Worker で動くので、画面とは別のファイル（importScripts を使うので iife）にする。
"""
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# ビルドの印。画面（client.ts）が Worker のファイル名に ?v=<印> を付けて読むので、作り直したエンジンをブラウザが
# 古いキャッシュで使い回さない（Worker のスクリプトはページの強制再読み込みでも読み直されないことがある）
BUILD = time.strftime("%Y%m%d%H%M%S")
ESBUILD = ["npx", "esbuild@0.25.0", "--bundle", "--target=es2022", "--sourcemap", f'--define:__BUILD__="{BUILD}"']

jobs = [
    [str(ROOT / "ui/src/main.ts"), "--format=esm", f"--outfile={ROOT / 'ui/dist/app.js'}"],
    [str(ROOT / "ui/src/engine-web/worker.ts"), "--format=iife", f"--outfile={ROOT / 'ui/dist/engine-worker.js'}"],
]
for j in jobs:
    r = subprocess.run(ESBUILD + j)
    if r.returncode:
        sys.exit(r.returncode)
