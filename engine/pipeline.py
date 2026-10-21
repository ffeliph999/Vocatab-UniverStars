"""楽譜 → 音素の長さ・F0 → mel → 波形。PrettyPitch の svs/render.py の段（①〜⑧）と同じ順で、
モデルだけを ONNX（onnxruntime）に置き換えたもの。

    analyze     ① 子音の自然長（cons_dur.onnx）→ ② 持続長の後処理 → ③ F0（f0.onnx）→ ④ ピッチ補正
    synthesize  ⑤ 音響（acoustic.onnx）→ ⑥ mel の後処理 → ⑦ ボコーダ（vocoder.onnx）

ホスト側の処理（G2P・音節分解・floor と圧縮・F0 の baseline と補正・mel の後処理）は PrettyPitch の
Python をそのまま呼ぶ。学習・推論と同じ関数を使うので、入力がずれない（Pages に移すときに TypeScript へ書き直す部分）。
"""
from __future__ import annotations

import hashlib
import json
import sys
import threading
from collections import OrderedDict
from dataclasses import dataclass
from types import SimpleNamespace

import numpy as np
import onnxruntime as ort

from . import voiceparams as VP
from .voicebank import VocoderSpec, Voicebank

PAU = "pau"


def _session(path) -> ort.InferenceSession:
    so = ort.SessionOptions()
    so.enable_mem_pattern = False          # PrettyPitch の export/README: 速さは同じで中間のメモリが約 4 割減る
    so.intra_op_num_threads = 4
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


def _digest(*parts) -> str:
    """配列や値の並びの指紋（段ごとの取り置きの鍵）。"""
    h = hashlib.sha1()
    for p in parts:
        if isinstance(p, np.ndarray):
            h.update(str(p.dtype).encode())
            h.update(np.ascontiguousarray(p).tobytes())
        else:
            h.update(repr(p).encode())
        h.update(b"|")
    return h.hexdigest()


def _retake(noise: np.ndarray, frame_note: np.ndarray, retakes: dict, salt: int) -> None:
    """AI リテイク: 音符 k のフレーム（最後の軸）の雑音だけを、種 retakes[k] の雑音に差し替える（その場で書き換える）。
    種 0 は差し替えない（元のテイク）。"""
    for k, s in retakes.items():
        m = frame_note == int(k)
        if int(s) and m.any():
            alt = np.random.default_rng([int(s), salt]).standard_normal(noise.shape).astype(noise.dtype)
            noise[..., m] = alt[..., m]


MIN_PH_SEC = 0.012  # 手で動かしても、音素はこれより短くしない
PAU_MIN_FRAMES = 4  # pau の後の音素の頭を左へ動かしても、pau はこのフレーム数より短くしない（ボコーダの波形の染み出し）
PAU_MIN_EPS = 1e-4  # 秒。フレームへの丸め（境目ごとの round）で float32 の誤差により 3 フレームにならないための足し


def _apply_shifts(seq, note_index: list, shifts: dict, pau_min: float) -> list:
    """手で動かした音素の頭を、自然な長さ（seq.dur_sec）に当てる。頭を s 秒ずらすと、前の音素が s 延び、自分が s 縮む。
    前が pau（句の頭・句の途中の休符）の音素は、最初に作られた pau の中だけで、pau が pau_min 秒より短くならない所まで
    左へ動かせる（言語・歌い手ごとの閾値は要らない）。
    pau の頭（句の最後の音素の終わり・休符の前の終わり）は動かさない。戻り値は音素ごとに実際に当てたずれ（秒）。"""
    d = np.asarray(seq.dur_sec, np.float64).copy()
    applied = [0.0] * len(d)
    count: dict = {}
    for j, ni in enumerate(note_index):
        if ni < 0:
            continue
        idx = count.get(ni, 0)
        count[ni] = idx + 1
        s = (shifts.get(ni) or {}).get(idx)
        if not s or j == 0:
            continue
        if seq.phonemes[j - 1] == PAU:
            lo = min(-(d[j - 1] - pau_min), 0.0)
        else:
            lo = -(d[j - 1] - MIN_PH_SEC)
        s = float(np.clip(s, lo, d[j] - MIN_PH_SEC))
        d[j - 1] += s
        d[j] -= s
        applied[j] = s
    seq.dur_sec = d.astype(np.float32)
    return applied


