from pathlib import Path
from typing import Self

from pydantic import Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_FASTGPT_FIELDS = (
    ("FASTGPT_BASE_URL", "fastgpt_base_url"),
    ("FASTGPT_API_KEY", "fastgpt_api_key"),
    ("FASTGPT_APP_ID", "fastgpt_app_id"),
)


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

    debug: int = 0
    fastgpt_base_url: str = ""
    fastgpt_api_key: SecretStr = SecretStr("")
    fastgpt_app_id: str = ""
    database_host: str = Field(min_length=1)
    database_port: int = Field(ge=1, le=65535)
    database_name: str = Field(min_length=1)
    database_user: str = Field(min_length=1)
    database_password: SecretStr = Field(min_length=1)
    redis_host: str = Field(min_length=1)
    redis_port: int = Field(ge=1, le=65535)
    redis_key_ttl_seconds: int = Field(ge=1)
    redis_user: str = Field(min_length=1)
    redis_password: SecretStr = Field(min_length=1)

    @field_validator("debug", mode="before")
    @classmethod
    def _debug_flag(cls, value: object) -> int:
        if isinstance(value, str):
            value = value.strip()
        if value == 1 or value == "1":
            return 1
        return 0

    @field_validator(
        "fastgpt_base_url",
        "fastgpt_app_id",
        "fastgpt_api_key",
        "database_host",
        "database_name",
        "database_user",
        "database_password",
        "redis_host",
        "redis_user",
        "redis_password",
        mode="before",
    )
    @classmethod
    def _strip_text(cls, value: object) -> object:
        return value.strip() if isinstance(value, str) else value

    @model_validator(mode="after")
    def _fastgpt_required_outside_debug(self) -> Self:
        if self.debug == 1:
            return self

        missing = empty_fastgpt_fields(self)
        if missing:
            names = "、".join(missing)
            raise ValueError(f"FastGPT 配置为空：{names}")
        return self


def empty_fastgpt_fields(settings: Settings) -> list[str]:
    missing: list[str] = []
    for env_name, attr in _FASTGPT_FIELDS:
        value = getattr(settings, attr)
        if isinstance(value, SecretStr):
            value = value.get_secret_value()
        if value == "":
            missing.append(env_name)
    return missing
