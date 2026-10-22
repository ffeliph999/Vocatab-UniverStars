// 左の帯の、選んでいるトラック全体の設定: 「歌い手と声」「音作り」「描画の状況」を開け閉めできる区切りで並べる。
// 音符ごとの設定は音符の小窓（notepop.ts）、書き出しはダイアログ（dialogs.ts）。
import type { Derived } from "./derive";
import { FxPanel } from "./fxpanel";
import { t as tx } from "./i18n";
import { defaultBase, isAudioTrack, type VoiceBase } from "./model";
import type { Renderer } from "./render";
import type { Store } from "./store";
import { trackColor } from "./theme";

export interface SliderOpts {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string;
  def: number; // ダブルクリックで戻す値
  disabled?: boolean;
}

/** 名前・つまみ・値の 1 行。動かしている間は store.changed("project")、離したときに undo を積む。 */
export function slider(store: Store, parent: HTMLElement, o: SliderOpts, onDrag: (on: boolean) => void = () => undefined): () => void {
  const row = document.createElement("div");
  row.className = "field" + (o.disabled ? " disabled" : "");
  row.innerHTML = `<span class="f-label"></span><input type="range" min="${o.min}" max="${o.max}" step="${o.step}">
    <span class="val"></span>`;
  row.querySelector(".f-label")!.textContent = o.label;
  const input = row.querySelector("input")!;
  const val = row.querySelector(".val")!;
  input.disabled = !!o.disabled;
  // 中央（既定値）からの塗り（CSS の --lo・--hi）
  const paint = () => {
    const span = o.max - o.min;
    const v = (o.get() - o.min) / span;
    const d = (o.def - o.min) / span;
    input.style.setProperty("--lo", `${Math.min(v, d) * 100}%`);
    input.style.setProperty("--hi", `${Math.max(v, d) * 100}%`);
  };
  const show = () => {
    input.value = String(o.get());
    val.textContent = o.fmt(o.get());
    paint();
  };
  show();
  let before = "";
  input.addEventListener("pointerdown", () => {
    before = store.snapshot();
    onDrag(true);
  });
  input.addEventListener("input", () => {
    if (!before) before = store.snapshot();
    o.set(Number(input.value));
    val.textContent = o.fmt(o.get());
    paint();
    store.changed("project");
  });
  input.addEventListener("change", () => {
    onDrag(false);
    if (before) store.commit(before);
    before = "";
  });
  input.addEventListener("dblclick", () => {
    const b = store.snapshot();
    o.set(o.def);
    store.commit(b);
    show();
    store.changed("project");
  });
  parent.appendChild(row);
  return show;
}

const VOICE_PARAMS: Array<[keyof VoiceBase, string, number, number, number, (v: number) => string, boolean]> = [
  ["loudness", tx("音量"), -12, 12, 0.1, (v) => `${v.toFixed(1)} dB`, false],
  ["tension", tx("テンション"), -1, 1, 0.01, (v) => v.toFixed(2), true],
  ["breathiness", tx("ブレシネス"), -1, 1, 0.01, (v) => v.toFixed(2), true],
  ["gender", tx("ジェンダー"), -1, 1, 0.01, (v) => v.toFixed(2), true],
  ["voicing", tx("有声度"), 0, 1, 0.01, (v) => v.toFixed(2), true],
  ["consonant", tx("子音の強さ"), -1, 1, 0.01, (v) => v.toFixed(2), true],
  ["resonance", tx("響き"), -1, 1, 0.01, (v) => v.toFixed(2), true],
  ["growl", tx("うなり"), 0, 1, 0.01, (v) => v.toFixed(2), false],
];

type SecKey = "voice" | "fx" | "render";

export class SidePanel {
  /** エンジン（つながっていれば、描画の状況・モデルの名前・使えるボコーダを出す） */
  engine: Renderer | null = null;
  private open = new Set<SecKey>(["voice", "fx"]);
  private refreshers: Array<() => void> = [];
  private dragging = false;
  private wasConnected = false;
  private fx: FxPanel | null = null; // 開いている「音作り」（合成が進んだらイコライザーの後ろのスペクトルを描き直す）

  constructor(private store: Store, private body: HTMLElement, private derived: () => Derived) {
    this.render();
    store.on((kind) => {
      if (kind === "project" || kind === "settings") {
        if (this.dragging) this.refresh();
        else this.render();
      }
    });
  }

  /** 区切りを開く（画面の確認用などで外から）。 */
  openSection(key: SecKey): void {
    this.open.add(key);
    this.render();
  }

  private refresh(): void {
    for (const f of this.refreshers) f();
  }

