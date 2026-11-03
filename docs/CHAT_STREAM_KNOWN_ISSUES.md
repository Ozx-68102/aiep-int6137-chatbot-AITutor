# Chat stream known issues

这一层是「助手回答怎么流出来、一轮问答怎么算结束」。写于 2026-11-02。

现在的问题都记在这里。每条写清楚：什么现象、为什么、代码在哪、怎么修。这一层有几处做得很好，列在最后——修的时候不要推翻它们。

## 验证情况

**实测过的**（本机 PostgreSQL，2026-11-02）：

- 每个请求的清扫 `DELETE`：中位 0.31 毫秒，最大 15.5 毫秒。
- 每个请求的查令牌 + 续期（`SELECT` + `UPDATE`）：中位 0.53 毫秒，最大 5.1 毫秒。
- 同步查库对事件循环的影响：一个 5 毫秒的心跳在同步查库时最大间隔 6.6 毫秒（约 1.6 毫秒额外延迟）。
- 清扫那条 `DELETE` 的执行计划：`Seq Scan on login_token`，扫过 111 行。
- FastAPI 的 422 正文：`{"detail": [...]}`，是数组（`fastapi/exception_handlers.py` 里的 `request_validation_exception_handler`）。

**读代码推出来的（没跑起来看）**：第 5 条（轮询空转）、第 10 条（发送失败清掉输入）。这两条要确认得开浏览器点一遍。

## 根因：这一轮的结局没有跟着流走

