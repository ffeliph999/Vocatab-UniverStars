"""LeapSinger の音響モデルを、ボイスバンク用の ONNX に書き出す（LeapSinger の export/ を使う）。

LeapSinger の書き出しとの違いは 1 つだけ: 励振の白色雑音を、グラフの中の乱数ではなく入力 `exc_noise`
（[1, 256·T] の標準正規分布）にする。エンジンが種を決めて作るので、同じ句・同じ F0 なら毎回同じ mel になる
（ボイスパラメータを動かしても声の細部が変わらない。後で「取り直し」の種にも使える）。

    python tools/export_acoustic.py --leapsinger ../LeapSinger \\
        --ckpt ../LeapSinger/log/student_n005_t50k/ckpt_020000.pt \\
        --out voicebanks/leapsinger_ja_3singer/acoustic.onnx

形: diffsinger（use_uv なし）・hop 256・話者は spk_embed の入力（speakers.json はそのまま使う）。
入力: tokens [1,N] int64、durations [1,N] int64、f0 [1,T]（Hz）、spk_embed [1,H]、exc_noise [1,256·T] → mel [1,T,128]
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import numpy as np
import torch


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--leapsinger", required=True, help="LeapSinger のフォルダ")
    ap.add_argument("--ckpt", required=True)
    ap.add_argument("--out", required=True, help="書き出す .onnx")
    ap.add_argument("--opset", type=int, default=17)
    args = ap.parse_args()

    root = Path(args.leapsinger).resolve()
    sys.path.insert(0, str(root))
    from infer import load_acoustic
    from export import postprocess as post
    from export.excitation_onnx import HarmonicNoiseExcitationONNX
    from export.wrappers import AcousticExportWrapperA

    # 励振の雑音を外から渡す: forward の中の randn_like を、前もって置いた入力のテンソルに差し替える
    orig_randn = torch.randn_like

    def exc_forward(self, f0_logf0, voiced):
        torch.randn_like = lambda x: self.ext_noise.to(x.dtype)[:, :x.shape[1]]
        try:
            return HarmonicNoiseExcitationONNX._orig_forward(self, f0_logf0, voiced)
        finally:
            torch.randn_like = orig_randn
    HarmonicNoiseExcitationONNX._orig_forward = HarmonicNoiseExcitationONNX.forward
    HarmonicNoiseExcitationONNX.forward = exc_forward

    class Seeded(AcousticExportWrapperA):
        def forward(self, tokens, durations, f0, spk_embed, exc_noise):
            self.exc.ext_noise = exc_noise
            return super().forward(tokens, durations, f0, spk_embed)

    model, cfg = load_acoustic(args.ckpt, device="cpu")
    if float(getattr(model, "x0_sigma", 0.0)) > 0:
        raise SystemExit("x0_sigma > 0 の ckpt（出発点にノイズを足す教師）には対応していません")
    num_steps = int(cfg.get("infer_steps", 1))
    w = Seeded(model, num_steps=num_steps, hop=256, speaker="embed").eval()
    w.exc.deterministic = False

    vocab = model.phoneme_encoder.embed.num_embeddings if getattr(model, "phoneme_encoder", None) is not None \
        else model.phoneme_embed.num_embeddings
    Np, T = 8, 40
    tokens = torch.randint(1, max(2, vocab), (1, Np), dtype=torch.long)
    durs = torch.full((1, Np), T // Np, dtype=torch.long)
    f0 = torch.linspace(200, 300, T)[None]
    spk = torch.zeros(1, model.hidden)
    noise = torch.randn(1, T * 256)
    names = ["tokens", "durations", "f0", "spk_embed", "exc_noise"]
    axes = {"tokens": {1: "n_tokens"}, "durations": {1: "n_tokens"}, "f0": {1: "n_frames"},
            "exc_noise": {1: "n_samples"}, "mel": {1: "n_frames"}}

    out = Path(args.out).resolve()
    tmp = str(out) + ".fp32.onnx"
    with torch.no_grad():
        torch.onnx.export(w, (tokens, durs, f0, spk, noise), tmp, opset_version=args.opset,
                          input_names=names, output_names=["mel"], dynamic_axes=axes,
                          do_constant_folding=True, dynamo=False)
    post.finalize(tmp, str(out), fp16=False, do_simplify=True, native_dft=True)
    if os.path.exists(tmp):
        os.remove(tmp)
    print(f"書き出し: {out}（{out.stat().st_size / 1e6:.1f} MB、{num_steps} step）")

    # 確かめ: PyTorch と ORT が同じ雑音で一致し、雑音を変えると mel が変わること
    import onnxruntime as ort
    sess = ort.InferenceSession(str(out), providers=["CPUExecutionProvider"])
    rng = np.random.default_rng(0)
    Np, T = 12, 300
    tokens = torch.randint(1, max(2, vocab), (1, Np), dtype=torch.long)
    durs = torch.full((1, Np), T // Np, dtype=torch.long)
    f0 = torch.linspace(180, 330, T)[None]
    spk = torch.randn(1, model.hidden) * 0.1
    n1 = torch.from_numpy(rng.standard_normal((1, T * 256)).astype(np.float32))
    n2 = torch.from_numpy(rng.standard_normal((1, T * 256)).astype(np.float32))
    feeds = lambda n: {"tokens": tokens.numpy(), "durations": durs.numpy(), "f0": f0.numpy(),  # noqa: E731
                       "spk_embed": spk.numpy(), "exc_noise": n.numpy()}
    with torch.no_grad():
        ref = w(tokens, durs, f0, spk, n1).numpy()
    a = sess.run(["mel"], feeds(n1))[0]
    a2 = sess.run(["mel"], feeds(n1))[0]
    b = sess.run(["mel"], feeds(n2))[0]
    print(f"PyTorch と ORT の差 MAE {np.abs(ref - a).mean():.4f}、同じ雑音で 2 回 {np.abs(a - a2).max():.2e}、"
          f"雑音を変えると MAE {np.abs(a - b).mean():.4f}")


if __name__ == "__main__":
    main()
