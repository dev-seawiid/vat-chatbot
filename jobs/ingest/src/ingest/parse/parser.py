"""Docling JSON 캐시 → 법령 텍스트 노드(NFKC + chapter/section/refs 메타).

조·항·호 같은 구조 메타는 박지 않는다 — 텍스트에 "제N조"가 그대로 박혀있고
chunker가 boundary로 split하므로 별도 state tracking이 불필요. 본 단계는
(1) noise 제거, (2) chapter/section heading 추적, (3) 1-hop refs[] 추출,
(4) NFKC 정규화만 책임.
"""

import json
import re
import unicodedata
from pathlib import Path

from ingest.parse.dto import Node, ParsedDocument

_FILE_RE = re.compile(r"^(?P<law>.+?)\((?:법률|대통령령|재정경제부령)\)\(제\d+호\)\((?P<date>\d{8})\)")
# chapter 명이 같은 노드의 section heading을 흡수하던 사고 차단 — "제3장 영세율과 면세 제1절 영세율의 적용"
# 같이 chapter + section이 한 줄에 합쳐진 경우, 다음 "제M절"·"제M조"·"<..>" 전까지만 chapter 명으로 인식.
_CHAPTER_RE = re.compile(r"^제\s*(\d+)\s*장\s+(.+?)(?=\s+제\s*\d+\s*[절조]|\s*<|\s*$)")
# 같은 노드에 inline section이 있으면 함께 추출.
_INLINE_SECTION_RE = re.compile(r"제\s*(\d+)\s*절\s+(.+?)(?=\s+제\s*\d+\s*조|\s*<|$)")
_SECTION_RE = re.compile(r"^제\s*(\d+)\s*절\s*(.+?)(?:\s*<.*?>)?$")
# "부칙 <제XXXXX호, YYYY. M. D.>" — chapter로 처리해 본법과 시각적·메타 격리.
_BUJIK_RE = re.compile(r"^부\s*칙(?:\s*<.*?>)?")
_REF_RE = re.compile(r"제\s*\d+\s*조(?:의\s*\d+)?(?:제\s*\d+\s*항)?(?:제\s*\d+\s*호)?")

# 페이지 footer 노이즈 패턴 — docling이 body로 분류했지만 정보 없음.
_NOISE_PATTERNS = (
    re.compile(r"^법제처\s"),
    re.compile(r"^국가법령정보센터(\s|$)"),
    re.compile(r"^\d+\.>$"),
    re.compile(r"^\d+$"),
)


def _is_noise(text: str) -> bool:
    return any(p.match(text) for p in _NOISE_PATTERNS)


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

    nodes: list[Node] = []
    for i, t in enumerate(data.get("texts", [])):
        if t.get("content_layer") != "body":
            continue
        # 호(號) 번호 보존 — docling은 enumerated list_item의 marker("1."·"2.")를 text에서
        # 떼어 orig·marker에만 둔다. text를 쓰면 호 계층이 사라져(예: 제36조제1항 1·2호) 조문이
        # run-on으로 뭉개지고 LLM이 조건(임계)을 못 읽는다. orig(마커 포함 원문) 우선 — 비list·
        # 목(目) 요소는 orig==text라 영향 없음.
        raw = (t.get("orig") or t.get("text") or "").strip()
        if not raw:
            continue
        if _is_noise(raw):
            continue

        # boundary는 NFKC 적용 전 raw에서 인식 — NFKC가 enclosed numeric 등을 분해해 시그널 손실하는
        # 부작용 회피(현재 호 시그널은 chunker로 이관됐지만 chapter/section 인식도 동일 원칙).
        if m := _BUJIK_RE.match(raw):
            chapter = m.group(0).strip()
            section = None
        elif m := _CHAPTER_RE.match(raw):
            chapter = f"제{m.group(1)}장 {m.group(2).strip()}"
            section = None
            if sec_m := _INLINE_SECTION_RE.search(raw):
                section = f"제{sec_m.group(1)}절 {sec_m.group(2).strip()}"
        elif m := _SECTION_RE.match(raw):
            section = f"제{m.group(1)}절 {m.group(2).strip()}"

        text = unicodedata.normalize("NFKC", raw)
        refs = sorted({r.replace(" ", "") for r in _REF_RE.findall(text)})
        page = t["prov"][0]["page_no"] if t.get("prov") else None

        nodes.append(Node(
            id=f"{law}#{i:04d}",
            law=law,
            effective_date=eff,
            chapter=chapter,
            section=section,
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
