// 照らし合わせの道具が動くかの確かめ: 正解を読み、音素の表の判定が Python と合うかを見る。
import { PhoneSet } from "../src/engine-web/phoneset";
import type { VoicebankWeb } from "../src/engine-web/types";
import { close, done, loadCase, readRepo, same, shapeOf } from "./golden";

const vb = JSON.parse(readRepo("voicebanks/leapsinger_ja_3singer/web.json")) as VoicebankWeb;
const ps = new PhoneSet(vb.phoneset);
const c = loadCase("sakura");
const p0 = c.phrases[0];
same("句の音素（後処理の後）", p0.postprocess.out.phonemes, p0.result.phonemes);
same("核音素の判定（is_vowel と同じか）", p0.result.phonemes.map((p: string) => ps.isNucleus(p)),
     Array.from(p0.postprocess.out.is_vowel as Uint8Array, (x) => x === 1));
console.log("ph_durs の形", shapeOf(p0.result.ph_durs), "F0 の雑音の形", shapeOf(p0.f0_run.feeds.noise));
close("フレーム数の合計", [Array.from(p0.result.ph_durs as Int32Array).reduce((a, b) => a + b, 0)], [p0.result.plain_log2.length]);
done();
