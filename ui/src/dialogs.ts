// ダイアログ: 書き出し（WAV）と設定（言語・差し色・mel の配色）。
import { buildExports, download } from "./export";
import { getLang, type Lang, LANGS, t } from "./i18n";
import { assembleWav, type Renderer } from "./render";
import type { Store } from "./store";
import {
  ACCENT_PRESETS, DEFAULT_ACCENT, getAccent, getMelMap, MEL_MAPS, type MelMapKey, melGradient, setAccent, setMelMap,
  trackColor,
} from "./theme";

/** 画面の真ん中に出す枠。外側を押すか Esc で閉じる。 */
function modal(title: string, onClose: () => void = () => undefined): { box: HTMLElement; close: () => void } {
  const back = document.createElement("div");
  back.className = "modal-back";
  const box = document.createElement("div");
  box.className = "modal dialog";
  box.innerHTML = `<div class="dlg-head"><h3></h3><button class="icon-btn" title="${t("閉じる（Esc）")}">✕</button></div>`;
  box.querySelector("h3")!.textContent = title;
  back.appendChild(box);
  document.body.appendChild(back);
  const close = () => {
    back.remove();
    window.removeEventListener("keydown", onKey, true);
    onClose();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  window.addEventListener("keydown", onKey, true);
  back.addEventListener("pointerdown", (e) => { if (e.target === back) close(); });
  box.querySelector(".dlg-head button")!.addEventListener("click", close);
  return { box, close };
}

/** 書き出し: ファイル名・書き出すもの（ミックスとトラックごと）・形式を選んで WAV を作る（計算は export.ts）。 */
export function openExportDialog(store: Store, engine: Renderer | null): void {
  const { box } = modal(t("書き出し"), () => clearInterval(timer));
  const o = store.exportOpts;
  const p = store.project;
  const body = document.createElement("div");
  body.className = "dlg-body";
  body.innerHTML = `
    <div class="row2"><span>${t("ファイル名")}</span><input id="ex-name" type="text"></div>
    <div class="dlg-sub">${t("書き出すもの")}</div>
    <div class="check-list" id="ex-list"></div>
    <div class="btn-row"><button class="small" id="ex-all">${t("全部選ぶ")}</button><button class="small" id="ex-none">${t("全部外す")}</button></div>
    <div class="dlg-sub">${t("形式（44.1 kHz）")}</div>
    <div class="row2"><span>${t("チャンネル")}</span><select id="ex-ch"><option value="2">${t("ステレオ")}</option><option value="1">${t("モノ（パンは掛けない）")}</option></select></div>
    <div class="row2"><span>${t("ビット深度")}</span><select id="ex-bits"><option value="16">16 bit</option>
      <option value="24">24 bit</option><option value="32">${t("32 bit 浮動小数")}</option></select></div>
    <label class="check"><input id="ex-bypass" type="checkbox"> ${t("トラックの音量とパンを掛けない")}</label>
    <label class="check"><input id="ex-nofx" type="checkbox"> ${t("エフェクトを掛けない")}</label>
    <button id="ex-go" class="wide-btn primary"></button>
    <p class="hint" id="ex-msg"></p>`;
  box.appendChild(body);
  const $ = <T extends HTMLElement>(id: string) => body.querySelector<T>(`#${id}`)!;
  const name = $<HTMLInputElement>("ex-name");
  name.value = o.fileName;
  name.addEventListener("input", () => { o.fileName = name.value.trim() || t("無題"); });
  const bypass = $<HTMLInputElement>("ex-bypass");
  bypass.checked = o.bypassMix;
  bypass.addEventListener("change", () => { o.bypassMix = bypass.checked; });
  const nofx = $<HTMLInputElement>("ex-nofx");
  nofx.checked = o.bypassFx;
  nofx.addEventListener("change", () => { o.bypassFx = nofx.checked; });
  const ch = $<HTMLSelectElement>("ex-ch");
  ch.value = String(o.channels);
  ch.addEventListener("change", () => { o.channels = Number(ch.value) as 1 | 2; });
  const bits = $<HTMLSelectElement>("ex-bits");
  bits.value = String(o.bitDepth);
  bits.addEventListener("change", () => { o.bitDepth = Number(bits.value) as 16 | 24 | 32; });

  const list = $("ex-list");
  o.trackIds = o.trackIds.filter((id) => p.tracks.some((tr) => tr.id === id));
  const renderList = () => {
    list.innerHTML = "";
    const add = (label: string, color: string, checked: boolean, set: (v: boolean) => void) => {
      const l = document.createElement("label");
      l.className = "check";
      l.style.borderLeftColor = color;
      l.innerHTML = `<input type="checkbox"> <span></span>`;
      l.querySelector("span")!.textContent = label;
      const c = l.querySelector("input")!;
      c.checked = checked;
      c.addEventListener("change", () => { set(c.checked); update(); });
      list.appendChild(l);
    };
    add(t("ミックス（全トラックをまとめる。消音・ソロに従う）"), "var(--accent)", o.mixdown, (v) => { o.mixdown = v; });
    for (const tr of p.tracks) {
      add(tr.name, trackColor(p, tr), o.trackIds.includes(tr.id), (v) => {
        o.trackIds = v ? [...o.trackIds, tr.id] : o.trackIds.filter((x) => x !== tr.id);
      });
    }
  };
  $("ex-all").addEventListener("click", () => { o.mixdown = true; o.trackIds = p.tracks.map((tr) => tr.id); renderList(); update(); });
  $("ex-none").addEventListener("click", () => { o.mixdown = false; o.trackIds = []; renderList(); update(); });

  const go = $<HTMLButtonElement>("ex-go");
  const msg = $("ex-msg");
  let exporting = false;
  const update = () => {
    const pending = engine?.connected ? engine.pending() : -1;
    const n = (o.mixdown ? 1 : 0) + o.trackIds.length;
    go.disabled = pending !== 0 || n === 0 || exporting;
    go.textContent = exporting ? t("書き出し中…") : pending > 0 ? t("描画中（あと {n} 句）", { n: pending })
      : t("書き出す（{n} ファイル）", { n });
    if (!exporting && !msg.dataset.done) {
      msg.textContent = pending < 0 ? t("エンジンにつながっていないので書き出せません。")
        : n === 0 ? t("書き出すものを選んでください。") : "";
    }
  };
  renderList();
  update();
  // 描画が進むと書き出せるようになるので、開いている間は時々見直す
  const timer = window.setInterval(update, 500);
  go.addEventListener("click", () => {
    if (!engine) return;
    exporting = true;
    update();
    void buildExports(p, (tr) => assembleWav(engine.phrases(tr)), o).then((files) => {
      download(files);
      msg.dataset.done = "1";
      msg.textContent = t("書き出しました: {names}", { names: files.map((f) => f.name).join(", ") });
    }).catch((e) => {
      msg.dataset.done = "1";
      msg.textContent = t("書き出しに失敗しました: {e}", { e: String(e) });
    }).finally(() => {
      exporting = false;
      update();
    });
  });
}

/** 設定: 言語・差し色（音符・強調の色）・mel の配色。ブラウザに保存する。
 *  onLang: 言語を選んだとき（画面を読み込み直す。自動保存を済ませてから） */
export function openSettingsDialog(onLang: (l: Lang) => void = () => undefined): void {
  const { box } = modal(t("設定"));
  const body = document.createElement("div");
  body.className = "dlg-body";
  box.appendChild(body);
  const render = () => {
    const acc = getAccent();
    const mm = getMelMap();
    body.innerHTML = `
      <div class="dlg-sub">${t("画面の言語")}<span class="h-note">${t("変えると画面を読み込み直します（編集中の内容は自動保存から続きます）")}</span></div>
      <div class="seg langs">${LANGS.map(([k, label]) => `<button data-lang="${k}" class="${k === getLang() ? "on" : ""}">${label}</button>`).join("")}</div>
      <div class="dlg-sub">${t("差し色")}<span class="h-note">${t("音符・選んだ所・つまみの色。トラックの色もここから作ります")}</span></div>
      <div class="swatches">${ACCENT_PRESETS.map((c) => `<button class="sw${c === acc ? " on" : ""}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join("")}
        <label class="sw-pick" title="${t("好きな色を選ぶ")}"><input type="color" id="acc-pick" value="${acc}"><span>${t("自由に")}</span></label>
        <button class="small" id="acc-reset">${t("既定に戻す")}</button></div>
      <div class="dlg-sub">${t("mel の配色")}<span class="h-note">${t("下のパネルの mel の色")}</span></div>
      <div class="melmaps">${(Object.keys(MEL_MAPS) as MelMapKey[]).map((k) => `
        <button class="melmap${k === mm ? " on" : ""}" data-k="${k}"><span class="mm-bar" style="background:${melGradient(k)}"></span>
          <span class="mm-name">${MEL_MAPS[k].label}</span></button>`).join("")}</div>`;
    for (const b of body.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
      b.addEventListener("click", () => {
        if (b.dataset.lang !== getLang()) onLang(b.dataset.lang as Lang);
      });
    }
    for (const b of body.querySelectorAll<HTMLButtonElement>(".sw")) {
      b.addEventListener("click", () => { setAccent(b.dataset.c!); render(); });
    }
    const pick = body.querySelector<HTMLInputElement>("#acc-pick")!;
    pick.addEventListener("input", () => setAccent(pick.value));
    pick.addEventListener("change", () => render());
    body.querySelector("#acc-reset")!.addEventListener("click", () => { setAccent(DEFAULT_ACCENT); render(); });
    for (const b of body.querySelectorAll<HTMLButtonElement>(".melmap")) {
      b.addEventListener("click", () => { setMelMap(b.dataset.k as MelMapKey); render(); });
    }
  };
  render();
}
