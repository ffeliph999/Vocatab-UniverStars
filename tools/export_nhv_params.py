"""NHVSing v3.x を、VocaTab 用の入出力を足した ONNX に書き出す（NHVSing の export.py の部品を使う）。

NHVSing の書き出しとの違い:
  * 雑音の枝の白色雑音を入力 `noise`（[B,1,T,256] の標準正規分布。並べると [B,1,256·T]）にする
    （エンジンが種を決めて作る。毎回同じ音になる）
  * フィルタの滑らかな包絡（調波・雑音の両方、自然対数の振幅、bin は fft_size の半分 + 1）も出力する。
    テンション・ジェンダー・響きは、エンジンが出力の調波・雑音の波形に周波数ごとの利得として掛ける
    （engine/voiceparams.py の spectral。ボコーダを回し直さずに済む）。ジェンダーはこの包絡を伸び縮みさせた比を使う
  滑らかな包絡: ケプストラムを |ケフレンシ| < LIFTER_RATIO · sr / f0（フレームごと、倍音の周期の手前）の Hann の
  リフタに通したもの（高い声ではフィルタが倍音の位置に山の並ぶ櫛の形になっているので、それを除く）。
  ccep → インパルス応答の部分だけ自前。ほかは NHVSing の部品のまま。

    python tools/export_nhv_params.py --nhvsing ../NHVSing --config ../NHVSing/config_v3_2.yaml \\
        --ckpt ../NHVSing/exported_models/v3_2_1/nhv_v3_2_1.pth --out vocoders/nhvsing_v3_2_1/vocoder.onnx

入力: mel [1,T,128]、f0 [1,1,T]（Hz）、uv [1,1,T]（1 = 無声）、noise [1,1,T,256]
出力: waveform（±1 で切る）、harmonic、noise_out（どちらも切る前）、env_h・env_n [1,T,fft/2+1]
"""
from __future__ import annotations

import argparse
import math
import os
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

LIFTER_RATIO = 0.6      # 滑らかな包絡のケフレンシの上限 = 0.6 × 倍音の周期（440 Hz で 60、220 Hz で 120 サンプル）
LIFTER_MIN, LIFTER_MAX = 16.0, 120.0


