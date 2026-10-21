"""画面の文言の鍵（日本語）を ui/src と ui/index.html から拾い、各言語の表（ui/src/locales/*.ts）と照らし合わせる。

    python tools/devtest/i18n_keys.py            → 言語ごとに、足りない鍵・使っていない鍵の数と中身
    python tools/devtest/i18n_keys.py --list     → 鍵を全部（1 行に 1 つ、JSON の文字列で）

鍵の拾い方: t("…")・tr("…")・tx("…")（i18n.ts の t を別の名前で読み込んだもの）と、index.html の data-i18n・data-i18n-title。
変数を渡す t(name) は拾えないので、文言は必ず t("…") の形で書く。
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

UI = Path(__file__).resolve().parents[2] / "ui"
CALL = re.compile(r'\b(?:t|tr|tx)\(\s*"((?:[^"\\]|\\.)*)"')
ATTR = re.compile(r'data-i18n(?:-title)?="([^"]*)"')
ENTRY = re.compile(r'^\s*"((?:[^"\\]|\\.)*)"\s*:', re.M)


def keys() -> list[str]:
    found: dict[str, None] = {}
    for f in sorted((UI / "src").rglob("*.ts")):
        if "locales" in f.parts:
            continue
        # コメントの行（// や /** */ の中）に書いた例は拾わない
        text = "\n".join(ln for ln in f.read_text(encoding="utf-8").splitlines()
                         if not ln.lstrip().startswith(("//", "*", "/*")))
        for m in CALL.finditer(text):
            found[json.loads(f'"{m.group(1)}"')] = None
    for m in ATTR.finditer((UI / "index.html").read_text(encoding="utf-8")):
        found[m.group(1)] = None
    return list(found)


def main() -> None:
    ks = keys()
    if "--list" in sys.argv:
        for k in ks:
            print(json.dumps(k, ensure_ascii=False))
        return
    print(f"鍵: {len(ks)}")
    bad = False
    for f in sorted((UI / "src" / "locales").glob("*.ts")):
        have = {json.loads(f'"{m.group(1)}"') for m in ENTRY.finditer(f.read_text(encoding="utf-8"))}
        miss = [k for k in ks if k not in have]
        extra = sorted(have - set(ks))
        print(f"{f.stem}: 足りない {len(miss)}・使っていない {len(extra)}")
        for k in miss:
            print("  足りない:", json.dumps(k, ensure_ascii=False))
        for k in extra:
            print("  使っていない:", json.dumps(k, ensure_ascii=False))
        bad |= bool(miss)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
