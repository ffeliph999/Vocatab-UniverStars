"""画面（ui/dist/app.js）とブラウザ版のエンジン（ui/dist/engine-worker.js）を esbuild で作る。

使い方: python tools/build.py
  エンジンは Web Worker で動くので、画面とは別のファイル（importScripts を使うので iife）にする。
"""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ESBUILD = ["npx", "esbuild@0.25.0", "--bundle", "--target=es2022", "--sourcemap"]

jobs = [
    [str(ROOT / "ui/src/main.ts"), "--format=esm", f"--outfile={ROOT / 'ui/dist/app.js'}"],
    [str(ROOT / "ui/src/engine-web/worker.ts"), "--format=iife", f"--outfile={ROOT / 'ui/dist/engine-worker.js'}"],
]
for j in jobs:
    r = subprocess.run(ESBUILD + j)
    if r.returncode:
        sys.exit(r.returncode)
