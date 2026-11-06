import asyncio
import time
from typing import Literal

from server.turn_status import COMPLETED, TurnStatus


class Relay:
    def __init__(self) -> None:
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.failed = False
        self.sent = False
        # 这一轮已经写出来的文字。写进数据库的时候要写它。
        self.text = ""
        # 这一轮最后的状态：写完了、被停了、还是失败了。
        self.status: TurnStatus = COMPLETED
        # 摘要行用的最小计时：开始时刻、首个内容帧时刻（monotonic 秒）。
        self.started_at = time.monotonic()
        self.first_content_at: float | None = None
        # 有没有给上游发过停止：用户按停止（停止端点会先叫停上游），
        # 或者失败以后由我们叫停。
        self.stop_sent = False
        # 账号 id：对话端点鉴权之后填上，摘要行拿得到就带。
        self.account_id: str | None = None
        # 这一轮转发过的进度帧数（flowNodeStatus）：摘要行末尾那个字段。
        self.progress = 0
        # 轮次编号：done 帧带着它，页面按编号认这一轮。
        self.turn_id: str = ""
        # done 帧告知页面的结局（即时判断，库才是最终事实）。结局确定
        # 才有值；sse_stream 只在有值时发 done 帧。
        self.done_status: Literal["completed", "aborted", "failed"] | None = None
        # done 帧的 reason 词汇：stop（用户按停）、upstream（上游失败）、
        # internal（我们这边出错）；正常写完为 None。
        self.done_reason: Literal["stop", "upstream", "internal"] | None = None

    def sent_bytes(self) -> int:
        """这一轮发给页面的正文字节数（UTF-8）。进度帧不算正文。

        done 帧和摘要行的 bytes_sent 用它：text 是 str，直接 len() 是
        字符数，中文回答会把字节数低报约三倍。
        """
        return len(self.text.encode("utf-8"))
