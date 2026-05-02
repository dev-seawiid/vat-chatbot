from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# .env는 monorepo 루트 한 곳에서만 관리. 서비스별로 흩어두면 키 동기화가 깨진다.
_REPO_ROOT = Path(__file__).resolve().parents[4]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_REPO_ROOT / ".env",
        env_file_encoding="utf-8",
        # 다른 서비스용 키도 같은 .env에 들어올 수 있으므로 알 수 없는 변수는 무시.
        extra="ignore",
    )

    # 미설정 시 ValidationError로 fail-fast — 실수로 None이 API에 전달되는 사고 방지.
    voyage_api_key: str


@lru_cache
def get_settings() -> Settings:
    """프로세스당 1회 인스턴스화. 라이브러리 import 시점이 아니라 실제 사용 시점에 로드."""
    return Settings()
