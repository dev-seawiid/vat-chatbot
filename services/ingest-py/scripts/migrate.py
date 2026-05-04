from __future__ import annotations

import sys
from pathlib import Path

import psycopg

from ingest.config import get_settings

# Alembic 같은 ORM 마이그레이터 대신 raw SQL — 로컬 docker와 Neon 양쪽에 동일 DDL을
# 한 줄 명령(`pnpm ingest:migrate`)으로 흘려보내는 게 toy 규모에 가장 단순.
MIG_DIR = Path(__file__).resolve().parent.parent / "migrations"


def main() -> int:
    if not MIG_DIR.exists():
        print(f"ERROR: {MIG_DIR} not found", file=sys.stderr)
        return 1

    # 파일명 사전순 = 적용 순서. 0001_, 0002_ 접두사로 강제.
    files = sorted(MIG_DIR.glob("*.sql"))
    if not files:
        print("no migration files found")
        return 0

    with psycopg.connect(get_settings().database_url) as conn:
        # 추적 테이블이 없으면 모든 마이그레이션이 매번 재실행되어 멱등이 깨진다.
        # CREATE EXTENSION처럼 IF NOT EXISTS가 안 통하는 DDL이 들어올 때를 대비해 필수.
        with conn.cursor() as cur:
            cur.execute(
                """
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    version    TEXT PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
                );
                """
            )
            cur.execute("SELECT version FROM schema_migrations;")
            applied = {row[0] for row in cur.fetchall()}
        conn.commit()

        for path in files:
            version = path.stem
            if version in applied:
                print(f"  skip   {version}")
                continue
            sql = path.read_text(encoding="utf-8")
            # 파일별로 트랜잭션을 끊어 커밋 — N번째 마이그레이션이 실패해도
            # N-1까지는 적용된 상태로 남아 다음 실행 시 이어붙기 가능.
            with conn.cursor() as cur:
                cur.execute(sql)
                cur.execute(
                    "INSERT INTO schema_migrations (version) VALUES (%s);",
                    (version,),
                )
            conn.commit()
            print(f"  apply  {version}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
