"""歌声データベースからブレス（息継ぎ）の候補を集め、聴いて選ぶためのページを書く（手元だけで使う）。

ラベルに br がある区間はそのまま候補にする。ほかの休符（pau・sil、0.25 秒以上で次が有声音のもの）は、
中の短時間 RMS が雑音床 + しきい値（dB）を 0.12〜0.9 秒超える塊をブレスの候補にし、無声（Praat のピッチが立たない）
ものだけ残す。候補ごとに、その直後のフレーズ（次の 0.5 秒以上の休符まで）の RMS も測っておき、ブレスの音量は
「フレーズに対する比」で扱う（build_breath_bank.py が、合成した声の音量に合わせて正規化する。録音ごとの音量差を
持ち込まないため）。歌手ごとに雑音との差が大きい順に上位 N 個を wav に書き、index.html で聴いてチェックを入れると
selected.json を保存できる（それを build_breath_bank.py に渡す）。聴くための wav はフレーズが −18 dBFS になる倍率で
そろえてあるので、候補どうしの音量の比較は自然な比のまま。

    python tools/breaths/extract_breath_candidates.py --out research/2026-10-23_breaths [--top 30]

元の録音は配らない（規約）。ここで書く wav は選ぶための一時的なもの。
"""
from __future__ import annotations

import argparse
import html
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44_100
SIL = {"pau", "sil", "br", "sp", "AP", "SP"}
DB_ROOT = Path("/Volumes/ssd2t/singing_database")

# ボイスバンク leapsinger_ja_3singer の歌い手 id: 0 oniku, 1 natsume, 2 ritsu
SOURCES = {
    "oniku": {"singer": 0, "pairs": lambda: [(p, p.with_suffix(".wav"))
                                            for p in sorted((DB_ROOT / "ONIKU_KURUMI_UTAGOE_DB").glob("*/*.lab"))]},
    "natsume": {"singer": 1, "pairs": lambda: [(p, DB_ROOT / "Natsume_Singing_DB_0713" / "wav" / (p.stem + ".wav"))
                                              for p in sorted((DB_ROOT / "Natsume_Singing_DB_0713" / "mono_label").glob("*.lab"),
                                                              key=lambda q: int(q.stem) if q.stem.isdigit() else 0)]},
    "ritsu": {"singer": 2, "pairs": lambda: [(p, p.with_suffix(".wav"))
                                            for p in sorted((DB_ROOT / "Ritu_Singing_DB_Ver2.0-2.2" / "DATABASE").glob("*/*.lab"))]},
}


@dataclass
class Candidate:
    id: str
    singer_name: str
    singer: int
    src_wav: str
    song: str
    start: float          # 秒（元の録音の中）
    end: float
    sec: float
    snr_db: float         # 塊のピーク RMS − 雑音床
    voiced: float         # Praat で有声と出たフレームの割合（0 が望ましい）
    labeled: bool         # ラベルの br か
    breath_rms_db: float  # ブレスの区間の RMS（dBFS、元の録音）
    phrase_rms_db: float  # 直後のフレーズ（次の 0.5 秒以上の休符まで）の RMS（dBFS、元の録音）。音量の比の基準
    listen_gain_db: float = 0.0   # 聴くための wav に掛けた倍率（フレーズが −18 dBFS になる値。本番では使わない）


def read_lab(path: Path) -> list[tuple[float, float, str]]:
    out = []
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split()
        if len(parts) < 3:
            continue
        a, b = float(parts[0]), float(parts[1])
        if a > 1e4 or b > 1e4:      # 100 ns 単位（Sinsy 形式）
            a, b = a * 1e-7, b * 1e-7
        out.append((a, b, parts[2]))
    return out


def load_mono_44k(path: Path) -> np.ndarray:
    y, sr = sf.read(str(path), dtype="float64", always_2d=True)
    y = y.mean(axis=1)
    if sr != SR:
        import soxr
        y = soxr.resample(y, sr, SR, quality="HQ")
    return y


