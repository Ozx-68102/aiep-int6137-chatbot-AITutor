# 轮次日志与排查

后端日志现在长什么样、一轮问答怎么查、有哪些排查工具。写于 2026-11-05，描述现状。

日志代码在 [server/src/server/log.py](../server/src/server/log.py)，排查工具在 [server/src/server/turn_dump.py](../server/src/server/turn_dump.py)。日志文件位置、轮转和环境变量的基础说明在 [TECH.md](TECH.md) 和 [server/AGENTS.md](../server/AGENTS.md)，这里不重复。

## 日志格式与轮次上下文

文件日志（`logs/server.log`）每行的格式：

```
%(asctime)s %(levelname)s %(name)s [turn %(turn_id)s] %(message)s
```

- **轮次编号是日志行的一部分**：对话和停止两个端点在入口处调 `set_turn_context(turn_id)`，编号存进 contextvars；`logging.Filter`（`_TurnFilter`）把它注进每条日志。asyncio 建后台任务时会拷贝上下文，所以中继、写库收尾这些后台任务的日志行自动带上编号；请求上下文之外的行（启动、清扫、第三方库）输出 `-`。
- 停止那一侧的日志行也带同一个编号，跟对话那一侧对得上。
- 终端输出用 uvicorn 自己的排版和颜色，不套这个格式。

## 每轮一行：turn_summary

一轮落定时打一行结构化摘要（`_log_turn_summary`；「开轮前被停」的路径也打），键值对形式，方便 grep。只在一轮落定时打一次，重试和对账路径不会重复打。

```
turn_summary turn_id=… chat_id=… account_id=… outcome=… duration_ms=… first_byte_ms=… bytes_sent=… stop_sent=… db_written=… progress_events=… done_status=…
```

| 字段 | 意思 |
|---|---|
| `turn_id` / `chat_id` / `account_id` | 轮次编号、会话、账号（拿不到账号时 `-`） |
| `outcome` | 库里的最终事实：completed / failed / aborted（词表归 [turn_status.py](../server/src/server/turn_status.py)） |
| `duration_ms` | 这一轮从请求进来到落定的毫秒数 |
| `first_byte_ms` | 从开始到首个内容帧的毫秒数；一个内容帧都没有就是 `-` |
| `bytes_sent` | 发给页面的正文字节数（进度帧不算） |
| `stop_sent` | 有没有给上游发过停止（yes/no） |
| `db_written` | 落定的写库成没成（yes/no） |
| `progress_events` | 这一轮转发给页面的进度帧数 |
| `done_status` | 流里 done 帧告知页面的结局（即时判断） |

`done_status` 和 `outcome` 可能不同：失败之后服务器还会与上游做归档核对，核对上了就把库改成 completed，而 done 帧已经说过的 failed 不回改（分工见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「done 帧是即时判断，数据库是最终事实」）。两个字段并排放在摘要行里，就是为了让这种不一致一眼可见。

## debug 开关与全文日志

平时（INFO 级别）日志只有元数据：`对话请求 chat_id=… turn_id=… retry_of=… message_len=…`、`FastGPT 请求 chat_id=… turn_id=… message_len=…`、上游响应状态码、每轮的 turn_summary 这类。

全文一类的日志全部降到 debug 级别，`.env` 里 `DEBUG=1` 打开（`settings.debug == 1` 时把 server 的日志级别放到 DEBUG，见 [server/src/server/settings.py](../server/src/server/settings.py)）才写出来：

- 对话请求体全文（`logger.debug("对话请求全文 …")`）；
- 发给 FastGPT 的请求体全文；
- 上游回来的每一行原文（敏感事件除外，见下节）；
- 发给页面的每一帧（含进度帧）。

排查流式问题时开 debug 复现一轮，平时别开——全文日志量大，而且写着用户内容。

## 隐私红线

任何级别（包括 debug）都不进日志的：

- 上游的 `flowNodeResponse`（节点输出明细，含对话历史预览）和 `updateVariables`（工作流变量全量，带学生数据）两类事件**不整行落日志**，只记事件名和字节数（[server/src/server/fastgpt.py](../server/src/server/fastgpt.py) 的 `_SENSITIVE_EVENTS` 分支）。

INFO 级别（正常运行时）不含学生提问和回答的全文，只有长度和编号；全文只在 debug 开关打开时才写。配套的既有规矩不变：`logs/server.log` 的内容不要贴进提交说明、文档或 issue（[AGENTS.md](../AGENTS.md)、[server/AGENTS.md](../server/AGENTS.md)）；turn_dump 的输出带提问和回答的预览，同样别贴进公开渠道。

## 排查工具：turn_dump

一轮卡在「还在写」、页面上出现说不清的失败、或者怀疑 Redis 和数据库两边存的不是一个样子时，先跑它（在 `server/` 目录里执行）：

```bash
uv run python -m server.turn_dump <session_id> [turn_id]
```

- `session_id` 就是会话 id（对话请求里的 chat_id）；`turn_id` 可选，给了就把 `message` 表里属于那一轮的行用 `>>` 标出来，表里没有这一轮的行时会明说（写库失败过，或被重试删掉了）。
- 输出是并排的两份：Redis 的半截回复（status、轮次编号、提问长度、回答长度和首尾各 40 字的预览）+ 数据库 `message` 表的逐行清单（seq、role、turn_id、status、字数）。
- **只读工具**：不写任何数据，不改任何状态。本机 PostgreSQL 和 Redis 都要在运行。

## 查一轮：grep 轮次编号

轮次编号是贯穿三个地方的关联键（页面消息、Redis、上游记录的 dataId，见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「轮次编号」），日志里每条相关行都带着它：

```bash
grep "<轮次编号>" logs/server.log
```

出来的就是这一轮的完整时间线：请求到了（对话请求行）、上游回了什么（响应状态、debug 开着时还有原文）、转发给页面什么、被没被停止、最后落定成什么（turn_summary 行）。多用户并发时各轮的行互相穿插，靠 `[turn …]` 前缀也能把自己这一轮摘出来。

## 日志轮转现状

`logs/server.log` 超过 5MB 轮转归档（`log.py` 的 `_SizeLogFile`，归档文件按时间戳命名 `server-<时间戳>.log`）。归档只增不减、没有保留策略——这一条是未实现的 backlog，见 [improvement-research/backend-infra.md](improvement-research/backend-infra.md) 第 22 条。AGENTS.md 和 TECH.md 里关于日志文件位置、「不要贴进公开渠道」的规矩不变，这里不搬家。
