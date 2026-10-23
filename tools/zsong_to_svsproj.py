"""zhejiang_university の自作エディタのプロジェクト（.zsong）を、VocaTab のプロジェクト（.svsproj）にする。

    python tools/zsong_to_svsproj.py <.zsong> [<.zsong> ...] [--out <dir>] [--voice ritsu] [--no-copy]

- 出力: svs_data/project/<名前>.svsproj（--out で変える）。元の .zsong は svs_data/score/zsong/ に写しを置く（--no-copy で置かない）
- 読むもの: テンポ・拍子・音符（onset_beats・duration_beats・pitch_midi・lyrics）。拍は 4 分音符 = 480 刻み
- 読まないもの: 手で決めた音素（phonemes）・子音の長さ（cons_dur）、モデルや合成の設定（歌い手の番号も別のモデルのもの）
  → 歌詞から作り直す。読まなかったものがあれば知らせる
- 形式は ui/src/projectfile.ts（format "svs-editor-project"、formatVersion 1）と ui/src/model.ts の Project に合わせる
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

TPQ = 480
ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "svs_data"

# ui/src/model.ts の defaultAttrs・defaultBase と同じ値
DEFAULT_ATTRS = {"vMod": 1}
DEFAULT_BASE = {"loudness": 0, "tension": 0, "breathiness": 0, "gender": 0, "voicing": 1, "consonant": 0,
                "resonance": 0, "growl": 0}


def convert(src: Path, voice: str) -> tuple[dict, list[str]]:
    z = json.loads(src.read_text(encoding="utf-8"))
    pj = z.get("project", {})
    warns: list[str] = []
    num, den = (pj.get("time_signature") or [4, 4])[:2]
    if den != 4:
        warns.append(f"拍子 {num}/{den}: 4 分音符を 1 拍として、1 小節 {num} 拍で読みます")
    raw = sorted(z.get("notes", []), key=lambda n: n["onset_beats"])
    if any(n.get("phonemes") for n in raw):
        warns.append("手で決めた音素（phonemes）は読みません（歌詞から作り直します）")
    if any(n.get("cons_dur") for n in raw):
        warns.append("手で決めた子音の長さ（cons_dur）は読みません")
    notes = []
    for i, n in enumerate(raw, 1):
        notes.append({
            "id": i,
            "onset": round(n["onset_beats"] * TPQ),
            "dur": max(1, round(n["duration_beats"] * TPQ)),
            "pitch": int(n["pitch_midi"]),
            "lyric": (n.get("lyrics") or "").strip() or "-",
            "attrs": dict(DEFAULT_ATTRS),
        })
    # 重なる音符（前の音符の終わりより前に次が始まる）は、前の音符を次の頭で切る（長さの端数のずれが多いため）
    cut = []
    for a, b in zip(notes, notes[1:]):
        if a["onset"] + a["dur"] > b["onset"] > a["onset"]:
            cut.append(f"{a['lyric']}（{a['onset'] / TPQ:g} 拍目、{(a['onset'] + a['dur'] - b['onset']) / TPQ:g} 拍）")
            a["dur"] = b["onset"] - a["onset"]
    if cut:
        warns.append("次の音符に重なっていたので、次の頭で切りました: " + "、".join(cut))
    bar = num * TPQ
    region = ({"start": math.floor(min(n["onset"] for n in notes) / bar) * bar,
               "end": math.ceil(max(n["onset"] + n["dur"] for n in notes) / bar) * bar} if notes
              else {"start": 0, "end": bar})
    track = {"id": 1, "name": pj.get("title") or src.stem, "voice": voice, "color": "", "notes": notes,
             "mute": False, "solo": False, "region": region, "base": dict(DEFAULT_BASE), "params": {}}
    project = {"bpm": float(pj.get("bpm") or 120), "beatsPerBar": int(num), "tracks": [track], "activeTrack": 0}
    out = {"format": "svs-editor-project", "formatVersion": 1,
           "savedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
           "project": project}
    return out, warns


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("src", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, default=DATA / "project")
    ap.add_argument("--voice", default="ritsu", help="歌い手（voicebank の名前。既定 ritsu）")
    ap.add_argument("--no-copy", action="store_true", help="元の .zsong を svs_data/score/zsong/ に写さない")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for src in a.src:
        if src.suffix.lower() != ".zsong":
            print(f"飛ばしました（.zsong ではない）: {src}", file=sys.stderr)
            continue
        proj, warns = convert(src, a.voice)
        dst = a.out / f"{src.stem}.svsproj"
        dst.write_text(json.dumps(proj, ensure_ascii=False, indent=1), encoding="utf-8")
        p = proj["project"]
        t = p["tracks"][0]
        end_sec = t["region"]["end"] / TPQ * 60 / p["bpm"]
        print(f"{src.name} → {dst}（{len(t['notes'])} 音符、{p['bpm']:g} BPM、{p['beatsPerBar']}/4、約 {end_sec:.0f} 秒）")
        for w in warns:
            print(f"  注意: {w}")
        if not a.no_copy:
            keep = DATA / "score" / "zsong"
            keep.mkdir(parents=True, exist_ok=True)
            if src.resolve() != (keep / src.name).resolve():
                shutil.copy2(src, keep / src.name)


if __name__ == "__main__":
    main()