def frame_rms_db(y: np.ndarray, frame: int, hop: int) -> np.ndarray:
    if len(y) < frame:
        return np.array([])
    n = 1 + (len(y) - frame) // hop
    idx = np.arange(frame)[None, :] + hop * np.arange(n)[:, None]
    seg = y[idx]
    return 20 * np.log10(np.sqrt(np.mean(seg * seg, axis=1)) + 1e-9)


def voiced_fraction(y: np.ndarray) -> float:
    try:
        import parselmouth
        snd = parselmouth.Sound(y.astype(np.float64), sampling_frequency=SR)
        pitch = snd.to_pitch_ac(time_step=0.01, pitch_floor=75, pitch_ceiling=1000)
        f0 = pitch.selected_array["frequency"]
        return float(np.mean(f0 > 0)) if len(f0) else 0.0
    except Exception:
        return 1.0   # 計れないものは有声扱いで落とす


def rms_db(y: np.ndarray) -> float:
    return float(20 * np.log10(np.sqrt(np.mean(y * y)) + 1e-9)) if len(y) else -120.0


def phrase_after(segs: list[tuple[float, float, str]], k: int, split_sec: float = 0.5) -> tuple[float, float]:
    """休符 segs[k] の直後のフレーズの区間（秒）: 次の音素から、0.5 秒以上の休符（= エンジンのフレーズの切れ目）の手前まで。"""
    s = segs[k + 1][0] if k + 1 < len(segs) else segs[k][1]
    e = s
    for a, b, ph in segs[k + 1:]:
        if ph in SIL and b - a >= split_sec:
            break
        e = b
    return s, e


def runs_above(mask: np.ndarray, hop_sec: float, gap_sec: float) -> list[tuple[int, int]]:
    """mask が真の区間（[始, 終) のフレーム番号）。gap_sec 未満の切れ目はつなぐ。"""
    runs = []
    i = 0
    n = len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        runs.append([i, j])
        i = j
    merged: list[list[int]] = []
    for r in runs:
        if merged and (r[0] - merged[-1][1]) * hop_sec < gap_sec:
            merged[-1][1] = r[1]
        else:
            merged.append(r)
    return [(a, b) for a, b in merged]


def find_in_song(name: str, singer: int, lab: Path, wav: Path, *, thresh_db: float, min_sec: float, max_sec: float,
                 margin: float) -> list[Candidate]:
    segs = read_lab(lab)
    if not segs:
        return []
    y = load_mono_44k(wav)
    frame, hop = int(0.010 * SR), int(0.005 * SR)
    hop_sec = hop / SR
    # 雑音床: その曲の休符の中の RMS の下位 2 割
    floor_frames = []
    for a, b, ph in segs:
        if ph in SIL and b - a >= 0.1:
            floor_frames.append(frame_rms_db(y[int(a * SR):int(b * SR)], frame, hop))
    if not floor_frames:
        return []
    floor = float(np.percentile(np.concatenate(floor_frames), 20))
    out: list[Candidate] = []
    for k, (a, b, ph) in enumerate(segs):
        if ph not in SIL:
            continue
        nxt = segs[k + 1][2] if k + 1 < len(segs) else None
        if nxt is None or nxt in SIL:
            continue
        ps, pe = phrase_after(segs, k)
        if pe - ps < 0.3:
            continue
        phrase_db = rms_db(y[int(ps * SR):int(pe * SR)])
        if ph == "br":
            s, e = max(0.0, a - margin), min(len(y) / SR, b + margin)
            clip = y[int(s * SR):int(e * SR)]
            rms = frame_rms_db(clip, frame, hop)
            snr = float(rms.max() - floor) if len(rms) else 0.0
            out.append(Candidate(f"{name}_{lab.stem}_{a:.2f}", name, singer, str(wav), lab.stem, s, e, e - s, snr,
                                 voiced_fraction(clip), True, rms_db(clip), phrase_db))
            continue
        if b - a < 0.25:
            continue
        seg = y[int(a * SR):int(b * SR)]
        rms = frame_rms_db(seg, frame, hop)
        if len(rms) == 0:
            continue
        for i0, i1 in runs_above(rms > floor + thresh_db, hop_sec, 0.04):
            dur = (i1 - i0) * hop_sec
            if not (min_sec <= dur <= max_sec):
                continue
            s = max(a, a + i0 * hop_sec - margin)
            e = min(b, a + i1 * hop_sec + frame / SR + margin)
            clip = y[int(s * SR):int(e * SR)]
            vf = voiced_fraction(clip)
            if vf > 0.15:
                continue
            snr = float(rms[i0:i1].max() - floor)
            out.append(Candidate(f"{name}_{lab.stem}_{s:.2f}", name, singer, str(wav), lab.stem, s, e, e - s, snr, vf, False,
                                 rms_db(clip), phrase_db))
    return out