  /** エンジンの状況が変わったとき。スライダーを動かしている最中は値だけ直す。 */
  update(): void {
    const connected = !!this.engine?.connected;
    this.fx?.refreshSpectrum();
    // 「描画の状況」の見出しの要約は、区切りを閉じていても進み具合に合わせて書き直す
    const rs = this.body.querySelector<HTMLElement>('.acc[data-key="render"] .acc-s');
    if (rs) rs.textContent = this.renderSummary();
    const ae = document.activeElement;
    if (ae && this.body.contains(ae) && (ae.tagName === "INPUT" || ae.tagName === "SELECT")) return;
    if (this.dragging) this.refresh();
    else if (this.open.has("render") || connected !== this.wasConnected) this.render();
    this.wasConnected = connected;
  }

  render(): void {
    const scroll = this.body.scrollTop;
    this.refreshers = [];
    this.fx = null;
    this.body.innerHTML = "";
    const t = this.store.track;
    const audio = isAudioTrack(t);
    if (!audio) {
      this.section("voice", tx("歌い手と声"), `${t.voice} · ${this.store.vocoder === "nsf" ? "NSF-HiFiGAN" : "NHVSing"}`,
                   (el) => this.renderVoice(el));
      this.section("fx", tx("音作り"), this.fxSummary(), (el) => {
        this.fx = new FxPanel(this.store, (title) => {
          const sec = document.createElement("section");
          sec.className = "side-sec";
          sec.innerHTML = `<h3>${title}</h3>`;
          el.appendChild(sec);
          return sec;
        }, () => (this.engine?.phrases(t) ?? []).flatMap((p) => (p.wav ? [p.wav] : [])));
        this.fx.render();
      });
    }
    this.section("render", tx("描画の状況"), this.renderSummary(), (el) => this.renderStatus(el));
    this.body.scrollTop = scroll;
  }

  /** 開け閉めできる区切り。見出しにはトラックの色の印と要約を出す。 */
  private section(key: SecKey, title: string, summary: string, fill: (el: HTMLElement) => void): void {
    const wrap = document.createElement("div");
    wrap.className = "acc" + (this.open.has(key) ? " open" : "");
    const head = document.createElement("button");
    head.className = "acc-h";
    head.innerHTML = `<span class="acc-car">${this.open.has(key) ? "▾" : "▸"}</span><span class="acc-t"></span><span class="acc-s"></span>`;
    head.querySelector(".acc-t")!.textContent = title;
    head.querySelector(".acc-s")!.textContent = summary;
    wrap.dataset.key = key;
    head.addEventListener("click", () => {
      if (this.open.has(key)) this.open.delete(key);
      else this.open.add(key);
      this.render();
    });
    wrap.appendChild(head);
    if (this.open.has(key)) {
      const body = document.createElement("div");
      body.className = "acc-b";
      wrap.appendChild(body);
      fill(body);
    }
    this.body.appendChild(wrap);
  }

  private fxSummary(): string {
    const fx = this.store.track.fx;
    const n = fx ? [fx.eq.on, fx.comp.on, fx.reverb.on].filter(Boolean).length : 0;
    return n ? tx("{n} つ有効", { n }) : tx("なし");
  }

  private renderSummary(): string {
    const eng = this.engine;
    if (!eng?.connected) return tx("エンジン未接続");
    const ps = eng.phrases(this.store.track);
    const done = ps.filter((p) => p.status === "済み").length;
    return done < ps.length ? tx("{done}/{all} 句", { done, all: ps.length }) : tx("済み");
  }

