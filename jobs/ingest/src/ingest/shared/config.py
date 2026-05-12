from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 각 plane은 자기 .env만 본다 — apps/web/Next.js·packages/core·jobs/ingest가
# 각자 자기 디렉토리의 .env로 컨트랙트를 표현. 본 service는 Voyage 임베딩 + DB 적재만
# 쓰고 Gemini 키는 사용하지 않으므로 응답 plane과 키가 다르다.
# parents: [0]=shared, [1]=ingest, [2]=src, [3]=jobs/ingest 루트.
_SERVICE_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_SERVICE_ROOT / ".env",
        env_file_encoding="utf-8",
        # 다른 서비스용 키도 같은 .env에 들어올 수 있으므로 알 수 없는 변수는 무시.
        extra="ignore",
    )

    # 미설정 시 ValidationError로 fail-fast — 실수로 None이 API에 전달되는 사고 방지.
    voyage_api_key: str
    # 로컬 docker-compose 기본값. .env에서 Neon URL로 덮어쓰기만 하면 동일 코드로 대상 전환.
    database_url: str = "postgresql://vat_user:vat_pw@localhost:5432/vat_db"


@lru_cache
def get_settings() -> Settings:
    """프로세스당 1회 인스턴스화. 라이브러리 import 시점이 아니라 실제 사용 시점에 로드."""
    return Settings()
