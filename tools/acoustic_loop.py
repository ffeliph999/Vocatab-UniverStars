"""音響モデルの ONNX の「倍音の足し合わせ」を、展開された 256 段の直線の列から ONNX の Loop に書き換える。

なぜ: 書き出した図は、倍音 k = 1..256 ごとに「k·phase → sin → ×a_k → ×（k·f0 < nyq）→ acc に足す」を 256 回並べている。
onnxruntime の既定の実行順はこの列を「全部の sin を先に作ってから足す」順に並べるため、サンプル長の配列が 256 本同時に生き、
メモリのピークが 0.28 MB/フレーム（30 秒の句で 1.5 GB）になる。実行順を優先度式にすれば 5 分の 1 になるが、
ブラウザの onnxruntime-web にはその設定が無い。Loop にすれば 1 本ずつ順に計算するので、どの実行順でも O(n) で済む。
ついでに、倍音の周波数 k·f0 がナイキスト周波数を全サンプルで超えたら止める（それ以降の項は厳密に 0 なので、結果は変わらない）。
計算の式と順番は元と同じなので、出力はビット単位で一致する（check で確かめる）。

使い方: python tools/acoustic_loop.py <in.onnx> <out.onnx> [--check]
  --check: 元と書き換え後を手元の onnxruntime で動かし、出力の差・ピークメモリ・時間を比べる
"""
from __future__ import annotations

import argparse
import json
import resource
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper


def constant_value(g: onnx.GraphProto, name: str):
    """initializer か Constant ノードの値（無ければ None）。"""
    for i in g.initializer:
        if i.name == name:
            return numpy_helper.to_array(i)
    for n in g.node:
        if n.op_type == "Constant" and n.output[0] == name:
            for a in n.attribute:
                if a.name == "value":
                    return numpy_helper.to_array(a.t)
    return None


