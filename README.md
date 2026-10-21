# SVS Editor（ブラウザ版）

歌声合成のエディタ。合成のエンジン（LeapSinger の音響・PrettyPitch の F0 と子音の長さ・NHVSing のボコーダ）は
ブラウザの中（Web Worker と onnxruntime-web）で動くので、静的な配信（GitHub Pages など）だけで使える。

## 動かす

```
python tools/export_web_assets.py   # ボイスバンク・ボコーダの設定を JSON に（足したり差し替えたりしたとき）
python tools/build.py               # ui/dist/app.js（画面）と ui/dist/engine-worker.js（エンジン）を作る
python -m http.server 8097          # このフォルダを配る（どの静的なサーバーでもよい）
```

ブラウザで `http://127.0.0.1:8097/ui/` を開く（このフォルダの頭を開くと ui/ へ移る）。
初回はモデル（既定の組で約 69 MB）をダウンロードし、ブラウザの中に取っておく。2 回目からはダウンロードしない。

手元の Python のエンジン（`engine/server.py`）も残してあり、`python engine/server.py` で開いた画面に
`?engine=server` を付けると、そちらで合成する（ブラウザ版との照らし合わせ用）。

## 中身

| 場所 | 役目 |
|---|---|
| `ui/src/` | 画面（TypeScript、フレームワーク無し） |
| `ui/src/engine-web/` | ブラウザ版のエンジン。`core.ts` が解析と合成の順番、`worker.ts` が Web Worker、`client.ts` が画面側の窓口 |
| `ui/src/engine-web/score.ts`・`durations.ts` | 楽譜 → 句 → 音素の長さ |
| `ui/src/engine-web/f0host.ts` | F0 のモデルの入力と、出力からの抑揚の線（ピッチ補正を含む） |
| `ui/src/engine-web/synthhost.ts`・`voiceparams.ts`・`melspec.ts` | 音響モデルとボコーダの入力、mel の後処理、ボイスパラメータの信号処理、出た音の mel |
| `engine/` | 手元の Python のエンジン（移植のもと。照らし合わせに使う） |
| `voicebanks/`・`vocoders/` | モデル（ONNX）と設定。`web.json`・`web_index.json` は `tools/export_web_assets.py` が書く |

## 照らし合わせ（移植が Python のエンジンと同じ値を出すか）

```
python tools/golden/dump_golden.py   # Python のエンジンで試験用の楽譜を合成し、段ごとの値を ui/test/golden/ に書く
```

node で前後の処理だけを比べる（モデルの出力は正解から借りる）。`<作業用>` は書き込めるフォルダならどこでもよい:

```
npx esbuild@0.25.0 ui/test/durations.test.ts --bundle --platform=node --format=esm --outfile=<作業用>/t.mjs
node <作業用>/t.mjs
```

`durations`・`f0`・`synth` の 3 本。前後の処理は Python とビット単位（float32 の丸めまで）で一致する。

ブラウザで実際にモデルを動かして、楽譜から波形まで比べる（Python と同じ雑音を入れる）:

```
python tools/run_e2e.py
```

音響モデルの出力は onnxruntime-web と手元の onnxruntime の計算の違いで少しずれる（mel で最大 0.09・平均 0.0012、
ln の単位。波形で平均 5e-5）。`python tools/run_e2e.py --model-only sakura` で、同じ入力をモデルだけに入れても
同じ差になることを確かめられる。

## メモリと速さの目安

MacBook Air（M 系、Chrome、1 スレッド）で、7.8 秒の句の合成が約 2.3 秒、ページのメモリは約 560 MB
（`research/experiment/web_ort_bench` の計測）。パソコンのブラウザを想定している。
