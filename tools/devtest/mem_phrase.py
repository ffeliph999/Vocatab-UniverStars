"""長いフレーズ 1 本の解析と合成の、時間とピークのメモリ（このプロセスの最大常駐量）。
使い方: python mem_phrase.py <svs_editor> <秒>"""
import resource
import sys
import time
from pathlib import Path

import numpy as np

root, sec = Path(sys.argv[1]), float(sys.argv[2])
sys.path.insert(0, str(root))
from engine.pipeline import PrettyPitchLeapSinger  # noqa: E402
from engine.voicebank import scan  # noqa: E402

rss = lambda: resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6  # macOS はバイト → MB  # noqa: E731
vbs, vocs = scan(root)
eng = PrettyPitchLeapSinger(vbs["leapsinger_ja_3singer"])
base = rss()
# 120 BPM の 4 分音符（0.5 秒）を休み無しで並べる → 1 フレーズ
kana = ["ら", "さ", "く", "や", "よ", "い", "の", "そ"]
pitches = [69, 71, 72, 71, 69, 67, 65, 64]
n = int(sec / 0.5)
notes = [{"id": i + 1, "onset": 1920 + i * 480, "dur": 480, "pitch": pitches[i % 8], "lyric": kana[i % 8]} for i in range(n)]
phrases = eng.phrases_from_notes(notes, 120)
t0 = time.time()
an = eng.analyze(phrases[0][0], 2, seed=0)
t1 = time.time()
f0 = 2.0 ** (an.plain_log2 + an.vib_log2)
o = eng.synthesize(an, f0, 2, vocs["nhvsing_v3_2_1"])
t2 = time.time()
T = int(an.ph_durs.sum())
print(f"{sec:.0f} 秒（{len(phrases)} 句、{T} フレーム）: 解析 {t1 - t0:.2f} 秒・合成 {t2 - t1:.2f} 秒、"
      f"ピークのメモリ {rss():.0f} MB（モデルを読んだ直後 {base:.0f} MB）、波形 {len(o['wav']) / 44100:.1f} 秒")