def convert(src: Path, dst: Path) -> dict:
    m = onnx.load(str(src))
    g = m.graph
    by_out = {o: n for n in g.node for o in n.output}
    consumers: dict[str, list] = {}
    for n in g.node:
        for i in n.input:
            consumers.setdefault(i, []).append(n)

    # acc の出発点（zeros_like(phase)）と、Add の鎖
    cos = [n for n in g.node if n.op_type == "ConstantOfShape" and n.name.startswith("/exc/")]
    if len(cos) != 1:
        raise SystemExit(f"/exc/ の ConstantOfShape が 1 つではない: {len(cos)}")
    acc = cos[0].output[0]
    adds, terms = [], []
    while True:
        nxt = [n for n in consumers.get(acc, []) if n.op_type == "Add"]
        if len(nxt) != 1:
            break
        add = nxt[0]
        term = add.input[1] if add.input[0] == acc else add.input[0]
        adds.append(add)
        terms.append(term)
        acc = add.output[0]
    n_harm = len(adds)
    if n_harm < 2:
        raise SystemExit("倍音の Add の鎖が見つからない")

    # 各項を遡って k・a・phase・f0_up を集める
    remove = set(id(a) for a in adds)
    ks, amps = [], []
    phase_name = f0_name = nyq_name = None

    def scalar_mul(node):
        """Mul(x, 定数) → (x, 定数)。定数でなければ (None, None)"""
        for a, b in ((node.input[0], node.input[1]), (node.input[1], node.input[0])):
            v = constant_value(g, b)
            if v is not None and v.size == 1:
                return a, float(v.reshape(-1)[0])
        return None, None

    for term in terms:
        t = by_out[term]                           # Mul(x, aa)
        if t.op_type != "Mul":
            raise SystemExit(f"項が Mul ではない: {t.name}")
        remove.add(id(t))
        # どちらが aa（Cast(Less(...))）か
        x_name, aa_name = t.input
        if by_out[aa_name].op_type != "Cast":
            x_name, aa_name = aa_name, x_name
        cast = by_out[aa_name]
        less = by_out[cast.input[0]]
        if cast.op_type != "Cast" or less.op_type != "Less":
            raise SystemExit(f"ゲートの形が違う: {t.name}")
        remove.update([id(cast), id(less)])
        nyq_name = less.input[1]
        kf = by_out.get(less.input[0])
        if kf is not None and kf.op_type == "Mul" and kf.name.startswith("/exc/"):
            f0_src, k = scalar_mul(kf)
            remove.add(id(kf))
        else:                                       # k = 1 は Mul が無い
            f0_src, k = less.input[0], 1.0
        f0_name = f0_src
        # x = Mul(Sin(k·phase), a) か Sin(phase)（k = 1、a = 1）
        x = by_out[x_name]
        if x.op_type == "Mul":
            sin_name, a = scalar_mul(x)
            remove.add(id(x))
            sin = by_out[sin_name]
        else:
            sin, a = x, 1.0
        if sin.op_type != "Sin":
            raise SystemExit(f"Sin が見つからない: {t.name}")
        remove.add(id(sin))
        kp = by_out[sin.input[0]]
        if kp.op_type == "Mul" and kp.name.startswith("/exc/"):
            ph, k2 = scalar_mul(kp)
            remove.add(id(kp))
            if k2 != k:
                raise SystemExit(f"k が合わない: {k} と {k2}")
        else:
            ph = sin.input[0]
            if k != 1.0:
                raise SystemExit("k·phase の Mul が無いのに k ≠ 1")
        phase_name = ph
        ks.append(np.float32(k))
        amps.append(np.float32(a))
    if ks != [np.float32(i + 1) for i in range(n_harm)]:
        raise SystemExit("k が 1, 2, ... の順になっていない")
    nyq = constant_value(g, nyq_name)
    final_name = adds[-1].output[0]                 # 下流（harm / harm_rms）が使う名前

    # Loop の本体
    K = numpy_helper.from_array(np.asarray(ks, np.float32), "harm_k_table")
    A = numpy_helper.from_array(np.asarray(amps, np.float32), "harm_amp_table")
    body_nodes = [
        helper.make_node("Gather", ["harm_k_table", "harm_iter"], ["harm_k"], axis=0),
        helper.make_node("Gather", ["harm_amp_table", "harm_iter"], ["harm_a"], axis=0),
        helper.make_node("Mul", [f0_name, "harm_k"], ["harm_kf"]),
        helper.make_node("Less", ["harm_kf", "harm_nyq"], ["harm_lt"]),
        helper.make_node("Cast", ["harm_lt"], ["harm_aa"], to=TensorProto.FLOAT),
        helper.make_node("Mul", [phase_name, "harm_k"], ["harm_kp"]),
        helper.make_node("Sin", ["harm_kp"], ["harm_sin"]),
        helper.make_node("Mul", ["harm_sin", "harm_a"], ["harm_sa"]),
        helper.make_node("Mul", ["harm_sa", "harm_aa"], ["harm_term"]),
        helper.make_node("Add", ["harm_acc_in", "harm_term"], ["harm_acc_out"]),
        # この倍音がどこかのサンプルでナイキスト未満なら続ける（全部超えたら、以降の項は厳密に 0 なので止める）
        helper.make_node("ReduceMax", ["harm_aa"], ["harm_any"], keepdims=0),
        helper.make_node("Greater", ["harm_any", "harm_zero"], ["harm_cond_out"]),
    ]
    body = helper.make_graph(
        body_nodes, "harmonic_sum_body",
        [helper.make_tensor_value_info("harm_iter", TensorProto.INT64, []),
         helper.make_tensor_value_info("harm_cond_in", TensorProto.BOOL, []),
         helper.make_tensor_value_info("harm_acc_in", TensorProto.FLOAT, None)],
        [helper.make_tensor_value_info("harm_cond_out", TensorProto.BOOL, []),
         helper.make_tensor_value_info("harm_acc_out", TensorProto.FLOAT, None)],
        initializer=[K, A, numpy_helper.from_array(np.asarray(nyq, np.float32).reshape(()), "harm_nyq"),
                     numpy_helper.from_array(np.asarray(0.0, np.float32), "harm_zero")])
    loop = helper.make_node("Loop", ["harm_trip", "harm_true", cos[0].output[0]], [final_name], name="/exc/HarmonicLoop", body=body)
    g.initializer.extend([numpy_helper.from_array(np.asarray(n_harm, np.int64), "harm_trip"),
                          numpy_helper.from_array(np.asarray(True), "harm_true")])

    # 古いノードを外し、Loop を最初の Add の位置に入れる
    new_nodes = []
    inserted = False
    for n in g.node:
        if id(n) in remove:
            if not inserted:
                new_nodes.append(loop)
                inserted = True
            continue
        new_nodes.append(n)
    del g.node[:]
    g.node.extend(new_nodes)
    # 使わなくなった定数（k・a）を消す
    used = set()
    for n in g.node:
        used.update(n.input)
        for a in n.attribute:
            if a.name == "body":
                for bn in a.g.node:
                    used.update(bn.input)
    keep = [i for i in g.initializer if i.name in used]
    removed_inits = len(g.initializer) - len(keep)
    del g.initializer[:]
    g.initializer.extend(keep)
    del g.value_info[:]
    onnx.checker.check_model(m)
    onnx.save(m, str(dst))
    return {"n_harm": n_harm, "removed_nodes": len(remove), "removed_initializers": removed_inits,
            "nodes_before": len(remove) + len(g.node) - 1, "nodes_after": len(g.node),
            "bytes_before": src.stat().st_size, "bytes_after": dst.stat().st_size}


