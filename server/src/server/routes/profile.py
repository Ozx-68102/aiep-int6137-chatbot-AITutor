import hashlib
from typing import Annotated

from fastapi import (
    APIRouter,
    Cookie,
    File,
    HTTPException,
    Response,
    UploadFile,
    status,
)

from server import avatar as avatar_image
from server.db import Account, db_session
from server.errors import NO_LANGUAGE
from server.security import COOKIE_NAME, account_from_cookie
from server.types import ProfileResponse, ProfileUpdate

router = APIRouter()

_NO_AVATAR = "没有头像"
# 默认头像在前端的静态资源里：/avatar-default.svg。后端不复制一份，
# 两份一样的图迟早会走偏。
_DEFAULT_AVATAR_URL = "/avatar-default.svg"


@router.get("/api/profile")
def read_profile(
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        return _profile_response(account_from_cookie(session, login_cookie))


@router.patch("/api/profile")
def update_profile(
    body: ProfileUpdate,
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        language = account.language_setting
        if language is None:
            raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, NO_LANGUAGE)
        language.locale = body.locale
        return _profile_response(account)


@router.post("/api/avatar")
def upload_avatar(
    file: Annotated[UploadFile, File()],
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> ProfileResponse:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        # 只读上限加一的字节：超了直接退回去，不把它整个读进内存。
        data = file.file.read(avatar_image.MAX_UPLOAD_BYTES + 1)
        try:
            account.avatar = avatar_image.normalize(data)
        except avatar_image.AvatarError as error:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(error)) from error
        return _profile_response(account)


@router.get("/api/avatar")
def read_avatar(
    login_cookie: Annotated[str | None, Cookie(alias=COOKIE_NAME)] = None,
) -> Response:
    with db_session() as session:
        account = account_from_cookie(session, login_cookie)
        data = account.avatar

    if data is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, _NO_AVATAR)

    return Response(
        content=data,
        media_type="image/png",
        headers={
            "Cache-Control": "private, max-age=86400",
            "ETag": f'"{_avatar_version(data)}"',
        },
    )


def _profile_response(account: Account) -> ProfileResponse:
    language = account.language_setting
    if language is None:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, NO_LANGUAGE)

    locale = language.locale
    if locale != "zh-CN" and locale != "zh-TW" and locale != "en":
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, NO_LANGUAGE)
    return ProfileResponse(
        id=account.id,
        username=account.username,
        locale=locale,
        avatar_url=_avatar_url(account),
    )


def _avatar_url(account: Account) -> str:
    data = account.avatar
    if data is None:
        return _DEFAULT_AVATAR_URL
    return f"/api/avatar?v={_avatar_version(data)}"


def _avatar_version(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]
