"""密码的哈希、校验和策略，都收在这里。

登录、修改密码，还有以后的注册和控制台重置密码都走这一份：argon2 的用法
和密码规则散在各个端点里写，两个入口的行为迟早会走偏。

学生（chat）账号的密码最小长度是 6，向香港本地学生平台的惯例靠拢
（考评局 6–25 位、教育城至少 6 字符）；管理员（admin）账号保持 8。
学生密码的现实风险是同学间窥屏共享，而不是离线爆破（argon2 本来就贵）。
依据见 docs/PARENT_PORTAL_PRIVACY.md。
"""

import secrets
import string

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

# 控制台生成的密码是给人抄下来输入的：只用字母和数字，
# 不带符号，免得看错。
_ALPHABET = string.ascii_letters + string.digits
# 密码最小长度按账号角色分：chat（学生）6 位起，admin（管理员）8 位起。
MIN_LENGTH_CHAT = 6
MIN_LENGTH_ADMIN = 8
_MIN_LENGTH = MIN_LENGTH_ADMIN
_MAX_LENGTH = 128

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(stored_hash: str, password: str) -> bool:
    """跟库里存的哈希对不对得上。对不上（包括哈希本身坏了）一律 False。"""
    try:
        _hasher.verify(stored_hash, password)
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False

    return True


def needs_rehash(stored_hash: str) -> bool:
    """哈希是不是落后于当前参数。落后的话，趁登录成功顺手重写一遍。"""
    try:
        return _hasher.check_needs_rehash(stored_hash)
    except InvalidHashError:
        # 这个哈希读不懂：当成落后处理，下次登录成功时重写，
        # 库里就不留坏哈希了。
        return True


def generate_password(length: int = 12) -> str:
    """随机密码。控制台建号、重置密码用；这类密码豁免下面的密码策略。"""
    return "".join(secrets.choice(_ALPHABET) for _ in range(length))


def min_length_for_role(role: str) -> int:
    """按账号角色给密码最小长度：chat（学生）6 位，其他（管理员等）8 位。"""
    if role == "chat":
        return MIN_LENGTH_CHAT
    return MIN_LENGTH_ADMIN


def check_password_policy(
    password: str, username: str, *, min_length: int | None = None
) -> str | None:
    """密码策略：通过返回 None，否则返回一句中文提示。

    前端的强度检测器拿同样的规则做提示，硬门槛只在这里拦。
    消息要跟前端一字不差（分工见 docs/ACCOUNT_MANAGEMENT.md）。

    min_length 不传就用默认的 8：还没分角色的调用方（比如以后的注册）
    维持旧门槛；改密端点按角色传 min_length_for_role(account.role)。
    """
    effective_min = _MIN_LENGTH if min_length is None else min_length
    # 密码只能是连续字符：空格一律不收（维护者定的规则）。
    # 制表符、换行这些落在下面那条 ASCII 门槛里。
    if " " in password:
        return "密码不能包含空格"
    # 只收英文键盘上打得出来的字符（可打印 ASCII）。中文这类字符在密码框里
    # 打不出来也显示不了，多半是粘贴或输入法误触带进来的；前端输入框直接过滤掉，
    # 这里再拦一道，免得有人绕过页面直接调接口，存进一个自己都登不进来的密码。
    if any(ord(char) < 32 or ord(char) > 126 for char in password):
        return "密码只能用英文键盘上的字符"
    if len(password) < effective_min or len(password) > _MAX_LENGTH:
        return f"密码长度要在 {effective_min} 到 {_MAX_LENGTH} 之间"
    if username != "" and username.lower() in password.lower():
        return "密码不能包含用户名"
    return None
