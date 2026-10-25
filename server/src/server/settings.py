from pathlib import Path

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


def _env_file() -> Path:
    for parent in Path(__file__).resolve().parents:
        has_example = (parent / ".env.example").is_file()
        has_server = (parent / "server" / "pyproject.toml").is_file()
        if has_example and has_server:
            return parent / ".env"

    raise RuntimeError("找不到仓库根目录，无法读取 .env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=_env_file(),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    fastgpt_base_url: str = ""
    fastgpt_api_key: SecretStr = SecretStr("")
    fastgpt_app_id: str = ""
    database_host: str = Field(min_length=1)
    database_port: int = Field(ge=1, le=65535)
    database_name: str = Field(min_length=1)
    database_user: str = Field(min_length=1)
    database_password: SecretStr = Field(min_length=1)
