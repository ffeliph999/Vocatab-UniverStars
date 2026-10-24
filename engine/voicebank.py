"""ボイスバンクとボコーダの設定を読む。

    voicebanks/<名前>/voicebank.yaml   歌い手・言語・モデルのファイル・格子・既定のボコーダ
    vocoders/<名前>/vocoder.yaml       ボコーダの種類と ONNX のファイル

yaml の中のパスは、その yaml があるフォルダから見た相対パス（絶対パスも可）。
PrettyPitch の場所（code.prettypitch）は環境変数 PRETTYPITCH_ROOT があればそちらを使う。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

import yaml


@dataclass
class Singer:
    id: int
    name: str                                   # 内部の名前（プロジェクトに書かれる。例: ritsu）
    display: dict[str, str] = field(default_factory=dict)  # 画面に出すフルネーム（言語 → 名前。例: {ja: 波音リツ, en: Namine Ritsu}）


@dataclass
class Voicebank:
    key: str                 # フォルダの名前
    dir: Path
    name: str
    language: str
    pipeline: str
    code: dict[str, Path]
    models: dict[str, Path]
    singers: list[Singer]
    default_vocoder: str
    credits: str = ""
    publish: bool = True         # ブラウザ版の一覧（web_index.json）に載せるか。Python のエンジンは関係なく読む
    breaths: Path | None = None  # ブレスの mel の一覧（breaths.json）。無ければブレスは入れない
    raw: dict = field(default_factory=dict)

    def to_json(self) -> dict:
        return {"key": self.key, "name": self.name, "language": self.language,
                "singers": [{"id": s.id, "name": s.name, "display": s.display} for s in self.singers],
                "default_vocoder": self.default_vocoder, "credits": self.credits}


@dataclass
class VocoderSpec:
    key: str
    dir: Path
    name: str
    kind: str
    onnx: Path
    voice_params: bool
    hop: int = 256
    gain_db: float = 0.0     # 出力に掛ける補正（ボコーダの間で音量をそろえる）
    publish: bool = True     # ブラウザ版の一覧（web_index.json）に載せるか。Python のエンジンは関係なく読む

    def to_json(self) -> dict:
        return {"key": self.key, "name": self.name, "kind": self.kind, "voice_params": self.voice_params,
                "hop": self.hop}


def _resolve(base: Path, p: str | None) -> Path | None:
    if p is None:
        return None
    q = Path(p)
    return (q if q.is_absolute() else base / q).resolve()


def load_voicebank(d: Path) -> Voicebank:
    y = yaml.safe_load((d / "voicebank.yaml").read_text(encoding="utf-8"))
    code = {k: _resolve(d, v) for k, v in (y.get("code") or {}).items()}
    env = os.environ.get("PRETTYPITCH_ROOT")
    if env:
        code["prettypitch"] = Path(env).expanduser().resolve()
    return Voicebank(
        key=d.name, dir=d, name=y.get("name", d.name), language=y.get("language", "ja"),
        pipeline=y.get("pipeline", "prettypitch_leapsinger"), code=code,
        models={k: _resolve(d, v) for k, v in (y.get("models") or {}).items()},
        singers=[Singer(int(s["id"]), str(s["name"]), {str(k): str(v) for k, v in (s.get("display") or {}).items()})
                 for s in y.get("singers") or []],
        default_vocoder=y.get("default_vocoder", ""), credits=y.get("credits", ""),
        publish=bool(y.get("publish", True)), breaths=_resolve(d, y.get("breaths")), raw=y)


def load_vocoder(d: Path) -> VocoderSpec:
    y = yaml.safe_load((d / "vocoder.yaml").read_text(encoding="utf-8"))
    return VocoderSpec(key=d.name, dir=d, name=y.get("name", d.name), kind=y.get("kind", ""),
                       onnx=_resolve(d, y.get("onnx")), voice_params=bool(y.get("voice_params", False)),
                       hop=int((y.get("grid") or {}).get("hop", 256)), gain_db=float(y.get("gain_db", 0.0)),
                       publish=bool(y.get("publish", True)))


def scan(root: Path) -> tuple[dict[str, Voicebank], dict[str, VocoderSpec]]:
    """root/voicebanks と root/vocoders の下を全部読む。"""
    vbs = {d.name: load_voicebank(d) for d in sorted((root / "voicebanks").glob("*"))
           if (d / "voicebank.yaml").exists()}
    vocs = {d.name: load_vocoder(d) for d in sorted((root / "vocoders").glob("*"))
            if (d / "vocoder.yaml").exists()}
    return vbs, vocs