class _LRU:
    def __init__(self, size: int):
        self.size, self.d = size, OrderedDict()

    def get(self, k):
        v = self.d.get(k)
        if v is not None:
            self.d.move_to_end(k)
        return v

    def put(self, k, v):
        self.d[k] = v
        self.d.move_to_end(k)
        while len(self.d) > self.size:
            self.d.popitem(last=False)


@dataclass
class PhraseAnalysis:
    """analyze の結果（1 句ぶん）。synthesize はこれと最後の F0 を受け取る。"""
    phonemes: list[str]
    ph_durs: np.ndarray        # 音素ごとのフレーム数（合計 = T）
    start_sec: float           # 句の頭（先頭の pau の頭）を置く絶対時刻
    plain_log2: np.ndarray     # 補正後の抑揚の線（log2 Hz）[T]
    vib_log2: np.ndarray       # ビブラートの成分（log2）[T]
    uv: np.ndarray             # 有声 = 1 [T]
    note_index: list[int]      # 音素ごとの、句の中の音符の番号（pau は -1）
    seed: int = 0              # 乱数の種（F0 の雑音・音響モデルの励振の雑音・ボコーダの雑音）
    shifts: list | None = None  # 音素ごとに当てた頭のずれ（秒。手で動かした分、前後に収まるよう縮めた後）
    # 抑揚の土台（log2 Hz）[T]: 音高の階段を σ 20 ms で丸めたもの（PrettyPitch の baseline）。
    # 抑揚 = plain_log2 − base_log2。画面の「抑揚の強さ」はこの差に掛ける
    base_log2: np.ndarray | None = None


