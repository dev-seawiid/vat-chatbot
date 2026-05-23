"""Docling JSON 캐시 → 법령 구조 메타 부착 노드.

순서가 중요: boundary(장·절·조·항·호·목·별표)는 NFKC 적용 전 raw 텍스트에서
인식한다. NFKC는 ①·② 같은 enclosed numeric을 1·2로 분해해 항 번호 시그널을
지우기 때문(원본 PDF가 호환 한자 U+F900-FAFF를 일관 없이 쓰는 문제 해결과
별개로 발생하는 부작용).
"""

import json
import re
import unicodedata
from pathlib import Path

from ingest.parse.dto import Node, ParsedDocument

_FILE_RE = re.compile(r"^(?P<law>.+?)\((?:법률|대통령령|재정경제부령)\)\(제\d+호\)\((?P<date>\d{8})\)")
_CHAPTER_RE = re.compile(r"^제\s*(\d+)\s*장\s*(.+?)(?:\s*<.*?>)?$")
_SECTION_RE = re.compile(r"^제\s*(\d+)\s*절\s*(.+?)(?:\s*<.*?>)?$")
_ARTICLE_RE = re.compile(r"^제\s*(\d+)\s*조(?:의\s*(\d+))?")
_PARA_MAP = {chr(c): i + 1 for i, c in enumerate(range(0x2460, 0x2474))}  # ①–⑳
_PARA_RE = re.compile(rf"^([{''.join(_PARA_MAP)}])")
_ITEM_RE = re.compile(r"^(\d+)\.\s")
_SUB_ITEM_RE = re.compile(r"^([가-힣])\.\s")
_ANNEX_RE = re.compile(r"^\[?별표\s*(\d+(?:\s*의\s*\d+)?)\]?")
_REF_RE = re.compile(r"제\s*\d+\s*조(?:의\s*\d+)?(?:제\s*\d+\s*항)?(?:제\s*\d+\s*호)?")


def _parse_filename(stem: str) -> tuple[str, str | None]:
    if m := _FILE_RE.match(stem):
        return m.group("law").strip(), m.group("date")
    return stem, None


def parse_file(extract_path: Path) -> ParsedDocument:
    data = json.loads(extract_path.read_text(encoding="utf-8"))
    # macOS APFS는 파일명을 NFD(자모 분해)로 저장 — 정규식 매칭 전 NFC로 합성.
    stem_nfc = unicodedata.normalize("NFC", extract_path.stem)
    law, eff = _parse_filename(stem_nfc)

    chapter: str | None = None
    section: str | None = None
    article: str | None = None
    paragraph: int | None = None
    item: int | None = None
    sub_item: str | None = None
    annex: str | None = None

    nodes: list[Node] = []
    for i, t in enumerate(data.get("texts", [])):
        if t.get("content_layer") != "body":
            continue
        raw = (t.get("text") or "").strip()
        if not raw:
            continue

        if m := _ANNEX_RE.match(raw):
            annex = m.group(1).replace(" ", "")
            paragraph = item = sub_item = None
        elif m := _CHAPTER_RE.match(raw):
            chapter = f"제{m.group(1)}장 {m.group(2).strip()}"
            section = article = None
            paragraph = item = sub_item = None
            annex = None
        elif m := _SECTION_RE.match(raw):
            section = f"제{m.group(1)}절 {m.group(2).strip()}"
            paragraph = item = sub_item = None
        elif m := _ARTICLE_RE.match(raw):
            article = f"{m.group(1)}의{m.group(2)}" if m.group(2) else m.group(1)
            paragraph = item = sub_item = None
            annex = None
        elif m := _PARA_RE.match(raw):
            paragraph = _PARA_MAP[m.group(1)]
            item = sub_item = None
        elif m := _ITEM_RE.match(raw):
            item = int(m.group(1))
            sub_item = None
        elif m := _SUB_ITEM_RE.match(raw):
            sub_item = m.group(1)

        text = unicodedata.normalize("NFKC", raw)
        refs = sorted({r.replace(" ", "") for r in _REF_RE.findall(text)})
        page = t["prov"][0]["page_no"] if t.get("prov") else None

        nodes.append(Node(
            id=f"{law}#{i:04d}",
            law=law,
            effective_date=eff,
            article=article,
            paragraph=paragraph,
            item=item,
            sub_item=sub_item,
            kind="annex" if annex else "body",
            annex=annex,
            heading_path=[h for h in (chapter, section) if h],
            text=text,
            refs=refs,
            page=page,
            ordinal=i,
        ))

    return ParsedDocument(
        source=extract_path.name,
        law=law,
        effective_date=eff,
        nodes=nodes,
    )
