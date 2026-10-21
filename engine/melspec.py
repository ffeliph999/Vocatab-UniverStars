"""波形 → ln-mel。LeapSinger の leapsinger/mel.py（wav_to_mel_nhv）と同じ作り方で、hop だけ 256 にしたもの。
= center=False ＋ 事前の reflect pad (n_fft − hop)//2、hann、librosa の mel フィルタ @ |STFT|、ln(max(1e-5, ·))。
音響モデルの出力 mel・ボコーダの学習時の mel と同じ物差しで、出た音の mel を並べて見るために使う。
"""
from __future__ import annotations

import librosa
import numpy as np

SR, N_FFT, WIN, HOP, N_MELS, FMIN, FMAX = 44_100, 2048, 2048, 256, 128, 40.0, 16000.0
_BASIS = librosa.filters.mel(sr=SR, n_fft=N_FFT, n_mels=N_MELS, fmin=FMIN, fmax=FMAX).astype(np.float64)


def wav_to_mel(wav: np.ndarray) -> np.ndarray:
    """mono 44.1 kHz → ln-mel [128, T]（T ≈ len / 256）。"""
    pad = (N_FFT - HOP) // 2
    y = np.pad(np.asarray(wav, np.float64), (pad, pad), mode="reflect")
    spec = librosa.stft(y, n_fft=N_FFT, hop_length=HOP, win_length=WIN, window="hann", center=False)
    # macOS の Accelerate の行列積が出す見かけの警告を抑える（値は正しい。LeapSinger の mel.py と同じ扱い）
    with np.errstate(divide="ignore", over="ignore", invalid="ignore"):
        mel = _BASIS @ np.abs(spec)
    return np.log(np.maximum(1e-5, mel)).astype(np.float32)