def write_clip(c: Candidate, path: Path, cache: dict[str, np.ndarray]) -> None:
    y = cache.get(c.src_wav)
    if y is None:
        y = load_mono_44k(Path(c.src_wav))
        cache.clear()
        cache[c.src_wav] = y
    clip = y[int(c.start * SR):int(c.end * SR)].copy()
    fade = int(0.005 * SR)
    if len(clip) > 2 * fade:
        clip[:fade] *= np.linspace(0, 1, fade)
        clip[-fade:] *= np.linspace(1, 0, fade)
    # 直後のフレーズが −18 dBFS になる倍率（候補どうしでブレスとフレーズの比が見える）。割れるときだけ下げる
    gain = 10 ** ((-18.0 - c.phrase_rms_db) / 20)
    peak = float(np.abs(clip).max()) or 1.0
    gain = min(gain, 0.98 / peak)
    c.listen_gain_db = round(20 * np.log10(gain), 1)
    sf.write(str(path), np.clip(clip * gain, -1, 1), SR, subtype="PCM_16")


def write_page(out: Path, cands: dict[str, list[Candidate]]) -> None:
    secs = []
    for name, cs in cands.items():
        items = []
        for c in cs:
            items.append(
                f'<label class="c"><input type="checkbox" data-id="{html.escape(c.id)}" data-singer="{name}">'
                f'<span class="n">{html.escape(c.id)}</span>'
                f'<span class="m">{c.sec:.2f} s · 雑音との差 {c.snr_db:.0f} dB · フレーズとの差 {c.breath_rms_db - c.phrase_rms_db:.0f} dB'
                f' · 有声 {c.voiced * 100:.0f} %{" · ラベル br" if c.labeled else ""}</span>'
                f'<span class="l">録音</span><audio controls preload="none" src="{name}/{html.escape(c.id)}.wav"></audio>'
                + (f'<span class="l">ボコーダを通した音（エディタで鳴る音）</span>'
                   f'<audio controls preload="none" src="voc/{html.escape(c.id)}_voc.wav"></audio>'
                   if (out / "voc" / f"{c.id}_voc.wav").exists() else "")
                + '</label>')
        secs.append(f"<section><h2>{name}（{len(cs)} 個）</h2><div class=\"grid\">{''.join(items)}</div></section>")
    page = f"""<!doctype html>
<meta charset="utf-8"><title>ブレスの候補</title>
<style>
body{{font-family:-apple-system,"Hiragino Sans",sans-serif;background:#0b0d16;color:#e7e9f3;margin:0;padding:24px;line-height:1.5}}
h1{{font-size:20px}} h2{{font-size:16px;margin:28px 0 8px}} p{{color:#878ca4;max-width:60em}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:10px}}
.c{{display:grid;gap:4px;padding:10px;border:1px solid #232839;border-radius:10px;background:#11141f}}
.c:has(input:checked){{border-color:#909dff;background:#161a28}}
.n{{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#878ca4;word-break:break-all}}
.m{{font-size:12px}} .l{{font-size:11px;color:#878ca4;margin-top:4px}} audio{{width:100%;height:32px}}
.bar{{position:sticky;top:0;background:#0b0d16;padding:8px 0;border-bottom:1px solid #232839;display:flex;gap:12px;align-items:center}}
button{{font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid #909dff;background:#161a28;color:#e7e9f3;cursor:pointer}}
</style>
<h1>ブレスの候補</h1>
<p>歌手ごとに 4〜8 個、自然で雑音の少ないものにチェックを入れて「選んだものを保存」を押すと selected.json がダウンロードされます。
それをこのフォルダに置いて build_breath_bank.py に渡します。音量は「直後のフレーズが −18 dBFS」になるようにそろえてあるので、
候補どうしの大小は歌の中での自然な比です（本番では合成した声の音量に合わせます）。</p>
<div class="bar"><button id="save">選んだものを保存（selected.json）</button><span id="count"></span></div>
{''.join(secs)}
<script>
const boxes=[...document.querySelectorAll('input[type=checkbox]')];
const count=document.getElementById('count');
const upd=()=>{{const by={{}};for(const b of boxes)if(b.checked)(by[b.dataset.singer]??=[]).push(b.dataset.id);
count.textContent=Object.entries(by).map(([k,v])=>k+' '+v.length).join(' · ')||'まだ選んでいません';return by;}};
boxes.forEach(b=>b.addEventListener('change',upd));upd();
document.getElementById('save').onclick=()=>{{const by=upd();
const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(by,null,1)],{{type:'application/json'}}));
a.download='selected.json';a.click();}};
</script>
"""
    (out / "index.html").write_text(page, encoding="utf-8")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--top", type=int, default=30, help="歌手ごとに残す候補の数")
    ap.add_argument("--thresh-db", type=float, default=12.0)
    ap.add_argument("--min-sec", type=float, default=0.12)
    ap.add_argument("--max-sec", type=float, default=0.9)
    ap.add_argument("--margin", type=float, default=0.02)
    ap.add_argument("--only", nargs="*", help="歌手の名前（oniku natsume ritsu）を絞る")
    ap.add_argument("--page-only", action="store_true", help="candidates.json から index.html だけ書き直す（voc/ があれば並べる）")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    if a.page_only:
        saved = json.loads((out / "candidates.json").read_text(encoding="utf-8"))
        write_page(out, {k: [Candidate(**c) for c in v] for k, v in saved.items()})
        print(f"{out / 'index.html'} を書き直した")
        return
    chosen: dict[str, list[Candidate]] = {}
    for name, src in SOURCES.items():
        if a.only and name not in a.only:
            continue
        pairs = [(lab, wav) for lab, wav in src["pairs"]() if wav.exists()]
        cands: list[Candidate] = []
        for i, (lab, wav) in enumerate(pairs):
            try:
                found = find_in_song(name, src["singer"], lab, wav, thresh_db=a.thresh_db, min_sec=a.min_sec,
                                     max_sec=a.max_sec, margin=a.margin)
            except Exception as e:   # 読めない曲は飛ばす
                print(f"  {lab.stem}: 読めない（{e}）", flush=True)
                continue
            cands.extend(found)
            print(f"{name} {i + 1}/{len(pairs)} {lab.stem}: {len(found)} 個（計 {len(cands)}）", flush=True)
        # 並べ方: ラベルの br を先に、あとは雑音との差が大きい順。長さが 0.2〜0.6 秒から外れるものは少し後ろへ
        cands.sort(key=lambda c: (-int(c.labeled), -(c.snr_db - 6 * max(0.0, 0.2 - c.sec, c.sec - 0.6) * 10)))
        # 同じ曲に偏らないよう、1 曲から多くても 3 個
        per_song: dict[str, int] = {}
        picked = []
        for c in cands:
            if per_song.get(c.song, 0) >= 3:
                continue
            per_song[c.song] = per_song.get(c.song, 0) + 1
            picked.append(c)
            if len(picked) >= a.top:
                break
        d = out / name
        d.mkdir(exist_ok=True)
        cache: dict[str, np.ndarray] = {}
        for c in picked:
            write_clip(c, d / f"{c.id}.wav", cache)
        chosen[name] = picked
        print(f"{name}: 候補 {len(cands)} 個 → {len(picked)} 個を書いた", flush=True)
    (out / "candidates.json").write_text(
        json.dumps({k: [asdict(c) for c in v] for k, v in chosen.items()}, ensure_ascii=False, indent=1), encoding="utf-8")
    write_page(out, chosen)
    print(f"{out / 'index.html'} を開いて選んでください")


if __name__ == "__main__":
    sys.exit(main())
