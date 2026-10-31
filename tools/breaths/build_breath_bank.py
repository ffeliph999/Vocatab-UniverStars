"""選んだブレスの候補から、ボイスバンクに入れる「ブレスの mel の束」を作る。

    python tools/breaths/build_breath_bank.py --candidates <フォルダ>/candidates.json --selected <フォルダ>/selected.json \
        --vb voicebanks/leapsinger_ja_3singer [--preview <フォルダ>/preview]

書くもの（ボイスバンクのフォルダ）:
    breaths.bin    float16 の ln-mel。1 つずつ [128, frames] を行優先で並べたもの（エンジンの mel_in と同じ並び）
    breaths.json   一覧 {version, bin, bin_bytes, dtype, n_mels, sr, hop, mel: {...}, clips: [{id, singer, offset, frames, sec, gain_db, src}]}

音量: 録音ごとの音量の差を持ち込まないよう、候補の「直後のフレーズの RMS」が、合成した声の RMS（--ref の wav、
既定は ui/test/golden の合成結果）と同じになる倍率をブレスに掛けてから mel にする。つまりブレスと声の比は録音のまま。
clips[].gain_db（既定 0）は、あとで耳で直すための追加の倍率（エンジンが mel に ln(10^(gain_db/20)) を足す）。

元の録音そのものは入れない（規約）。mel は音響モデルと同じ「データベースから作った派生物」として扱う。
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from engine.melspec import FMAX, FMIN, HOP, N_FFT, N_MELS, SR, wav_to_mel  # noqa: E402
from extract_breath_candidates import load_mono_44k, rms_db  # noqa: E402

FADE_SEC = 0.010


def ref_voice_db(paths: list[Path]) -> float:
    """合成した声（float32 の生の wav）の RMS（dBFS）。前後の無音（最大 −50 dB 未満）は外し、中は全部入れる
    （候補の phrase_rms_db と同じ測り方）。複数あれば平均。"""
    vals = []
    for p in paths:
        w = np.fromfile(p, np.float32).astype(np.float64)
        n = len(w) // HOP
        fr = w[:n * HOP].reshape(n, HOP)
        db = 20 * np.log10(np.sqrt(np.mean(fr * fr, axis=1)) + 1e-9)
        keep = np.where(db > db.max() - 50)[0]
        if len(keep) < 2:
            continue
        vals.append(rms_db(w[keep[0] * HOP:(keep[-1] + 1) * HOP]))
    if not vals:
        raise SystemExit("基準の声の wav が読めない（--ref を指定してください）")
    return float(np.mean(vals))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--candidates", required=True)
    ap.add_argument("--selected", required=True)
    ap.add_argument("--vb", required=True, help="ボイスバンクのフォルダ（breaths.bin / breaths.json を書く）")
    ap.add_argument("--ref", nargs="*", help="合成した声の wav（float32 の生データ）。既定は ui/test/golden の sakura・mixed")
    ap.add_argument("--preview", help="確認用: 各ブレスをボコーダで鳴らした wav を書くフォルダ")
    a = ap.parse_args()
    cands = {c["id"]: c for v in json.load(open(a.candidates, encoding="utf-8")).values() for c in v}
    selected = json.load(open(a.selected, encoding="utf-8"))
    refs = [Path(p) for p in a.ref] if a.ref else sorted((ROOT / "ui" / "test" / "golden").glob("*/025_p0_synth_result_wav.bin"))
    refs = [p for p in refs if "korean" not in p.parts and "params" not in p.parts]
    ref_db = ref_voice_db(refs)
    print(f"基準の声の RMS: {ref_db:.1f} dBFS（{len(refs)} 本）")

    vb = Path(a.vb)
    clips = []
    blobs = []
    offset = 0
    cache: dict[str, np.ndarray] = {}
    for singer_name, ids in selected.items():
        for n, cid in enumerate(ids):
            c = cands[cid]
            y = cache.get(c["src_wav"])
            if y is None:
                cache.clear()
                y = cache[c["src_wav"]] = load_mono_44k(Path(c["src_wav"]))
            clip = y[int(c["start"] * SR):int(c["end"] * SR)].astype(np.float64)
            gain_db = ref_db - c["phrase_rms_db"]           # 直後のフレーズが基準の声と同じ音量になる倍率
            clip = clip * 10 ** (gain_db / 20)
            fade = int(FADE_SEC * SR)
            if len(clip) > 2 * fade:
                clip[:fade] *= np.linspace(0, 1, fade)
                clip[-fade:] *= np.linspace(1, 0, fade)
            mel = wav_to_mel(clip)                            # [128, T]
            frames = mel.shape[1]
            blobs.append(mel.astype(np.float16))
            clips.append({"id": f"{singer_name}_{n + 1:02d}", "singer": int(c["singer"]), "offset": offset,
                          "frames": frames, "sec": round(frames * HOP / SR, 3), "gain_db": 0.0,
                          "src": f"{c['song']} {c['start']:.2f}s" + ("（ラベル br）" if c.get("labeled") else ""),
                          "level_db": round(c["breath_rms_db"] - c["phrase_rms_db"], 1)})
            offset += mel.size
            print(f"{clips[-1]['id']}: {frames} フレーム、声との差 {clips[-1]['level_db']:+.0f} dB、{clips[-1]['src']}")
    data = np.concatenate([b.reshape(-1) for b in blobs]).astype("<f2")
    (vb / "breaths.bin").write_bytes(data.tobytes())
    index = {"version": 1, "bin": "breaths.bin", "bin_bytes": int(data.nbytes), "dtype": "float16", "layout": "mel_major",
             "n_mels": N_MELS, "sr": SR, "hop": HOP,
             "mel": {"n_fft": N_FFT, "fmin": FMIN, "fmax": FMAX, "log": "ln", "floor": 1e-5},
             "ref_voice_db": round(ref_db, 2), "clips": clips}
    (vb / "breaths.json").write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{vb / 'breaths.json'}: {len(clips)} 個、{data.nbytes / 1e3:.0f} KB")

    if a.preview:
        from check_copysynth import vocode_mel
        import onnxruntime as ort
        sess = ort.InferenceSession(str(ROOT / "vocoders" / "nhvsing_v3_3" / "vocoder.onnx"), providers=["CPUExecutionProvider"])
        out = Path(a.preview)
        out.mkdir(parents=True, exist_ok=True)
        for c, mel in zip(clips, blobs):
            wav = vocode_mel(sess, mel.astype(np.float32), seed=7000 + c["offset"] % 1000)
            sf.write(str(out / f"{c['id']}.wav"), wav, SR, subtype="PCM_16")
        print(f"{out}: 確認用の wav を書いた（基準の声 {ref_db:.0f} dBFS に対する音量）")


if __name__ == "__main__":
    main()