  private renderVoice(el: HTMLElement): void {
    const s = this.store;
    const t = s.track;
    const head = document.createElement("div");
    head.className = "side-sec";
    // 歌い手の選択肢: 全部のボイスバンクの歌い手（ボイスバンクごとにまとめる）。値は「ボイスバンクの key ⇥ 歌い手の名前」
    const eng = this.engine?.connected ? this.engine : null;
    const cur = eng?.voicebankOf(t);
    const opt = (vb: string, n: string, label: string) =>
      `<option value="${vb}\t${n}" ${vb === (cur?.key ?? "") && n === t.voice ? "selected" : ""}>${label}</option>`;
    const options = eng
      ? eng.info!.voicebanks.map((vb) => eng.info!.voicebanks.length > 1
        ? `<optgroup label="${vb.name}">${vb.singers.map((x) => opt(vb.key, x.name, x.name)).join("")}</optgroup>`
        : vb.singers.map((x) => opt(vb.key, x.name, x.name)).join("")).join("")
      : ["ritsu", "natsume", "oniku"].map((n) => opt("", n, n)).join("");
    const LANG_NAMES: Record<string, string> = { ja: tx("日本語"), ko: tx("韓国語") };
    const langCode = cur?.language ?? "ja";
    const lang = LANG_NAMES[langCode] ?? langCode;
    head.innerHTML = `<div class="track-title"><span class="dot"></span><span class="tn"></span></div>
      <div class="row2"><span>${tx("歌い手")}</span><select id="sel-voice">${options}</select></div>
      <div class="row2"><span>${tx("モデル")}</span><span class="muted">${cur ? cur.name
        : tx("エンジン未接続")} · ${lang}</span></div>`;
    head.querySelector<HTMLElement>(".dot")!.style.background = trackColor(s.project, t);
    head.querySelector(".tn")!.textContent = t.name;
    head.querySelector<HTMLSelectElement>("#sel-voice")!.addEventListener("change", (e) => {
      const before = s.snapshot();
      const [vb, name] = (e.target as HTMLSelectElement).value.split("\t");
      t.voice = name;
      if (vb) t.voicebank = vb;
      s.commit(before);
      s.changed("project");
    });
    const seg = document.createElement("div");
    seg.className = "seg";
    seg.title = tx("ボコーダ");
    for (const [key, label] of [["nhv", "NHVSing v3.2.1"], ["nsf", "NSF-HiFiGAN"]] as const) {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = s.vocoder === key ? "on" : "";
      b.addEventListener("click", () => {
        s.vocoder = key;
        s.changed("settings");
      });
      seg.appendChild(b);
    }
    head.appendChild(seg);
    if (s.vocoder === "nsf") {
      head.insertAdjacentHTML("beforeend", `<p class="hint">${tx("NSF-HiFiGAN には調波と雑音の枝が無いので、音量・うなりのほかは効きません。")}</p>`);
      if (this.engine?.connected && !this.engine.hasVocoder("nsf")) {
        head.insertAdjacentHTML("beforeend",
          `<p class="hint warn">${tx("NSF-HiFiGAN の ONNX がまだ vocoders/ に無いので、今は NHVSing で鳴らしています。")}</p>`);
      }
    }
    el.appendChild(head);

    const base = document.createElement("div");
    base.className = "side-sec";
    base.innerHTML = `<h3>${tx("声の調整")}<span class="h-note">${tx("ダブルクリックで元に戻す")}</span></h3>`;
    for (const [key, label, min, max, step, fmt, vp] of VOICE_PARAMS) {
      this.refreshers.push(slider(s, base, {
        label, min, max, step, fmt, def: defaultBase()[key], disabled: vp && s.vocoder === "nsf",
        get: () => t.base[key], set: (v) => { t.base[key] = v; },
      }, (on) => { this.dragging = on; }));
    }
    el.appendChild(base);
  }

  private renderStatus(el: HTMLElement): void {
    const sec = document.createElement("div");
    sec.className = "side-sec";
    el.appendChild(sec);
    const eng = this.engine;
    const st = (s: string) => ({ 解析済み: tx("解析済み"), 合成中: tx("合成中"), 済み: tx("済み"), 失敗: tx("失敗") } as Record<string, string>)[s] ?? s;
    if (eng?.connected) {
      if (eng.error) sec.insertAdjacentHTML("beforeend", `<p class="hint warn">${eng.error}</p>`);
      for (const t of this.store.project.tracks) {
        if (isAudioTrack(t)) continue;
        const ul = document.createElement("ul");
        ul.className = "phrase-list";
        ul.insertAdjacentHTML("beforeend", `<li class="muted"><span></span><span></span><span></span></li>`);
        ul.querySelector("li span")!.textContent = t.name;
        eng.phrases(t).forEach((p, i) => {
          const a = p.startFrame / 172.265625;
          const b = (p.startFrame + p.nFrames) / 172.265625;
          ul.insertAdjacentHTML("beforeend", `<li><span>${tx("句 {i}", { i: i + 1 })}</span><span>${a.toFixed(2)}–${b.toFixed(2)} s</span>
            <span class="${p.status === "済み" ? "ok" : "muted"}">${st(p.status)}</span></li>`);
        });
        sec.appendChild(ul);
      }
      return;
    }
    sec.insertAdjacentHTML("beforeend",
      `<p class="hint">${tx("エンジンは未接続です（モック）。句ごとの計算の状況がここに並びます。")}</p>`);
    const d = this.derived();
    const phrases: Array<[number, number]> = [];
    const spans = [...d.noteSec.values()].sort((a, b) => a.start - b.start);
    for (const sp of spans) {
      const last = phrases[phrases.length - 1];
      if (last && sp.start - last[1] < 0.5) last[1] = Math.max(last[1], sp.end);
      else phrases.push([sp.start, sp.end]);
    }
    const ul = document.createElement("ul");
    ul.className = "phrase-list";
    phrases.forEach(([a, b], i) => {
      ul.insertAdjacentHTML("beforeend",
        `<li><span>${tx("句 {i}", { i: i + 1 })}</span><span>${a.toFixed(2)}–${b.toFixed(2)} s</span><span class="muted">${tx("未計算")}</span></li>`);
    });
    sec.appendChild(ul);
  }
}