流里只有两种帧：内容帧，和 `data: [DONE]`（[server/src/server/app.py:831](../server/src/server/app.py#L831)、[server/src/server/app.py:709](../server/src/server/app.py#L709)）。

**这一轮是写完了、失败了、还是被按了停止，流里一个字都没有。** 失败就是流直接断掉，没有 `[DONE]`。

于是客户端只能靠「流怎么断的」去反推，答案要去别处找。下面的问题，绝大部分是这个洞长出来的。

## 1. 同一个状态有四份，互相不通

| 在哪 | 词表 | 谁写 | 谁读 |
|---|---|---|---|
| Redis `h2botapp-chat:{id}:status` | `streaming` / `finished` / `failed` / `aborted` | [server/src/server/reply_store.py:17](../server/src/server/reply_store.py#L17) | `/partial` 接口 → 页面轮询 |
| 数据库 `message.status` | `streaming` / `completed` / `failed` / `aborted` | [server/src/server/chat_log.py:29](../server/src/server/chat_log.py#L29) | `/messages` 接口 |
| 上游 FastGPT 的记录 | 那边自己的格式 | FastGPT | `/messages` 的回填 |
| 浏览器内存 | `waiting` / `failed` / `aborted` 三个布尔 + `pendingIds` | [src/App.tsx:97](../src/App.tsx#L97) | 界面 |

四处各写各的，同一轮的事实在四个地方各有一份。

**怎么修**：给流加一个结局事件（见「收敛顺序」第 1 条）。有了它，Redis 和数据库只负责存档，浏览器那份由流和库喂，不再自己猜。

## 2. 两套状态词表，同一个文件里并排 import

Redis 用 `finished`，数据库用 `completed`，意思一样。[server/src/server/app.py](../server/src/server/app.py) 里 `from server.reply_store import FAILED` 和 `chat_log.FAILED` 并排出现——读代码的人得自己去确认它们永远不会分叉。

**怎么修**：一个模块拥有这四个词，两边都用它。

## 3. `/partial` 一人干两份活

`GET /api/sessions/{id}/partial`（[server/src/server/app.py:401](../server/src/server/app.py#L401)）现在既负责「刷新后接上正在写的那一轮」（续命），又负责「报告这一轮的结局」。

两份活的生命周期不一样：续命只要活几分钟（Redis TTL），结局是永久的（进库）。

**怎么修**：它只回答一个问题——**这一轮还在写吗**。还在写就给半截文字和轮次编号；不在写就回 404，页面去读库。结局由流说。

## 4. 客户端三处各解一遍 `partial.status`

- [src/session/poll.ts:21](../src/session/poll.ts#L21)（轮询回调）
- [src/App.tsx:1080](../src/App.tsx#L1080) `recoverReply`（6 个分支）
- [src/App.tsx:1241](../src/App.tsx#L1241) `finishStop`（5 个分支）

加上 [src/api/chat.ts:5](../src/api/chat.ts#L5) 的 5 个 outcome（`completed` / `interrupted` / `not-started` / `aborted` / `busy`），前端要处理 16 种状态组合。

**怎么修**：读到一个明确的结局就完事；只有「流真的断了」才去问 `/partial`，而那时候只需要问「还在写吗」。

## 5. 轮询遇到 401 不会停，输入框被锁死

**2026-11-02 已修**（commit 04984de）：401 和 404 一样当终止条件，停下并清 pending、解锁输入框。浏览器手点还没做。

[src/session/poll.ts:23](../src/session/poll.ts#L23) 的 catch 只认 404，其余一律 `continue`。会话过期时 `/partial` 回 401 → 轮询每 500 毫秒继续问一次，永远不停。

同时 [src/App.tsx:1211](../src/App.tsx#L1211)：轮询还在跑的话就不清 pending，`inputLocked` 一直是 true——**用户连字都打不了**，只能刷新页面。

**怎么修**：401 当成终止条件，停下来并解锁输入框。

## 6. 中间件每个请求查两次库，还堵住事件循环

`_RefreshLoginCookie` 对每个带 cookie 的非 `/api/status` 请求都调 `_cookie_is_valid`（[server/src/server/app.py:1048](../server/src/server/app.py#L1048)）→ 里面 `with db_session()` → **同步的 psycopg 调用发生在 async 中间件里**。

而 `_login_token` 每次都调 `_sweep_expired_tokens()`（[server/src/server/app.py:998](../server/src/server/app.py#L998)），后者自己再开一个连接做一次 `DELETE`（[server/src/server/app.py:1012](../server/src/server/app.py#L1012)）。

所以每个请求 = **2 个数据库连接、3 条语句（`SELECT` 查令牌、`UPDATE` 续期、`DELETE` 清扫）、2 次提交**。而且中间件和业务接口各续期一次——同一个令牌行一个请求里被更新两遍。

[docs/FINDINGS.md](FINDINGS.md) 里「异步接口里的同步数据库调用会卡住事件循环」记的就是这类问题，当时修了 4 个异步接口，**中间件这条漏了**。

实测下来代价不算大（见上面「验证情况」：中位不到 1 毫秒），但有两个会随规模变坏的地方：

- **`login_token` 上没有 `expires_at` 的索引**（只有主键和 `token_hash` 的唯一索引）。清扫那条 `DELETE` 走的是 `Seq Scan`——现在扫过 111 行，代价可以忽略；行数涨上去以后，每个请求都要把整张表扫一遍。
- **`login_token` 表只增不减**：每登录一次插一行，只有过期了才被清掉。本机已经攒了 111 行。公网上学生反复登录，这张表就一直涨，而清扫是每个请求都扫全表。

**怎么修**：

- 清扫改成定时任务（或者只在查不到令牌时才清），别每个请求都扫。
- 给 `expires_at` 加一个索引。
- cookie 的有效性判断不该每次请求都查库：续期可以在同一个事务里做，中间件那次查库可以省掉。

## 7. 一轮没有可查的时间线

日志是散的自由文本：

- [server/src/server/app.py:634](../server/src/server/app.py#L634)：把整个对话请求体写进日志
- [server/src/server/app.py:702](../server/src/server/app.py#L702)：每个 chunk 都写一行
- 「这一轮被停止」「上游停止 %s」各写各的

一轮的完整轨迹（请求到了、上游调了、首字节多久、最后字节多久、上游停没停、库写没写）分散在好几行里，多用户并发时互相穿插。

轮次编号（turn_id）本来就是天然的关联键——它已经生成、已经传给上游、已经进库了，**但日志里大部分行都没带上它**。想查某一轮只能靠时间戳和 session id 去猜。

顺带：把用户提问和答案全文写进日志，公网部署后这是隐私问题，也是磁盘问题。

**怎么修**：一轮结束时写一行结构化日志（轮次编号、会话、账号、结局、耗时、上游耗时、字节数）。另外加一个「给定 session id + turn id，把 Redis 和数据库两边读出来一起打印」的函数，排查时一条命令看全貌。

## 8. 失败之后要去上游对账

`_write_round_end`（[server/src/server/app.py:771](../server/src/server/app.py#L771)）：一轮失败时等叫停上游落地，再按轮次编号去上游把那一轮的最终答案找回来，对得上就改用上游那份、状态改成写完了。

这个对账本身没错——上游那一份确实更权威。但它之所以存在，是因为「这一轮最后是什么」没有一个明确的负责人。

**怎么修**：结局由流说；上游那份只用来做归档核对，不再用来纠正状态。

## 9. 会话过期时，正在写的那一轮没有说法

`_authorize_session` 只在请求开头查一次（[server/src/server/app.py:932](../server/src/server/app.py#L932)）。会话后来过期了，那一轮照旧写完、写进库——这是对的，用户改密码不该掐掉正在写的答案。

但页面不知道它后来怎么了：流断掉 → 去问 `/partial` → 401 → 「无法连接到服务器」（见第 11 条）。

**怎么修**：服务器要能分清「令牌不认识 / 被撤销 / 账号被停用」；客户端收到之后进「会话过期」状态，聊天页原地保留、输入框上方给提示、可以重新登录。

## 10. 发送失败时，用户输入的东西被清掉

**2026-11-02 已修**（commit 6da0b34）：被踢时把内容存进 `h2bot-unsent`，登录成功后放回输入框，主动退出清掉缓存。浏览器手点还没做。

[src/App.tsx:852](../src/App.tsx#L852) 发送前 `clearUnsent()`、`setDraft('')`；请求 401 之后 [src/App.tsx:1197](../src/App.tsx#L1197) 调 `enterLogin()`，而 `enterLogin` 第一件事是 `setSessions([])`（[src/App.tsx:446](../src/App.tsx#L446)）。

结果：用户打了一段字点发送，发现要重新登录，那段字没了——界面上的、草稿缓存里的、服务器那边（压根没收到）都没有。

**怎么修**：被踢的时候把内容存进 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)），登录成功后放回输入框；主动退出登录要清掉这个缓存。

## 11. 后端的错误信息会被前端显示成「无法连接到服务器」

**2026-11-02 已修**（commit db794f1）：`app.py` 里 `_validation_error` 接管 422，把校验错误拼成一句中文（字段名 + 认得的类型用中文模板，认不得的兜底用原始消息），实测六种坏请求都回 `{"detail": "中文句子"}`。

前端只认 `{"detail": "字符串"}`（[src/api/http.ts:96](../src/api/http.ts#L96)）。FastAPI 的 422 校验错误返回 `{"detail": [...]}`，`detail` 是数组（实测确认，`fastapi/exception_handlers.py` 里的 `request_validation_exception_handler`），前端读不出字符串，于是 `explain()` 显示成「无法连接到服务器」，`connectionFailure()` 还判定成「服务连不上」（[src/api/failure.ts:3](../src/api/failure.ts#L3)）。

**怎么修**：后端所有错误都返回 `{"detail": "中文句子"}`，别用 Pydantic 的字段校验去报业务错误。`HTTPException` 走的是 `http_exception_handler`，出来就是 `{"detail": exc.detail}`，是字符串，没问题。

## 12. 模块级可变状态，只能单进程跑

`_running`、`_stop_tasks`、`_settle_tasks`、`_pending_stops`、`_records_cache` 都在模块全局（[server/src/server/app.py:105](../server/src/server/app.py#L105)）。

多 worker 的话，对话请求和停止请求可能落在不同进程，「停止」就找不到那个任务。这是单进程假设，不是 bug——但要写下来，别以后有人顺手加 `--workers 4`。

## 这一层做对的地方（修的时候别推翻）

- **轮次编号的幂等**：同一个 turn_id 不会开第二轮（[server/src/server/app.py:643](../server/src/server/app.py#L643)）。挡住了重复点击、页面重发导致上游生成两遍。
- **停止标记按轮次编号认**（[server/src/server/reply_store.py:138](../server/src/server/reply_store.py#L138)）：先到后到都对。
- **失败以后也去叫上游收手**（[server/src/server/app.py:740](../server/src/server/app.py#L740)）：不叫停的话 token 白花，那条记录还会晚到历史里。
- **我们自己存了一份历史**（[server/src/server/chat_log.py](../server/src/server/chat_log.py)）：FastGPT 清库、上游挂掉，页面照样看得见。
- **上游记录的 5 秒缓存**（[server/src/server/app.py:114](../server/src/server/app.py#L114)）：保护上游不被刷新打垮。
- **页面断开时服务器继续写完**（[server/src/server/app.py:686](../server/src/server/app.py#L686)）：写进 Redis，刷新能接上。

## 收敛顺序

1. **给流加结局事件**：`event: done`，内容是这一轮的结局和原因。这是根因那一条，修完第 1、3、4、8 条能退休一大半。
2. **两套词表合一**：一个模块拥有那四个词。
3. **`/partial` 收窄**：只回答「还在写吗」。
4. **中间件里的查库去掉**：清扫改成定时任务。
5. **每轮一行结构化日志**：带 turn_id，能 grep。

第 1 条是动流式核心链路的改动，要单独做、单独验收，别跟别的活混在一起。

## 怎么查

现在查一轮只能靠时间戳和 session id 去猜。改完之后应该能做到：

```bash
grep "<轮次编号>" logs/server.log
```

把那几行拼起来，这一轮的完整轨迹就在眼前：请求到了、上游回了什么、什么时候停的、库写没写。
