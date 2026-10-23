"""ブレスの wav → mel → NHVSing（雑音の枝だけ）→ wav を作って聴く（手元の確認用）。

エディタのブレスは、録音ではなく mel を持ち、ボコーダで鳴らす。その音になるかを先に確かめる:
    python tools/breaths/check_copysynth.py <wav ...> --out <フォルダ>
各 wav について <名前>_voc.wav（ボコーダを通した音）を書き、入力の mel と出力の mel の差を出す。
ボコーダには f0 = 220 Hz 一定・uv = 1（全フレーム無声）・前後 4 フレームの詰め物で入れる（エンジンと同じやり方）。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from engine.melspec import HOP, SR, wav_to_mel  # noqa: E402

PAD = 4            # 詰め物のフレーム数（ボコーダのフィルタの立ち上がりを吸収する）
BREATH_F0 = 220.0  # ブレスのときのダミーの F0（無声なので調波は出ない。0 を避ける）
LOG_FLOOR = float(np.log(1e-5))


def vocode_mel(sess, mel: np.ndarray, seed: int) -> np.ndarray:
    """mel [128, T] → wav [256·T]（詰め物はここで付けて外す）。"""
    T = mel.shape[1]
    m = np.pad(mel, ((0, 0), (PAD, PAD)), constant_values=LOG_FLOOR).astype(np.float32)
    Tp = m.shape[1]
    names = {i.name for i in sess.get_inputs()}
    feeds = {"mel": np.ascontiguousarray(m.T[None], np.float32),
             "f0": np.full((1, 1, Tp), BREATH_F0, np.float32), "uv": np.ones((1, 1, Tp), np.float32)}
    if "noise" in names:
        feeds["noise"] = np.random.default_rng([seed, 2]).standard_normal((1, 1, Tp, HOP)).astype(np.float32)
    outs = sess.run(None, feeds)
    h, z = (np.asarray(o, np.float32).reshape(-1) for o in outs[1:3])
    wav = np.clip(h + z, -1.0, 1.0)
    return wav[PAD * HOP:(PAD + T) * HOP]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("wavs", nargs="+")
    ap.add_argument("--out", required=True)
    ap.add_argument("--vocoder", default=str(ROOT / "vocoders" / "nhvsing_v3_2_1" / "vocoder.onnx"))
    a = ap.parse_args()
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 2
    sess = ort.InferenceSession(a.vocoder, so, providers=["CPUExecutionProvider"])
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    for p in a.wavs:
        y, sr = sf.read(p, dtype="float64", always_2d=True)
        y = y.mean(axis=1)
        if sr != SR:
            import soxr
            y = soxr.resample(y, sr, SR, quality="HQ")
        mel = wav_to_mel(y)
        wav = vocode_mel(sess, mel, seed=7000)
        mel2 = wav_to_mel(wav.astype(np.float64))
        n = min(mel.shape[1], mel2.shape[1])
        diff = float(np.mean(np.abs(mel[:, :n] - mel2[:, :n])))
        rms_in = 20 * np.log10(np.sqrt(np.mean(y * y)) + 1e-9)
        rms_out = 20 * np.log10(np.sqrt(np.mean(wav * wav)) + 1e-9)
        dst = out / (Path(p).stem + "_voc.wav")
        sf.write(str(dst), wav, SR, subtype="PCM_16")
        print(f"{Path(p).name}: {mel.shape[1]} フレーム、mel の差（ln の平均） {diff:.3f}、RMS 入 {rms_in:.1f} → 出 {rms_out:.1f} dBFS → {dst.name}")


if __name__ == "__main__":
    main()
