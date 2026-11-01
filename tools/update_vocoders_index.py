"""Atualiza só a lista "vocoders" do web_index.json a partir de vocoders/*/vocoder.yaml (não precisa do PrettyPitch)."""
import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]
idx_path = ROOT / "web_index.json"
index = json.loads(idx_path.read_text(encoding="utf-8"))
vocs = []
for d in sorted((ROOT / "vocoders").iterdir()):
    f = d / "vocoder.yaml"
    if not f.exists():
        continue
    y = yaml.safe_load(f.read_text(encoding="utf-8"))
    if not y.get("publish", True):
        print(f"{d.name}: publish: false, ignorado")
        continue
    onnx = d / y.get("onnx", "vocoder.onnx")
    grid = y.get("grid") or {}
    vocs.append({"key": d.name, "name": y.get("name", d.name), "kind": y.get("kind", ""),
                 "voice_params": bool(y.get("voice_params", True)), "hop": int(grid.get("hop", y.get("hop", 256))),
                 "gain_db": float(y.get("gain_db", 0.0)), "onnx": onnx.relative_to(ROOT).as_posix(),
                 "bytes": onnx.stat().st_size, "grid": grid})
    print(f"+ {d.name}")
index["vocoders"] = vocs
keys = {v["key"] for v in vocs}
for vb in index["voicebanks"]:
    if vb.get("default_vocoder") not in keys and vocs:
        vb["default_vocoder"] = vocs[0]["key"]
idx_path.write_text(json.dumps(index, ensure_ascii=False, indent=1), encoding="utf-8")
