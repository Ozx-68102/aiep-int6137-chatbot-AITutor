"""全局异常处理器与跨模块共享的用户可见文案。"""

import logging

from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.exception_handlers import http_exception_handler
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic_core import ErrorDetails

logger = logging.getLogger("server.errors")

LOGIN_REQUIRED = "未登录"
# 会话类 401 的 reason 词表（docs/ACCOUNT_MANAGEMENT.md「会话状态通道」的最小
# HTTP 版）：令牌不认识/已过期/被吊销一律 expired（无法也无需细分）；disabled
# （账号被停用）等 account.disabled 列建好再接上（见同文档「数据库要加的」）。
# 登录端点自己的 401（密码不对）不带 reason——那不是会话过期，前端走表单错误路径。
REASON_EXPIRED = "expired"
REASON_DISABLED = "disabled"
SERVER_ERROR = "服务器错误"
NO_LANGUAGE = "账号没有语言设置"


class SessionUnauthorized(HTTPException):
    """会话类 401：响应体在 detail 之外多带一个 reason 字段。

    加字段是向后兼容的：老前端只读 detail，不受影响。reason 的词表见
    REASON_* 常量的注释；现在只会发出 expired（disabled 等停用列建好）。
    """

    def __init__(self, reason: str = REASON_EXPIRED) -> None:
        super().__init__(status.HTTP_401_UNAUTHORIZED, LOGIN_REQUIRED)
        self.reason = reason


async def validation_error_handler(
    _request: Request, exc: RequestValidationError
) -> Response:
    """422 也回一句中文。

    页面只认 {"detail": "字符串"}：Pydantic 默认的 422 正文是数组，
    前端读不出字符串，会显示成「无法连接到服务器」。
    """
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        content={"detail": _validation_message(exc)},
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> Response:
    if isinstance(exc, HTTPException):
        return await http_exception_handler(request, exc)

    # 这里只记一行。栈由 uvicorn 打一遍就够，打两遍会把日志撑爆。
    logger.error("请求失败 %s %s：%s", request.method, request.url.path, exc)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": SERVER_ERROR},
    )


async def session_unauthorized_handler(
    _request: Request, exc: SessionUnauthorized
) -> Response:
    """会话类 401 的响应体：{"detail": 中文句子, "reason": 词表词}。

    detail 保持字符串，加 reason 字段向后兼容。这个处理器比
    HTTPException 的更具体，按 MRO 优先分派到这里。
    """
    return JSONResponse(
        status_code=status.HTTP_401_UNAUTHORIZED,
        content={"detail": exc.detail, "reason": exc.reason},
        headers={"Cache-Control": "no-store"},
    )


def _validation_message(exc: RequestValidationError) -> str:
    """把校验错误拼成一句话，字段名在前，认得的类型用中文。"""
    parts: list[str] = []
    for error in exc.errors():
        field = _field_name(error["loc"])
        text = _validation_text(error)
        parts.append(f"{field}：{text}" if field else text)
    return "；".join(parts) or "请求参数不合法"


def _field_name(loc: tuple[int | str, ...]) -> str:
    """字段名：位置标记（body、path……）后面的部分。

    剩下的都是序号（比如 JSON 解析失败的 loc）时不算字段名，
    提示里不显示。
    """
    names = [str(item) for item in loc]
    if names and names[0] in {"body", "path", "query", "cookie", "header"}:
        names = names[1:]
    if names and all(name.isdigit() for name in names):
        return ""
    return ".".join(names)


def _validation_text(error: ErrorDetails) -> str:
    # 校验器自己抛的 ValueError 消息就是中文，去掉前缀直接用。
    message = error["msg"].removeprefix("Value error, ")
    kind = error.get("type")
    if kind == "missing":
        return "缺少这个字段"
    if kind == "json_invalid":
        return "请求的正文不是合法的 JSON"
    if kind in {"model_type", "model_attributes_type"}:
        return "请求的正文不是一个对象"
    if kind in {
        "uuid_parsing",
        "uuid_validation",
        "uuid_type",
        "string_type",
        "int_type",
        "bool_type",
    }:
        return "格式不对"
    limits = error.get("ctx")
    if kind == "string_too_short" and isinstance(limits, dict):
        return f"长度不能少于 {limits.get('min_length', '?')}"
    if kind == "string_too_long" and isinstance(limits, dict):
        return f"长度不能超过 {limits.get('max_length', '?')}"
    return message


def install_handlers(app: FastAPI) -> None:
    """注册三个全局异常处理器（对应原 app.py 的 @app.exception_handler 装饰器）。"""
    app.add_exception_handler(RequestValidationError, validation_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
    app.add_exception_handler(SessionUnauthorized, session_unauthorized_handler)
