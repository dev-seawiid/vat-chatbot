-- Voyage-3 임베딩은 1024차원 고정.
-- content_hash UNIQUE — 동일 텍스트 재적재 시 ON CONFLICT DO NOTHING으로 멱등.
-- HNSW 벡터 인덱스는 대량 적재 후 별도 마이그레이션에서 생성 (먼저 만들면 INSERT 수십 배 느려짐).
CREATE TABLE IF NOT EXISTS chunks (
    id              BIGSERIAL PRIMARY KEY,
    doc_id          TEXT NOT NULL,
    section_ordinal INTEGER NOT NULL,
    chunk_ordinal   INTEGER NOT NULL,
    content         TEXT NOT NULL,
    content_hash    TEXT NOT NULL UNIQUE,
    token_count     INTEGER NOT NULL,
    heading         TEXT NOT NULL,
    page            INTEGER,
    anchor          TEXT,
    embedding       VECTOR(1024) NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks (doc_id);
