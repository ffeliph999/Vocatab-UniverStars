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

計算は既定で CPU（WASM）。設定の「GPU で計算する」か `?gpu=1` で WebGPU（F0 と NSF-HiFiGAN が速くなる。Chrome 向けの実験的な
もの。Safari では WebGPU 入りの部品を読むだけでページの読み込み直しが起きるので使わない）。`?gpu=0` で強制的に CPU。
しばらく（既定 180 秒、`?idle=<秒>`）操作が無いとエンジンは Worker ごと手放して待機し、次の編集で起きる（解析の結果は画面が
持っているので解析し直さない）。

## 中身

| 場所 | 役目 |
|---|---|
| `ui/src/` | 画面（TypeScript、フレームワーク無し） |
| `ui/src/engine-web/` | ブラウザ版のエンジン。`core.ts` が解析と合成の順番、`worker.ts` が Web Worker、`client.ts` が画面側の窓口 |
| `ui/src/engine-web/score.ts`・`durations.ts` | 楽譜 → 句 → 音素の長さ |
| `ui/src/engine-web/g2p_ko.ts` | 韓国語の G2P（ハングル → 音素。言語パックが `g2p: ko` のとき score.ts が使う） |
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
試験の楽譜は日本語の 3 つ（sakura・mixed・params）と韓国語の 1 つ（korean。ハングルの G2P と句末の終声）。
`python tools/golden/dump_golden.py korean` のようにケースの名前を渡すと、それだけ書き出す。

韓国語の G2P（`ui/src/engine-web/g2p_ko.ts`）は、`python tools/golden/dump_g2p_ko.py` で PrettyPitch の `svs/g2p_ko.py` の
結果（音節の並び 23,192 通り）を書き出し、`ui/test/g2p_ko.test.ts` で全部を比べる。

ブラウザで実際にモデルを動かして、楽譜から波形まで比べる（Python と同じ雑音を入れる）:

```
python tools/run_e2e.py
```

音響モデルの出力は onnxruntime-web と手元の onnxruntime の計算の違いで少しずれる（mel で最大 0.09・平均 0.0012、
ln の単位。波形で平均 5e-5）。`python tools/run_e2e.py --model-only sakura` で、同じ入力をモデルだけに入れても
同じ差になることを確かめられる。

## メモリと速さの目安

MacBook Air（M 系、16 GB、CPU のみ・1 スレッド）での計測（`research/experiment/web_ort_bench`）。パソコンのブラウザを想定している。

- 1 句（7.8 秒）のリテイク: Chrome で約 3.3 秒、Safari で約 3.5〜4 秒（F0 0.6 秒 + 音響 1.1 秒 + NHVSing 1.2 秒）。
  NSF-HiFiGAN は CPU だと 1 句 13 秒かかるので、GPU 無しでは NHVSing 向き
- メモリ: 描画後のページは物理フットプリント約 470 MB（Chrome）・約 490 MB（Safari）。取り置きはバイト数で区切る
  （音響 32 MB・ボコーダ 128 MB、同じ句の変種は 3 つまで）ので、リテイクを 20 回続けても WASM のメモリは 203 MB で一定。
  待機に入ると Worker ごと手放して約 160 MB（Chrome）・約 80 MB（Safari）になり、次の編集で約 4 秒で起きる
  （変わっていない句は解析も合成もし直さない）
- 長い句: 音響モデルの倍音の足し合わせを ONNX の `Loop` に畳んである（`tools/acoustic_loop.py`。出力はビット単位で同じ）ので、
  音響モデルのピークメモリは 7.8 秒の句で +80 MB、30 秒の句で +290 MB（展開したままだと +385 MB・+1.5 GB。手元の
  onnxruntime での実測）。ボコーダは句を区切らずそのまま通す