class PrettyPitchLeapSinger:
    """ボイスバンク 1 つぶんのモデル一式（ONNX）。歌い手（話者 id）は呼ぶたびに選べる。"""

    def __init__(self, vb: Voicebank):
        self.vb = vb
        pp_root = str(vb.code["prettypitch"])
        if pp_root not in sys.path:
            sys.path.insert(0, pp_root)
        # PrettyPitch のホスト側の処理（torch のモデルは使わない）
        from duration_model import phoneset as ps_mod
        from duration_model.features import extract_phrase_records, records_to_batch
        from duration_model.profile import from_dict
        from svs import duration_postprocess as dp
        from svs import render as R
        from svs import score_io
        from svs.cons_dur import _flatten
        import infer as pp_infer
        self.dp, self.R, self.score_io, self.pp = dp, R, score_io, pp_infer
        self._flatten, self._extract, self._to_batch = _flatten, extract_phrase_records, records_to_batch
        self.ps = ps_mod.load(vb.language)
        m = vb.models
        self.profile = from_dict(json.loads(m["cons_dur_profile"].read_text(encoding="utf-8")))
        self.f0cfg = json.loads(m["f0"].with_suffix(".json").read_text(encoding="utf-8"))
        spk = json.loads(m["speakers"].read_text(encoding="utf-8"))
        self.spk_vec = {int(k): np.asarray(v, np.float32) for k, v in spk["speakers"].items()}
        self.ph2id = {p: i for i, p in enumerate(spk["phonemes"])}
        # 歌詞に直接書ける音素: 音素表のうち F0 と音響の両方のモデルが知っているもの。
        # 空白で区切っていない所を切るときは、短い名前（3 文字まで。Edge・GlottalStop など内部向けの長い名前は除く）の最長一致
        f0_vocab = set(self.f0cfg["phonemes"])
        self.lyric_set = {p for p in self.ps.phonemes if p in self.ph2id and p in f0_vocab}
        self.lyric_greedy = sorted((p for p in self.lyric_set if len(p) <= 3 and p != "EP"), key=len, reverse=True)
        self.frame_rate = float(self.f0cfg["frame_rate"])
        self.s_cons = _session(m["cons_dur"])
        self.s_f0 = _session(m["f0"])
        self.s_ac = _session(m["acoustic"])
        self.ac_inputs = {i.name for i in self.s_ac.get_inputs()}
        self.cons_inputs = [i.name for i in self.s_cons.get_inputs()]
        self._vocoders: dict[str, ort.InferenceSession] = {}
        self._ac_cache = _LRU(64)          # ⑤⑥ の結果（mel ①）
        self._voc_cache = _LRU(48)         # ⑦ の結果（調波・雑音・包絡。6 秒の句で約 5 MB）
        self.lock = threading.Lock()       # onnxruntime のセッションを 1 本ずつ使う

    # ── 楽譜 → 句 ─────────────────────────────────────────
    def phrases_from_notes(self, notes: list[dict], bpm: float, tpq: int = 480):
        """画面の音符（刻みの位置・長さ・音高・歌詞）→ PrettyPitch の Phrase の列と、句ごとの音符の id。

        音符の隙間は休符にする（0.5 秒以上の休符で句を切る）。重なった音符は前の音符を後ろの頭で切る。
        """
        SN = self.score_io.ScoreNote
        ns = sorted(notes, key=lambda n: n["onset"])
        score, ids, cursor = [], [], 0
        for k, n in enumerate(ns):
            onset = int(n["onset"])
            end = onset + int(n["dur"])
            if k + 1 < len(ns):
                end = min(end, int(ns[k + 1]["onset"]))
            if onset > cursor:
                score.append(SN(dur_beats=(onset - cursor) / tpq, midi=0, lyric=None, is_rest=True))
            onset = max(onset, cursor)
            if end <= onset:
                continue
            lyric = str(n.get("lyric") or "").strip()
            melisma = lyric in ("", "-", "ー", "+")
            score.append(SN(dur_beats=(end - onset) / tpq, midi=int(n["pitch"]),
                            lyric=None if melisma else lyric,
                            phonemes=None if melisma else self._lyric_phonemes(lyric)))
            ids.append(n["id"])
            cursor = end
        phrases = self.score_io.score_to_phrases(score, bpm, phoneset=self.ps)
        out, i = [], 0
        for ph in phrases:
            out.append((ph, ids[i:i + len(ph.notes)]))
            i += len(ph.notes)
        return out

    def _lyric_phonemes(self, lyric: str) -> list[str] | None:
        """英数字だけの歌詞を音素の列にする（仮名を含む歌詞は None。モーラ表に任せる）。
        音素はいくつ並んでもよい（核が複数「k a k i k u」・子音だけ「sh」「s t」・ローマ字の綴りにならない「k r a cl sh u」）。
        空白で区切った記号が音素ならそのまま使い、区切っていない所（「kakiku」「shu」）は音素の名前の最長一致で切る。"""
        if not lyric.isascii():
            return None
        out: list[str] = []
        for tok in lyric.split():
            if tok in self.lyric_set:
                out.append(tok)
                continue
            i = 0
            while i < len(tok):
                m = next((p for p in self.lyric_greedy if tok.startswith(p, i)), None)
                if m is None:
                    raise KeyError(f"歌詞「{lyric}」の「{tok[i:]}」を音素として読めません")
                out.append(m)
                i += len(m)
        return out or None

    # ── ① 子音の自然長（ONNX）──────────────────────────────
    def _cons_naturals(self, phrase, spk_id: int):
        """svs.cons_dur.predict_cons_naturals と同じ組み立てで、モデルだけ cons_dur.onnx にしたもの。"""
        dp, ps = self.dp, self.ps
        onset_nat, coda_nat, core_nat = [], [], []
        for note in phrase.notes:
            onset, nuc, coda = dp.split_syllable(note.phonemes, ps)
            core_only = bool(nuc) and not any(ps.is_nucleus(v) or ps.is_pau(v) for v in nuc)
            onset_nat.append([dp.FALLBACK_CONS_DUR] * len(onset))
            coda_nat.append([dp.FALLBACK_CONS_DUR] * len(coda))
            core_nat.append([dp.FALLBACK_CONS_DUR] * len(nuc) if core_only else [])
        if not phrase.notes:
            return onset_nat, coda_nat, core_nat
        slots = {"onset": onset_nat, "coda": coda_nat, "core": core_nat}
        phs, durs, vals, where = self._flatten(phrase, ps)
        recs = [r for r in self._extract(phs, durs, vals, int(spk_id), 0, phoneset=ps) if r["idx"] in where]
        if recs:
            batch = self._to_batch(recs, device="cpu", phoneset=ps)
            feed = {}
            for name, meta in zip(self.cons_inputs, self.s_cons.get_inputs()):
                a = batch[name].cpu().numpy()
                feed[name] = a.astype(np.int64 if "int64" in meta.type else np.float32)
            pred = self.s_cons.run(["dur_sec"], feed)[0]
            for r, d in zip(recs, pred):
                j, slot, k = where[r["idx"]]
                slots[slot][j][k] = float(d)
        return onset_nat, coda_nat, core_nat

    # ── ③④ F0（ONNX）と補正 ───────────────────────────────
    def _f0(self, seq, spk_id: int, seed: int, note_index=None, retakes=None) -> dict:
        """PrettyPitch の generate_f0 + correct_f0 と同じ。モデルの部分だけ f0.onnx。
        ただし土台は学習時と同じく核音素の音高だけから作る（render の譜面どおりだと子音にも音高が付く）。
        retakes: {句の中の音符の番号: 種}。その音符のフレームだけ、拡散の雑音（x_T と各段の雑音）を差し替える。"""
        pp, cfg = self.pp, self.f0cfg
        score = self.R._f0_score_from_seq(seq, spk_id=spk_id, style_id=0)
        ph_strs, ph_ids, dur_sec, values = pp._read_score(score, cfg)
        T, ph_durs = pp._frame_grid(dur_sec, self.frame_rate)
        from prettypitch.baseline import fill_values
        is_nuc = np.array([p in frozenset(cfg["nucleus"]) for p in ph_strs])
        # 土台は学習時と同じく核音素の音高だけから作る（子音は前の核の音高を引き継ぎ、段は核の頭に来る）。
        # render の譜面は子音にもその音符の音高を付けるので、そのまま使うと段が子音の頭に来て、
        # 有声子音の所で F0 が音程差ぶんずれる（抑揚は学習時の土台からのずれとして学習されている）
        sigma = float(cfg.get("baseline_sigma_sec", 0.02))
        baseline = pp.build_baseline(np.where(is_nuc, values, np.nan), dur_sec, T, self.frame_rate, sigma_sec=sigma)
        if baseline is None:  # 核音素の無い句（子音だけの音符など）: 子音の音高で作る。それも無ければ一定
            baseline = pp.build_baseline(values, dur_sec, T, self.frame_rate, sigma_sec=sigma)
        if baseline is None:
            baseline = np.full(T, np.log2(440.0) + (float(cfg["pitch_center"]) - 69.0) / 12.0, np.float32)
        filled = fill_values(np.where(is_nuc, values, np.nan))
        pitch_midi = np.where(np.isfinite(filled), filled, float(cfg["pitch_center"])).astype(np.float32)
        noise = np.random.default_rng(seed).standard_normal((1, int(cfg["n_noise"]), 2, T)).astype(np.float32)
        if retakes and note_index is not None and len(note_index) == len(ph_durs):
            _retake(noise, np.repeat(np.asarray(note_index), ph_durs)[:T], retakes, salt=3)
        n_styles = int(cfg.get("n_styles", 1))
        style_mix = np.zeros((1, n_styles), np.float32)
        style_mix[0, 0] = 1.0
        plain, vib, vuv = self.s_f0.run(["plain", "vibrato", "vuv"], {
            "tokens": ph_ids[None].astype(np.int64), "pitch_midi": pitch_midi[None],
            "durations": ph_durs[None].astype(np.int64), "spk_id": np.array([spk_id], np.int64),
            "style_mix": style_mix, "noise": noise})
        n = min(T, plain.shape[1])
        plain_delta = plain[0, :n].astype(np.float64)          # plain_std・vib_std はグラフの中で掛け済み
        vib_delta = vib[0, :n].astype(np.float64)
        baseline = baseline[:n]
        phonemes_pf, note_pitches_pf, note_bnd_pf = pp.build_per_frame_arrays(ph_strs, ph_durs, values, n)
        frame_is_pau = np.array([p in pp._SILENCE_PHS for p in phonemes_pf])
        plain_hz = np.power(2.0, baseline + plain_delta).astype(np.float32)
        out = {
            "f0_hz": (plain_hz * np.power(2.0, vib_delta)).astype(np.float32),
            "uv": ((vuv[0, :n] > 0.5) & ~frame_is_pau).astype(np.float32),
            "baseline_log2": baseline.astype(np.float32), "plain_delta": plain_delta.astype(np.float32),
            "vib_delta": vib_delta.astype(np.float32), "note_boundaries_pf": np.asarray(note_bnd_pf, bool),
            "frame_rate": np.float32(self.frame_rate), "plain_hz": plain_hz,
            "phonemes_pf": np.asarray(phonemes_pf), "note_pitches_pf": np.asarray(note_pitches_pf, np.float64),
            "frame_is_pau": frame_is_pau, "nucleus_phs": frozenset(cfg["nucleus"]),
        }
        return pp.correct_f0(out)

    def analyze(self, phrase, spk_id: int, seed: int = 0, f0_retakes: dict | None = None,
                ph_shifts: dict | None = None) -> PhraseAnalysis:
        """①〜④: 1 句の音素・長さ・F0 の部品。
        f0_retakes: {句の中の音符の番号: 種}（AI リテイク。その音符の所だけ F0 の乱数を差し替える）
        ph_shifts: {句の中の音符の番号: {音符の中の音素の番号: 秒}}（手で動かした音素の頭。自然な長さからのずれ）"""
        dp, ps, R = self.dp, self.ps, self.R
        with self.lock:
            ph2 = dp.split_phrase_syllables(phrase, ps)
            on, cd, co = self._cons_naturals(ph2, spk_id)
            seq = dp.postprocess_durations(ph2, self.profile, on, cd, core_nat=co, rest_before=1e9,
                                           phoneset=ps, spk_id=spk_id, style_id=0)
            # 句を置く位置は、手で動かす前の長さで決める（先頭の母音の頭を動かしても句ごと逆にずれないように）
            start_sec, _ = R.phrase_start_sec(ph2, seq, ps)
            # 音素 → 句の中の音符の番号（pau は -1）。音節の頭（note_event_starts）を数え、元の音符へ戻す。
            # 核が複数ある音符（「k a k i k u」など）は split_phrase_syllables で音節ごとに分かれているので、
            # 分けた後の番号のままだと後ろの音符の音素がずれる
            syl2note = [j for j, n in enumerate(phrase.notes) for _ in range(len(dp._syllabify(n.phonemes, ps)))]
            if len(syl2note) != len(ph2.notes):
                syl2note = list(range(len(ph2.notes)))
            note_index, k = [], -1
            for ph, st in zip(seq.phonemes, seq.note_event_starts):
                if st:
                    k += 1
                note_index.append(-1 if ph == PAU else syl2note[min(max(k, 0), len(syl2note) - 1)])
            # pau の後の音素は、最初に作られた pau の中だけで左へ伸ばせる（pau は PAU_MIN_FRAMES 残す）
            applied = _apply_shifts(seq, note_index, ph_shifts or {}, PAU_MIN_FRAMES / self.frame_rate + PAU_MIN_EPS)
            ph_durs, _ = dp.to_frames(seq.dur_sec, self.frame_rate)
            f0o = self._f0(seq, spk_id, seed, note_index, f0_retakes)  # F0 も動かした長さで作る
        T = len(f0o["f0_hz"])
        ph_durs = R._align_durs(ph_durs, T)
        return PhraseAnalysis(
            phonemes=list(seq.phonemes), ph_durs=np.asarray(ph_durs, np.int64), start_sec=float(start_sec),
            plain_log2=np.log2(np.maximum(f0o["plain_hz"], 1e-3)).astype(np.float32),
            vib_log2=np.asarray(f0o["vib_delta"], np.float32), uv=np.asarray(f0o["uv"], np.float32),
            note_index=note_index, seed=int(seed), shifts=applied,
            base_log2=np.asarray(f0o["baseline_log2"], np.float32))

    # ── ⑤⑥⑦ 音響・mel の後処理・ボコーダ ───────────────────
    def vocoder(self, spec: VocoderSpec) -> ort.InferenceSession:
        if spec.key not in self._vocoders:
            self._vocoders[spec.key] = _session(spec.onnx)
        return self._vocoders[spec.key]

    def synthesize(self, an: PhraseAnalysis, f0_hz: np.ndarray, spk_id: int, voc: VocoderSpec,
                   params: dict | None = None, want_plain: bool = False, mel_retakes: dict | None = None) -> dict:
        """⑤〜⑦: 最後の F0（画面で組み立てたもの）とボイスパラメータ（フレームごと）から mel と波形を作る。

        params: {名前: [T] の配列}（voiceparams.NEUTRAL の名前。無いものは既定値）
        want_plain: ボイスパラメータを掛けない音（mel の ② 用）も返す
        戻り値: mel_in（ボコーダに入れた mel）[128, T]、wav [256·T]、wav_plain（頼まれたとき）、uv_hard [T]
        """
        params = params or {}
        T = int(an.ph_durs.sum())
        f0 = np.asarray(f0_hz, np.float32)[:T]
        if len(f0) < T:
            f0 = np.pad(f0, (0, T - len(f0)), mode="edge")
        tokens = np.asarray([self.ph2id[p] for p in an.phonemes], np.int64)
        frame_ph = np.repeat(np.asarray(an.phonemes), an.ph_durs)[:T]
        uv_hard = ((an.uv[:T] > 0.5) & (frame_ph != PAU)).astype(np.float32)
        cons = np.array([not (p == PAU or self.ps.is_nucleus(p)) for p in frame_ph], bool)  # 子音のフレーム
        # 段ごとの取り置き: ⑤⑥ は F0・歌い手が同じなら、⑦ はさらにボコーダが同じなら使い回す
        # （ボイスパラメータはどれもボコーダの出力の後で掛けるので、動かしても混ぜ直すだけになる）
        rt = {int(k): int(s) for k, s in (mel_retakes or {}).items() if int(s)}
        with self.lock:
            ac_key = _digest(an.seed, spk_id, tokens, an.ph_durs, f0, sorted(rt.items()))
            mel_in = self._ac_cache.get(ac_key)
            if mel_in is None:
                mel_in = self._acoustic(an, tokens, f0, spk_id, uv_hard, rt)
                self._ac_cache.put(ac_key, mel_in)
            voc_key = _digest(ac_key, voc.key)
            hit = self._voc_cache.get(voc_key)
            if hit is None:
                # 雑音も句の種から（同じ句なら毎回同じ音）
                vnoise = np.random.default_rng([an.seed, 2]).standard_normal((1, 1, T, 256)).astype(np.float32)
                hit = self._vocode(voc, mel_in, f0, uv_hard, vnoise)
                self._voc_cache.put(voc_key, hit)
            harm, noise, wav0, env_h, env_n = hit
        g = np.float32(10 ** (voc.gain_db / 20)) if voc.gain_db else np.float32(1.0)
        if harm is not None and voc.voice_params:
            # ② 用はボイスパラメータを掛けない音
            plain = np.clip(harm + noise, -1.0, 1.0)[:T * 256] * g if want_plain else None
            h, z = VP.spectral(harm, noise, env_h, env_n, params, T)       # テンション・ジェンダー・響き
            wav = VP.branch_mix(h, z, uv_hard, params, cons) * g            # 枝ごとの音量（ブレシネスなど）
        else:
            if wav0 is None:
                wav0 = np.clip(harm + noise, -1.0, 1.0)
            wav = wav0 * g                                                   # 枝の無いボコーダ（NSF-HiFiGAN）
            plain = wav0[:T * 256] * g if want_plain else None
        wav = VP.finish(wav[:T * 256], params, T)                           # うなり・音量・リミッタ
        return {"mel_in": np.asarray(mel_in, np.float32), "wav": wav, "wav_plain": plain, "uv_hard": uv_hard}

    def _acoustic(self, an: PhraseAnalysis, tokens, f0, spk_id: int, uv_hard, retakes=None) -> np.ndarray:
        """⑤ 音響モデル → ⑥ mel の後処理。戻り値はボコーダに入れる mel [128, T]。
        retakes: {句の中の音符の番号: 種}（AI リテイク。その音符の所だけ励振の雑音を差し替える）"""
        T = len(f0)
        feeds = {"tokens": tokens[None], "durations": an.ph_durs[None], "f0": np.asarray(f0, np.float32)[None],
                 "spk_embed": self.spk_vec[spk_id][None]}
        if "exc_noise" in self.ac_inputs:  # 励振の雑音も句の種から
            z = np.random.default_rng([an.seed, 1]).standard_normal((1, T * 256)).astype(np.float32)
            if retakes:
                fn = np.repeat(np.repeat(np.asarray(an.note_index), an.ph_durs)[:T], 256)
                _retake(z, fn, retakes, salt=1)
            feeds["exc_noise"] = z
        mel = self.s_ac.run(["mel"], feeds)[0]
        mel = np.asarray(mel[0], np.float32).T                                       # [128, T]
        mel_in = self.R.mel_postprocess(SimpleNamespace(frame_rate=self.frame_rate), mel, uv_hard)
        return np.asarray(mel_in, np.float32)

    def _vocode(self, voc: VocoderSpec, mel_in: np.ndarray, f0: np.ndarray, uv_hard: np.ndarray,
                noise: np.ndarray | None = None):
        """mel（hop 256）→ (調波, 雑音, 波形, 調波の包絡, 雑音の包絡)。枝の無いボコーダは波形のほかが None。
        ボコーダの種類ごとの入力の形の違いをここで吸収する。ONNX が雑音の入力と包絡の出力
        （tools/export_nhv_params.py）を持っていれば使う。"""
        sess = self.vocoder(voc)
        if voc.kind == "nhvsing":
            names = {i.name for i in sess.get_inputs()}
            T = mel_in.shape[1]
            feeds = {"mel": np.ascontiguousarray(mel_in.T[None], np.float32),
                     "f0": f0[None, None], "uv": (1.0 - uv_hard)[None, None]}
            if "noise" in names:
                feeds["noise"] = noise if noise is not None else \
                    np.random.default_rng(0).standard_normal((1, 1, T, 256)).astype(np.float32)  # [1,1,T,hop]
            outs = sess.run(None, feeds)
            h, z = (np.asarray(o, np.float32).reshape(-1) for o in outs[1:3])
            # 取り置きを小さくするため、波形は調波 + 雑音から作り直せるので持たず、包絡は float16 で持つ
            env = [np.asarray(o[0], np.float16) for o in outs[3:5]] if len(outs) >= 5 else [None, None]
            return h, z, None, env[0], env[1]
        if voc.kind == "nsf_hifigan" and voc.hop == 512:
            # hop 256 → 512: 隣の 2 フレームを平均（ln-mel の平均、F0 は log の平均）。奇数なら最後を繰り返す
            m, f = mel_in, f0
            if m.shape[1] % 2:
                m = np.concatenate([m, m[:, -1:]], axis=1)
                f = np.concatenate([f, f[-1:]])
            m2 = 0.5 * (m[:, 0::2] + m[:, 1::2])
            f2 = np.exp2(0.5 * (np.log2(np.maximum(f[0::2], 1.0)) + np.log2(np.maximum(f[1::2], 1.0))))
            out = sess.run(["waveform"], {"mel": np.ascontiguousarray(m2.T[None], np.float32),
                                          "f0": f2[None].astype(np.float32)})[0]
            return None, None, np.asarray(out, np.float32).reshape(-1), None, None
        raise ValueError(f"このボコーダの種類には対応していません: {voc.kind}（hop {voc.hop}）")