def build(nhv_root: Path):
    sys.path.insert(0, str(nhv_root))
    from export import FullVocoderV3
    from dsp_rebuild.complex_cepstrum_to_imp_onnx import fftpad
    from dsp_rebuild.impulse_train_onnx import _scan

    class FullVocoderV3P(FullVocoderV3):
        def __init__(self, vc, lc):
            super().__init__(vc, lc, noise_on=True)
            self.sr = float(vc["sample_rate"])
            self.n_fft = int(lc["fft_size"])
            nh = self.n_fft // 2 + 1
            mirror = np.r_[np.arange(nh), np.arange(nh - 2, 0, -1)]
            self.register_buffer("mirror", torch.tensor(mirror, dtype=torch.long), persistent=False)
            sign = np.r_[np.ones(nh), -np.ones(self.n_fft - nh)]
            self.register_buffer("odd_sign", torch.tensor(sign, dtype=torch.float32).view(1, 1, -1), persistent=False)
            # 包絡を取り出すリフタ用の |ケフレンシ|。ccep は [正の 0..127, 負の −128..−1] の並び
            nc = int(lc["ccep_size"])
            q = np.minimum(np.arange(nc), nc - np.arange(nc))
            self.register_buffer("quef", torch.tensor(q, dtype=torch.float32).view(1, 1, nc), persistent=False)
            self.fftpad = fftpad
            self.scan = _scan

        # ── フィルタ: ccep → (半分の) 対数振幅と位相 → インパルス応答 ──
        def _half_spec(self, ccep):
            X = torch.view_as_real(torch.fft.fft(self.fftpad(ccep.float(), self.n_fft - ccep.size(-1)), dim=-1))
            nh = self.n_fft // 2 + 1
            return X[..., :nh, 0], X[..., :nh, 1]                       # [B,T,nh] 各

        def _imp(self, lm, ph):
            lm = lm.index_select(2, self.mirror)
            ph = ph.index_select(2, self.mirror) * self.odd_sign
            mag = torch.exp(lm.clamp(max=10.0))
            X = torch.view_as_complex(torch.stack([mag * torch.cos(ph), mag * torch.sin(ph)], dim=-1))
            return torch.fft.ifft(X, dim=-1).real.to(torch.float32)

        def _impulse(self, cf0):
            """インパルス列（NHVSing の _loop_harmonics と同じ計算）。"""
            H = int(self.impulse_train.n_harmonic)
            sr = self.sr
            sr_half = sr / 2.0
            phase = cf0.to(torch.float64).cumsum(dim=-1)
            # 倍音の番号は 0 次元で渡す（[1] だと torch 2.11 の scan が長さを記号にして掛け算の形が合わなくなる）
            ks = torch.arange(1, H + 1, dtype=torch.float64)
            ph1 = phase.reshape(-1)
            f01 = cf0.reshape(-1)

            def body(carry, xs):
                k = xs[0]
                cyc = ph1 * (k / sr)
                w0 = ((cyc - torch.floor(cyc)) * (2.0 * math.pi)).to(torch.float32)
                wm = torch.sigmoid(-(k.to(torch.float32) * f01 - sr_half))
                return carry + torch.cos(w0) * wm, (torch.zeros(1, dtype=torch.float32),)

            acc, _ = self.scan(body, torch.zeros_like(f01), (ks,))
            return acc.reshape(cf0.shape) * 0.01

        def forward(self, mel, f0, uv, noise):
            hop = self.hop_size
            ccep_harm, ccep_noise = self.nn_core(mel)
            lm_h, ph_h = self._half_spec(ccep_harm)
            lm_n, ph_n = self._half_spec(ccep_noise)
            # 高い声ではフィルタが倍音の位置に山の並ぶ櫛の形になっている（256 次のケプストラムで 440 Hz の
            # 倍音まで表せる）。櫛を除いた滑らかな包絡を、フレームごとの f0 に合わせたリフタで取り出して出力する
            L = (LIFTER_RATIO * self.sr / f0.transpose(1, 2).clamp(min=50.0)).clamp(LIFTER_MIN, LIFTER_MAX)
            lif = torch.where(self.quef < L, 0.5 + 0.5 * torch.cos(math.pi * self.quef / L),
                              torch.zeros_like(self.quef))                   # [B,T,nc]
            env_h = self._half_spec(ccep_harm * lif)[0]
            env_n = self._half_spec(ccep_noise * lif)[0]
            # 励振
            up = lambda x: F.interpolate(x, scale_factor=hop, mode="linear", align_corners=False)  # noqa: E731
            src_h = self._impulse(up(f0)) * torch.repeat_interleave(1.0 - uv, hop, dim=-1)
            sig_harm = self.ltv_fir(src_h, self._imp(lm_h, ph_h))
            # noise は [B,1,T,hop]（長さの次元をフレーム数にそろえる。[B,1,hop·T] だと書き出し器が T と取り違える）
            z = noise.reshape(noise.size(0), 1, -1)
            sig_noise = self.ltv_fir(z * self.noise_std, self._imp(lm_n, ph_n))
            return torch.clamp(sig_harm + sig_noise, -1.0, 1.0), sig_harm, sig_noise, env_h, env_n

    return FullVocoderV3P


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--nhvsing", required=True)
    ap.add_argument("--config", required=True)
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    import yaml
    root = Path(args.nhvsing).resolve()
    Cls = build(root)
    from export import load_core, FullVocoderV3
    cfg = yaml.safe_load(open(args.config))
    vc, lc = cfg["model"]["vocoder"], cfg["model"]["ltv_filter"]
    sd = torch.load(args.ckpt, map_location="cpu", weights_only=False)
    sd = sd["model"] if "model" in sd else sd
    full = Cls(vc, lc)
    load_core(full, sd, vc, lc)
    full.eval()
    for p in full.parameters():
        p.requires_grad_(False)  # 複素数の FFT を scan の中で書き出すとき、勾配の記録があると落ちる

    T = 203  # 見本の長さは、ほかの次元（ccep 256・FFT 1024 など）と重ならない値にする（同じ値だと同じ次元にされる）
    torch.manual_seed(0)
    mel = torch.randn(1, T, vc["in_channels"])
    f0 = torch.rand(1, 1, T) * 300 + 120
    uv = (torch.rand(1, 1, T) > 0.8).float()
    noise = torch.randn(1, 1, T, vc["hop_size"])
    names = ["mel", "f0", "uv", "noise"]
    # バッチは 1 に固定（動的にすると scan の中で倍音の番号の次元と取り違えられて書き出せない）。
    # 次元の指定は入力の順に並べる（順が違うと別の入力に割り当てられることがある）
    axes = {"mel": {1: "T"}, "f0": {2: "T"}, "uv": {2: "T"}, "noise": {2: "T"},
            "waveform": {2: "N"}, "harmonic": {2: "N"}, "noise_out": {2: "N"}, "env_h": {1: "T"}, "env_n": {1: "T"}}
    out = str(Path(args.out).resolve())
    torch.onnx.export(full, (mel, f0, uv, noise), out, input_names=names,
                      output_names=["waveform", "harmonic", "noise_out", "env_h", "env_n"], dynamic_axes=axes,
                      opset_version=18, do_constant_folding=True)
    import onnx
    m = onnx.load(out, load_external_data=True)
    m.doc_string = ""
    del m.metadata_props[:]

    def strip(g):  # エクスポートした環境のパス入りのスタックトレースを消す（Scan の中まで）
        g.doc_string = ""
        del g.metadata_props[:]
        # 途中の形の記録も消す（フレーム数とサンプル数が同じ記号にされ、ORT がバッファを取り違えることがある）
        del g.value_info[:]
        for n in g.node:
            n.doc_string = ""
            del n.metadata_props[:]
            for a in n.attribute:
                if a.HasField("g"):
                    strip(a.g)
                for sub in a.graphs:
                    strip(sub)
    for g in [m.graph] + list(m.functions):
        strip(g)
    onnx.save_model(m, out, save_as_external_data=False)
    if os.path.exists(out + ".data"):
        os.remove(out + ".data")
    print(f"書き出し: {out}（{os.path.getsize(out) / 1e6:.1f} MB）")

    # 確かめ: 元の NHVSing（同じ雑音）と同じ音
    import onnxruntime as ort
    sess = ort.InferenceSession(out, providers=["CPUExecutionProvider"])
    T = 600
    mel = torch.randn(1, T, vc["in_channels"]) * 0.5 - 4
    f0 = (220 * 2 ** (torch.sin(torch.linspace(0, 12, T)) / 12)).view(1, 1, T)
    uv = torch.zeros(1, 1, T)
    uv[..., 280:320] = 1
    noise = torch.randn(1, 1, T, vc["hop_size"])
    ref_m = FullVocoderV3(vc, lc, noise_on=False)
    load_core(ref_m, sd, vc, lc)
    ref_m.eval()
    with torch.no_grad():
        ref_h = ref_m(mel, f0, uv)[1].numpy().reshape(-1)
        mine_t = full(mel, f0, uv, noise)
    feeds = {"mel": mel.numpy(), "f0": f0.numpy(), "uv": uv.numpy(), "noise": noise.numpy()}
    w0, h0, n0, eh, en = sess.run(None, feeds)
    db = lambda x: 10 * np.log10(np.mean(np.asarray(x, np.float64) ** 2) + 1e-12)  # noqa: E731
    err = np.abs(h0.reshape(-1) - ref_h)
    print(f"調波と元の NHVSing の差: 最大 {err.max():.2e}（信号 {db(ref_h):.1f} dB に対し誤差 {db(err):.1f} dB）、"
          f"PyTorch と ORT の差 {np.abs(mine_t[0].numpy() - w0).max():.2e}、包絡 {eh.shape} {en.shape}")
    a = sess.run(None, feeds)[0]
    print(f"同じ雑音で 2 回: 差 {np.abs(a - w0).max():.2e}")


if __name__ == "__main__":
    main()