CHILD = r'''
import json, resource, sys, time
import numpy as np, onnxruntime as ort
path, T, f0lo, f0hi, seed = sys.argv[1], int(sys.argv[2]), float(sys.argv[3]), float(sys.argv[4]), int(sys.argv[5])
so = ort.SessionOptions(); so.enable_mem_pattern = False; so.intra_op_num_threads = 1
t0 = time.perf_counter()
sess = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
t_create = time.perf_counter() - t0
base = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
rng = np.random.default_rng(seed); NP = 25
durs = np.full(NP, T // NP, np.int64); durs[-1] += T - durs.sum()
feeds = {"tokens": rng.integers(1, 40, (1, NP)).astype(np.int64), "durations": durs[None],
         "f0": np.linspace(f0lo, f0hi, T, dtype=np.float32)[None], "spk_embed": rng.standard_normal((1, 256)).astype(np.float32) * 0.1,
         "exc_noise": rng.standard_normal((1, 256 * T)).astype(np.float32)}
t1 = time.perf_counter(); mel = sess.run(["mel"], feeds)[0]; t_run = time.perf_counter() - t1
t2 = time.perf_counter(); sess.run(["mel"], feeds); t_run2 = time.perf_counter() - t2
peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6
np.save(sys.argv[6], mel)
print(json.dumps({"create_s": round(t_create, 2), "run_s": round(min(t_run, t_run2), 3), "peak_run_MB": round(peak - base)}))
'''


def check(src: Path, dst: Path) -> None:
    tmp = Path("/tmp/acoustic_loop_check")
    tmp.mkdir(exist_ok=True)
    print("ケース: 長さ T・F0 の範囲（Hz）。f0 が低いほど倍音が多く要る")
    for T, lo, hi in [(1346, 200, 300), (1346, 90, 110), (1346, 400, 500), (2692, 200, 300), (5170, 110, 450)]:
        outs = {}
        for tag, p in (("元", src), ("Loop", dst)):
            f = tmp / f"{tag}_{T}_{lo}.npy"
            r = subprocess.run([sys.executable, "-c", CHILD, str(p), str(T), str(lo), str(hi), "0", str(f)], capture_output=True, text=True)
            if r.returncode:
                print(r.stderr[-800:])
                raise SystemExit(1)
            outs[tag] = (json.loads(r.stdout.strip()), np.load(f))
        a, b = outs["元"][1], outs["Loop"][1]
        d = np.abs(a.astype(np.float64) - b.astype(np.float64))
        same = np.array_equal(a.view(np.uint32), b.view(np.uint32))
        print(f"  T={T:5d} f0 {lo:3.0f}-{hi:3.0f}: ビット一致 {'はい' if same else 'いいえ'}（最大の差 {d.max():.2e}、違う値 {int((d > 0).sum())}/{d.size}）"
              f"  元: 実行 {outs['元'][0]['run_s']:.3f} s・ピーク +{outs['元'][0]['peak_run_MB']} MB"
              f"  Loop: 実行 {outs['Loop'][0]['run_s']:.3f} s・ピーク +{outs['Loop'][0]['peak_run_MB']} MB"
              f"（セッション作成 {outs['元'][0]['create_s']} → {outs['Loop'][0]['create_s']} s）")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    info = convert(Path(a.src), Path(a.dst))
    print(json.dumps(info, ensure_ascii=False))
    if a.check:
        check(Path(a.src), Path(a.dst))


if __name__ == "__main__":
    main()
