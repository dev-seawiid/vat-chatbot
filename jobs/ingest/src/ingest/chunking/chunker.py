import hashlib

import tiktoken

from ingest.chunking.dto import ChunkDTO
from ingest.extract.dto import ExtractResult, Section

# voyage 전용 토크나이저는 비공개라 OpenAI cl100k_base를 예산용으로 차용.
# 실제 임베딩 토큰 수와 정확히 일치하진 않으나 청크 크기 일관성에는 충분.
ENCODING = tiktoken.get_encoding("cl100k_base")

# 큰 단위에서 작은 단위 순으로 시도해 의미 경계를 최대한 보존한다.
# 마지막 단계로도 안 맞으면 토큰 단위 하드 슬라이스로 fallback.
DEFAULT_SEPARATORS = ["\n\n", "\n", ". ", "? ", "! ", " "]

DEFAULT_MAX_TOKENS = 500
DEFAULT_OVERLAP = 50


def count_tokens(text: str) -> int:
    return len(ENCODING.encode(text))


def _split_with_separator(text: str, separator: str) -> list[str]:
    if not separator:
        return [text]
    parts = text.split(separator)
    # 분리자를 앞 조각 끝에 붙여 두면 재조립 시 자연스러운 경계가 보존된다.
    glued = [p + separator for p in parts[:-1]] + [parts[-1]]
    return [s for s in glued if s]


def _split_recursive(
    text: str, max_tokens: int, separators: list[str]
) -> list[str]:
    if count_tokens(text) <= max_tokens:
        return [text] if text.strip() else []

    # 텍스트 안에 존재하는 가장 굵은 분리자를 우선 시도.
    for i, sep in enumerate(separators):
        if sep and sep in text:
            parts = _split_with_separator(text, sep)
            result: list[str] = []
            for p in parts:
                if count_tokens(p) <= max_tokens:
                    if p.strip():
                        result.append(p)
                else:
                    result.extend(_split_recursive(p, max_tokens, separators[i + 1 :]))
            return result

    # 모든 분리자가 효과 없으면 토큰 경계로 강제 분할.
    tokens = ENCODING.encode(text)
    return [
        ENCODING.decode(tokens[i : i + max_tokens])
        for i in range(0, len(tokens), max_tokens)
    ]


def _take_last_tokens(text: str, n: int) -> str:
    if n <= 0 or not text:
        return ""
    tokens = ENCODING.encode(text)
    if len(tokens) <= n:
        return text
    return ENCODING.decode(tokens[-n:])


def _merge_with_overlap(
    splits: list[str], max_tokens: int, overlap: int
) -> list[str]:
    """인접한 조각을 max_tokens까지 합쳐 청크화하고, 청크 경계에 overlap 토큰을 겹친다."""
    if not splits:
        return []
    chunks: list[str] = []
    buf: list[str] = []
    buf_tokens = 0

    for piece in splits:
        piece_tokens = count_tokens(piece)
        if not buf or buf_tokens + piece_tokens <= max_tokens:
            buf.append(piece)
            buf_tokens += piece_tokens
            continue
        chunks.append("".join(buf))
        # 다음 청크 앞에 직전 청크 꼬리 일부를 붙여 문맥 끊김 완화.
        tail = _take_last_tokens("".join(buf), overlap)
        buf = [tail, piece] if tail else [piece]
        buf_tokens = count_tokens(tail) + piece_tokens

    if buf:
        chunks.append("".join(buf))
    return chunks


def chunk_text(
    text: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap: int = DEFAULT_OVERLAP,
    separators: list[str] | None = None,
) -> list[str]:
    seps = separators or DEFAULT_SEPARATORS
    return _merge_with_overlap(_split_recursive(text, max_tokens, seps), max_tokens, overlap)


def chunk_section(
    section: Section,
    doc_id: str,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[ChunkDTO]:
    pieces = chunk_text(section.content, max_tokens=max_tokens, overlap=overlap)
    out: list[ChunkDTO] = []
    for ordinal, piece in enumerate(pieces):
        # 섹션 헤딩을 청크 본문 앞에 1줄 prepend — 임베딩에 위치/주제 단서를 추가한다.
        # citation·메타에는 별도로 anchor/page가 있으니 컨텐츠 복제로 인한 손실 없음.
        body = f"# {section.heading}\n\n{piece.strip()}"
        out.append(
            ChunkDTO(
                doc_id=doc_id,
                section_ordinal=section.ordinal,
                chunk_ordinal=ordinal,
                content=body,
                content_hash=hashlib.sha256(body.encode("utf-8")).hexdigest(),
                token_count=count_tokens(body),
                heading=section.heading,
                page=section.page,
                anchor=section.anchor,
            )
        )
    return out


def chunk_extract_result(
    result: ExtractResult,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    overlap: int = DEFAULT_OVERLAP,
) -> list[ChunkDTO]:
    chunks: list[ChunkDTO] = []
    for section in result.sections:
        chunks.extend(
            chunk_section(
                section,
                doc_id=result.source_id,
                max_tokens=max_tokens,
                overlap=overlap,
            )
        )
    return chunks
