# 后端接口层改进调研

> 调研范围：FastAPI 路由、FastGPT 代理、流式转发、回复存储（Redis）、限流，以及接口层对数据库的使用方式。数据库运维/部署面、日志基建、前端不在本篇（分别见 backend-infra.md 等）。
> 代码基线：main 分支快照 `1eadc4e8c042`。文中行号均指该快照下的文件行号。
> 本篇是只读调研：所有方案都是建议，动不动、怎么动由维护者决定。按 server/AGENTS.md 的边界规矩，凡涉及流式核心链路、接口契约、依赖变化的条目都单独标注了风险。

## 概览

### 读了哪些文件

- `server/AGENTS.md`（后端特有规矩、FastGPT v4.14.5 版本基线、Redis ACL 前缀约束）
- `server/src/server/`：`app.py`（1375 行，全部路由和流式转发）、`fastgpt.py`（上游客户端）、`chat_log.py`（自有 message 表读写）、`reply_store.py`（Redis 半截回复）、`ratelimit.py`（失败计数限流）、`url.py`、`settings.py`、`log.py`、`avatar.py`、`passwords.py`、`__init__.py`（uvicorn 入口）
- `server/src/server/types/`：`api.py`（接口模型）、`env.py`（配置模型）、`__init__.py`
- `server/src/server/db/`：`models.py`（表结构与索引）、`session.py`（引擎与会话）、`init.py`（幂等建表/补列）、`backfill.py`（历史搬迁命令）
- 文档：`docs/FASTGPT_API.md`、`docs/INTERRUPTED_REPLY.md`、`docs/ACCOUNT_MANAGEMENT.md`、`docs/CHAT_STREAM_KNOWN_ISSUES.md`、`docs/EDIT_MESSAGE.md`、`docs/TECH.md`、`docs/FINDINGS.md`（相关条目）、`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md`（SSE 反代部分）

### 架构简述

后端是 Backend for Frontend：浏览器只访问它（生产经 nginx 把 `/api/` 反代到 `127.0.0.1:3001`，开发直连），它再用 httpx2 异步客户端代理内部部署的 FastGPT v4.14.5（`POST /v2/chat/completions` 流式对话、`POST /v2/chat/stop` 停止、`getPaginationRecords` 取历史、`item/delete` 与 `delHistory` 删记录）。uvicorn 单进程跑（模块级可变状态决定只能单进程，`app.py:131-141`、CHAT_STREAM_KNOWN_ISSUES 第 12 条）。

一轮对话的完整路径：`POST /api/chat`（`app.py:854-909`）先做轮次幂等检查（同一 `turn_id` 不重开）、单轮占用检查（`round_in_flight`，409）、停止标记检查（`stop_requested`），然后在 Redis 登记这一轮（`begin_reply`），起后台任务 `_relay` 拉上游流，**立刻**返回 SSE 响应头。`_relay`（`app.py:912-970`）把上游每个内容块写进 Redis（`append_chunk`）并推进 SSE 队列；上游 `[DONE]` 到达则 `mark_finished`。落定后 `_settle_round`/`_write_round_end`（`app.py:978-1015`）把最终文字和状态写进自有 `message` 表，失败轮还会叫停上游并按 `turn_id` 与上游对账一次。

状态存三处：**PostgreSQL**（`account`/`session`/`message`/`login_token`/`language_setting`，页面显示的历史以 `message` 表为准）；**Redis**（`h2botapp-chat:{会话id}:status|text|turn|stop` 四个键，管「正在写的这一轮」的续命、停止标记，外加 `h2botapp-chat:ratelimit:*` 失败计数，全部带 TTL）；**FastGPT**（模型上下文的唯一来源，最近 6 轮由上游节点的 `history` 决定，我们改不了——`docs/FASTGPT_API.md`「历史与上下文」的结论）。

登录态：`login` cookie 存随机令牌，库里 `login_token` 存 SHA-256 哈希，7 天滑动续期；每个带 cookie 的请求由 ASGI 中间件 `_RefreshLoginCookie`（`app.py:158-190`）重发 cookie，端点内 `_account_from_cookie` 校验并把 role 判断收在一层。聊天侧只认 `chat` role，`/api/admin/*` 只认 `admin_login` cookie 里的 `admin` role。

已知的核心待修问题在 `docs/CHAT_STREAM_KNOWN_ISSUES.md` 里已成文（根因：「这一轮的结局没有跟着流走」）。本篇不推翻它，而是把其中后端部分落到文件/函数级方案，并补充该文档没覆盖的发现（下文标注「新增」的条目）。

---

## 一、新功能机会

### N1. 流加结局事件 `event: done`，`/partial` 收窄成「还在写吗」

- **位置**：`app.py:912-970`（`_relay`）、`app.py:1043-1049`（`_sse`）、`app.py:627-643`（`read_session_partial`）、`types/api.py`。
- **现状**：流里只有内容帧和 `data: [DONE]` 两种（INTERRUPTED_REPLY「对页面的约定只有三条」）。这一轮是写完、失败还是被停，流里一个字都没有，客户端只能靠「流怎么断的」反推，再去 `/partial` 问结局。CHAT_STREAM_KNOWN_ISSUES 把它列为根因，衍生出同文档第 1、3、4、8 条问题（同一状态四份、`/partial` 一人干两份活、前端 16 种状态组合、失败后要去上游对账）。
- **影响**：前端状态机复杂且脆（三处各解一遍 `partial.status`）；后端为兜底写了 `_write_round_end` 的上游对账逻辑。
- **方案**：`_relay` 收尾时（`finally` 里 `put_nowait(None)` 之前）多推一帧带结局的事件；`/partial` 之后只回答「还在写吗」，结局以流和库为准。注意结局词表先统一（见 O11）。
  ```python
  # types/api.py 新增
  class TurnDoneEvent(BaseModel):
      turn_id: str
      status: Literal["completed", "aborted", "failed"]
      bytes_sent: int

  # app.py _relay 的 finally，在 relay.queue.put_nowait(None) 之前：
  done = TurnDoneEvent(turn_id=turn_id, status=_final_status(relay), bytes_sent=len(relay.text))
  relay.queue.put_nowait(f"event: done\ndata: {done.model_dump_json()}\n\n")
  ```
  有一个时序细节要拍板：`_write_round_end` 的「failed 后与上游对账改成 completed」发生在流结束之后，`done` 事件可能先说 failed、库里后改成 completed。两个选法：(a) 接受，页面下次读 `/messages` 时以库为准；(b) 把对账挪到发 `done` 帧之前（代价是失败时页面多等最多 7 秒的 `_wait_for_stop`）。建议 (a)，并在文档里写明「done 帧是即时判断，库是最终事实」。
- **第三方库**：无。
- **风险**：改流式核心链路和前后端契约（INTERRUPTED_REPLY 写明「流里不增加任何新格式」是当时的决定，现在推翻它要维护者拍板）；必须与前端改造同批上线，老前端会忽略未知 event（`EventSource`/手写解析都要确认不炸）。CHAT_STREAM 文档也叮嘱：这条要单独做、单独验收。
- **工作量**：M。

### N2. 消息分页接口（新增）

- **位置**：`app.py:645-663`（`read_session_messages`）、`chat_log.py:122-145`（`read_messages`）。
- **现状**：`GET /api/sessions/{id}/messages` 一次返回整场会话全部消息，`read_messages` 全量 `SELECT ... ORDER BY seq`，无 limit。
- **影响**：长会话（学生一学期用下来几百轮很正常）响应体线性膨胀，每次刷新/切会话都全量传输、全量 Pydantic 序列化；`HistoryResponse.total` 只是 len，没有游标。
- **方案**：keyset 分页，正好落在现有索引 `message_session_id_seq_idx`（`db/models.py:114`）上，不用新索引：
  ```python
  # chat_log.py
  def read_messages(session_id: UUID, *, before_seq: int | None = None,
                    limit: int | None = None) -> list[StoredMessage]:
      stmt = select(ChatMessage).where(ChatMessage.session_id == session_id)
      if before_seq is not None:
          stmt = stmt.where(ChatMessage.seq < before_seq)
      stmt = stmt.order_by(ChatMessage.seq.desc() if before_seq is not None
                           else ChatMessage.seq)
      if limit is not None:
          stmt = stmt.limit(limit)
      rows = ...  # 取完再 reverse 回正序
  ```
  接口形态建议 `GET /api/sessions/{id}/messages?before_seq=&limit=`，响应加 `next_before_seq`（null 表示到头）。不带参数时维持现行为（全量），前端可以渐进迁移到「打开会话取最近 N 条、上滑再取」。`_merge_current_turn` 的拼接逻辑不受影响（当前轮永远是最新的，在第一页）。
- **第三方库**：无。
- **风险**：低；默认行为不变，向后兼容。
- **工作量**：S。

### N3. 消息搜索接口（新增）

- **位置**：新端点；数据在 `message` 表（`db/models.py:104-137`）。
- **现状**：没有任何搜索能力。学生找「上次讲二次函数的那段」只能一场一场翻。我们自己的 `message` 表已经是页面历史的唯一事实来源（chat_log.py 模块注释写明分工），搜索的数据基础是现成的。
- **影响**：产品能力缺口；会话多了以后「翻历史」不可用。
- **方案**：先做最朴素的子串搜索，权限沿用「会话属于该账号」：
  ```python
  @app.get("/api/messages/search")
  def search_messages(q: str, limit: int = 20,
                      login_cookie: ... = None) -> SearchResponse:
      with db_session() as session:
          account = _account_from_cookie(session, login_cookie)
          stmt = (
              select(ChatMessage, ChatSession.title)
              .join(ChatSession, ChatMessage.session_id == ChatSession.id)
              .where(ChatSession.account_id == account.id,
                     ChatMessage.text.ilike(f"%{q}%"))
              .order_by(ChatMessage.created_at.desc())
              .limit(min(limit, 50))
          )
  ```
  注意 `ilike` 的 `%`/`_`/`\` 要先转义（用户输入直接拼进 pattern 会写出病态查询）。性能：`ILIKE '%…%'` 走不了普通索引，量大了要 PostgreSQL 的 `pg_trgm` 扩展 + GIN 索引——这是数据库侧的事，归 backend-infra/维护者决定，这里只点名。`q` 加 `min_length=1, max_length=64` 校验。
- **第三方库**：无（`pg_trgm` 是 PostgreSQL 扩展，不是 Python 包）。
- **风险**：无索引时全表扫；先上小 limit + 登录账号过滤（行数 = 该账号的消息数）可控。搜索词和命中的都是用户内容，日志别记 `q`（呼应 O7）。
- **工作量**：M（含前端另算）。

### N4. 会话元数据：自动标题、最后活动时间、消息数（新增）

- **位置**：`app.py:518-541`（`list_sessions`/`create_session`）、`app.py:1360-1372`（`_session_item`）、`chat_log.py:57-89`（`begin_round`）、`db/models.py:67-88`（`ChatSession`）。
- **现状**：`session` 表只有 `title`（手动改名才有）、`pinned`、`created_at`；`SessionItem` 没有「最后一轮什么时候」「多少条消息」。标题不会自动生成：新会话在列表里是空标题，靠前端拿首条消息凑。
- **影响**：会话列表信息量低；「继续上次的话题」要靠人眼扫标题；前端已经在自己算这些的话，逻辑就散在两边。
- **方案**：两半。
  (a) 自动标题：`begin_round` 时若 `session.title` 为空，取提问前 30 字符写入（同一事务，不额外加往返）：
  ```python
  # chat_log.begin_round 的 action 里：
  chat_session = session.get(ChatSession, session_id)
  if chat_session is not None and not chat_session.title:
      chat_session.title = question.strip()[:30] or None
  ```
  (b) 列表元数据：`list_sessions` 里一条聚合查询带上 `last_message_at`、`message_count`（`func.max(ChatMessage.created_at)`、`func.count()`，按 `session_id IN (...)` 分组），`SessionItem` 加两个可空字段。不建议为此在 `session` 表上加冗余列（要维护一致性）；量大了再说。
- **第三方库**：无。
- **风险**：自动标题会和「用户手动改名」交互——只在 title 为空时写，改名后不再覆盖。前端要跟进显示。
- **工作量**：M。

### N5. 会话状态通道 `GET /api/events`（文档已设计、后端未实现）

- **位置**：新端点；设计全文在 `docs/ACCOUNT_MANAGEMENT.md`「会话状态通道」一节（协议、三个触发点、心跳、`revoke_tokens` 统一函数都已定）；吊销令牌现在散在三处：`change_password`（`app.py:450-451`）、`admin_reset_password`（`app.py:334-335`）、`logout`/`admin_logout`。
- **现状**：账号被踢/密码被重置后，客户端要等下一次请求吃 401 才知道；多标签页退出互不知晓。ACCOUNT_MANAGEMENT 已把方案定到「进程内事件总线，不用 Redis pub/sub」（单进程假设成立，CHAT_STREAM 第 12 条）。
- **影响**：「改密码或被禁用之后客户端要立刻知道」这条核心需求没有服务端支撑；前端只能靠 30 秒 `/api/status` 轮询兜底，而 status 还不带鉴权语义。
- **方案**：按文档实现。骨架：
  ```python
  # 新模块 server/events.py（进程内总线）
  _subscribers: dict[UUID, set[asyncio.Queue[dict]]] = {}

  def publish(account_id: UUID, event: dict) -> None:
      for q in list(_subscribers.get(account_id, ())):
          try: q.put_nowait(event)
          except asyncio.QueueFull: pass  # 慢消费者丢帧，重连时会补状态

  # app.py
  @app.get("/api/events")
  async def account_events(login_cookie: ... = None) -> StreamingResponse:
      account_id = await asyncio.to_thread(_account_id_from_cookie, login_cookie)
      q: asyncio.Queue[dict] = asyncio.Queue(maxsize=32)
      _subscribers.setdefault(account_id, set()).add(q)
      async def gen():
          try:
              yield f"event: state\ndata: {json.dumps({'valid': True})}\n\n"
              while True:
                  try:
                      ev = await asyncio.wait_for(q.get(), timeout=15.0)
                      yield f"event: state\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
                  except TimeoutError:
                      yield ": ping\n\n"   # 心跳，防代理掐空闲连接
          finally:
              _subscribers[account_id].discard(q)   # 文档点名要 try/finally
      return StreamingResponse(gen(), media_type="text/event-stream",
                               headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
  ```
  同时把三处吊销收进 `revoke_tokens(session, account_id, reason)`：删令牌 + `events.publish(account_id, {"valid": False, "reason": reason, ...})`。注意 `/api/events` 是长连接，会命中 `_RefreshLoginCookie` 的续期路径——它只在响应头发出时写一次 cookie，对长连接无害；但 `_STATUS_PATH` 那种「心跳不续期」的豁免名单要加上 `/api/events`（一条连一天的 SSE 不该把令牌续到天荒地老，续期语义交给短请求）。
- **第三方库**：无（浏览器 `EventSource` 够用，文档已确认）。
- **风险**：长连接数量 = 在线标签页数，单进程 asyncio 扛得住（每连接一个队列，无轮询）；断线重连由 EventSource 自带，重连先发当前状态天然补齐。属于新链路不动旧核心，风险中等偏低。
- **工作量**：M（后端）；前端配套另算。

### N6. 转发上游进度事件（`detail: true` 的 flowNodeStatus）

- **位置**：`fastgpt.py:49-97`（`events`，payload 现在 `detail: False`）、`fastgpt.py:227-249`（`_piece`/`_content` 只认 `choices[0].delta.content`，别的帧全丢）。
- **现状**：`docs/FASTGPT_API.md`「v1 与 v2 对话接口」实测确认：`detail: true` 时 v2 会多发 `flowNodeStatus`（节点名）、`flowNodeResponse`、`workflowDuration` 等结构化事件，**我们的部署已经开着运行状态**，文档原话「以后做『图片/视频生成要等几分钟』的进度显示用得上——后端挑着转给页面就行，不用 WebSocket」。上游现在整块返回（2-5 秒静默），将来媒体生成工作流静默会更长。
- **影响**：长时间无反馈时页面只有三个点；孩子等几分钟不知道系统在干嘛，也容易当成卡死去刷新/重发。
- **方案**：payload 改 `detail: True`；`_piece` 增加对 `flowNodeStatus` 帧的识别，转成自定义 SSE 事件（如 `event: progress`，data 只带节点名/耗时白名单字段，**原样转发上游 JSON 会把工作流内部结构泄给浏览器**，要挑字段）；前端不认识就忽略。这个事件流顺便就是 O8 的心跳来源（生成期间持续有帧）。`_relay` 里进度帧只进 SSE 队列，**不进** `append_chunk`/`relay.text`（那是答案正文）。
- **第三方库**：无。
- **风险**：`detail: true` 后上游帧变多，解析要多认几种形状（照 FASTGPT_API 的规矩：以 v4.14.5 源码 + 实测为准，别照文档站）；日志量会涨（O7 先做）。字段白名单要和前端约定。
- **工作量**：M。

### N7. 健康探针拆分：liveness 与带 upstream 的 readiness

- **位置**：`app.py:499-515`（`read_status`/`_database_available`）、`reply_store.py:104-108`（`store_available`）。
- **现状**：`GET /api/status` 是唯一的状态口：每次都真查一次 DB（`select(1)`）+ Redis ping，无鉴权，30 秒 × 每个在线客户端。它报 database 和 reply_store，但**不报上游 FastGPT**——上游挂了，页面常驻提示一切正常，用户发消息才失败。
- **影响**：部署侧没有零依赖的 liveness 口（进程死锁时 `/api/status` 也会挂住，分不清「进程没了」和「依赖没了」）；用户和维护者都要靠发消息撞出上游故障。
- **方案**：
  (a) `GET /api/healthz`：不碰任何依赖，直接 `{"ok": true}`（进程活着 = 200）。
  (b) `/api/status` 加 `upstream` 字段，但**不要每次现问上游**（30 秒 × N 客户端会把上游打出新的一次 ConnectTimeout 事故，FINDINGS 里刷新打垮上游的教训）：记一个进程内缓存——最近一次上游调用的结果和时间（`fastgpt.py` 各方法的成败都汇到一处），status 读缓存；缓存超过 60 秒才异步补一次探测（比如用最便宜的 `getPaginationRecords` 对一个不存在的 chatId，或直接 TCP 连通性检查）。
  ```python
  # fastgpt.py：FastGPT 内加
  self.last_ok_at: float | None = None
  self.last_error_at: float | None = None
  # 每个方法成败时更新；status 端点：
  upstream = "ok" if fresh_ok else ("unavailable" if fresh_error else "unknown")
  ```
- **第三方库**：无。
- **风险**：低。「unknown」语义要跟前端约定（没探测过 ≠ 挂了）。
- **工作量**：S。

### N8. OpenAPI 文档完善（新增）

- **位置**：`app.py:155`（`FastAPI(lifespan=_lifespan)`——无 title/version/description）、全部端点（无 tags/summary）、`app.py:909`（`/api/chat` 声明返回 `Response`，OpenAPI 里看不出是 SSE）。
- **现状**：`/docs`、`/openapi.json` 裸奔：无标题版本、无分组、无错误响应说明；`docs/TECH.md` 让人「接口清单看 app.py 源码」。前后端联调、控制台后续批次、以及任何新加入的人都要读 1375 行 app.py。
- **影响**：接口契约只活在源码和散落的 md 里；422/401/409/502 这些前端要专门处理的状态码（`src/api/http.ts` 只认 `{"detail": 字符串}`）在 OpenAPI 里不可见。
- **方案**：
  ```python
  _settings = load_settings()
  app = FastAPI(
      title="H^2 Bot BFF", version="0.1.0",
      description="浏览器只访问本服务；本服务代理内部 FastGPT。所有错误统一 {'detail': '中文句子'}。",
      docs_url="/api/docs" if _settings.debug == 1 else None,
      redoc_url=None,
      openapi_url="/api/openapi.json" if _settings.debug == 1 else None,
  )
  ```
  按域打 tags（auth / profile / sessions / chat / admin）；`/api/chat` 加 `responses={200: {"content": {"text/event-stream": {}}, "description": "SSE：内容帧、event: done（若采纳 N1）、data: [DONE]"}}`；401/409/422/502 各写明触发条件。生产关 `/docs`（debug=0 时 None）：接口面只给自家前端，公网少一个信息面。注意 `load_settings()` 在 import 期被调用的时序（`settings.py` 有缓存，问题不大，但要确认 ruff/启动路径下 .env 可读）。
- **第三方库**：无。
- **风险**：几乎无；纯元数据。
- **工作量**：S。

### N9. 编辑重发的服务端评估：现有 retryOf 路径已可复用，缺口在约定（新增）

- **位置**：`docs/EDIT_MESSAGE.md`（只写记录未实现）、`app.py:897-898`（`retry_of` 入口）、`app.py:801-851`（`_clear_failed_turn`/`_failed_turn_content_ids`）。
- **现状**：EDIT_MESSAGE 定的方向是「编辑 = 改内容后按重试的路重发」，服务端要做的两件事（删上下游旧记录、新 turn_id 开新轮）现有 `retryOf` 机制全都做了。细读 `_clear_failed_turn`：删我们表的 `delete_round` 与问题文本无关；删上游按「回答记录的 dataId == turn_id」精确匹配，也与文本无关；只有 fallback 分支（回答没写下来时按 question 文本匹配最后一条提问记录）会因内容被改而失配——失配的后果按代码注释就是「宁可历史里多一遍，不删别人那轮」，安全。
- **影响**：如果按「新接口」去做会白做一遍；真正缺的是几个待定项的服务端表态。
- **方案**：接口层不需要新端点——前端发 `POST /api/chat`，`message` = 改后的内容，`retryOf` = 被编辑轮的 turn_id 即可。服务端要补的约定：
  1. 现在 `_clear_failed_turn` 对任何状态的旧轮都会删（不限 failed）——编辑一个 completed 轮在机制上已可行，确认这是预期；
  2. EDIT_MESSAGE 说编辑重发顺带清掉「被按停止那一轮上游悬空的提问」：aborted 轮的回答记录上游可能没有，走的正是上面那个文本 fallback，编辑后文本不同会失配。若在意，可给 fallback 加一个「上游最后一条是 user 记录且其后无 assistant、且该 chat 的 Redis/表状态是 aborted」的按状态匹配分支，而不是按文本；
  3. 把「编辑重发复用 retryOf」写进 EDIT_MESSAGE.md 的待定清单，免得将来重复设计。
- **第三方库**：无。
- **风险**：低（主要是文档和一个可选 fallback 分支）。
- **工作量**：S。

### N10. 会话创建的幂等（新增）

- **位置**：`app.py:527-541`（`create_session`，id 由服务端 `uuid4` 生成）、`types/api.py:26-27`（`SessionCreate` 只有 title）。
- **现状**：`POST /api/chat` 有 turn_id 幂等（CHAT_STREAM 表扬过的那条），但 `POST /api/sessions` 没有：网络抖动/双击下客户端重发会建出两个空会话。删除接口有 `delHistory` 幂等兜底（对不存在的 chatId 也返回 200），创建没有对应机制。
- **影响**：会话列表出现重复空会话；前端只能自己防抖。
- **方案**：允许客户端带期望的会话 id（它本来就为 chat_id 生成 UUID），插入用 ON CONFLICT DO NOTHING，冲突时把已有那行读回来返回（200，不报错）：
  ```python
  class SessionCreate(BaseModel):
      id: UUID | None = None          # 客户端生成，重发时带同一个
      title: str | None = Field(default=None, min_length=1, max_length=500)

  # create_session：
  from sqlalchemy.dialects.postgresql import insert as pg_insert
  stmt = pg_insert(ChatSession).values(id=body.id or uuid4(), account_id=account.id, ...)
  stmt = stmt.on_conflict_do_nothing(index_elements=["id"])
  session.execute(stmt)
  ```
  不带 id 的老调用方行为完全不变。
- **第三方库**：无。
- **风险**：客户端可指定 id 意味着可以拿别人的 UUID 碰运气——ON CONFLICT 只在主键冲突时静默，冲突返回的是**别人**的会话就泄漏了；要在冲突分支校验 `account_id` 是不是本人，不是就 409。
- **工作量**：S。

### N11. 会话导出 Markdown（新增）

- **位置**：新端点；数据源 `message` 表。
- **现状**：`docs/FASTGPT_API.md`「杂项」已核实上游**没有**「分享某一场会话」的接口，并记了决定：要分享就把问答写成 Markdown 下载（「现在没有这个需求，先不做」）。数据基础后来变了：当时历史还依赖上游，现在 `message` 表是页面历史的唯一事实来源，导出不再碰上游。
- **影响**：家长想看孩子的对话、学生想保存一段讲解，目前只能截图。
- **方案**：
  ```python
  @app.get("/api/sessions/{session_id}/export")
  def export_session(session_id: UUID, login_cookie: ... = None) -> Response:
      with db_session() as session:
          account = _account_from_cookie(session, login_cookie)
          chat_session = _require_session(session, account, session_id)
          title = chat_session.title or "对话记录"
      rows = chat_log.read_messages(session_id)
      parts = [f"# {title}", ""]
      for row in rows:
          who = "提问" if row.role == "user" else "回答"
          parts += [f"## {who}", "", row.text, ""]
      return Response("\n".join(parts).encode("utf-8"),
                      media_type="text/markdown; charset=utf-8",
                      headers={"Content-Disposition": f'attachment; filename="{session_id}.md"'})
  ```
  文件名用会话 UUID（标题可能含非 ASCII/引号，拼 Content-Disposition 要转义，用 UUID 最省事）。failed/aborted 轮按表里状态加注（「（这一轮被停止）」）。
- **第三方库**：无。
- **风险**：导出的是用户隐私内容，端点必须走同一套会话归属校验（上面已含）；访问日志别记文件名以外的东西。
- **工作量**：S。

---

## 二、优化点

### O1. 带 cookie 的请求每轮打 4 个连接、6 条语句：清扫与续期的开销（展开 CHAT_STREAM 第 6 条）

- **位置**：`app.py:158-190`（`_RefreshLoginCookie` 中间件）、`app.py:1281-1292`（`_login_token`，每次调用先 `_sweep_expired_tokens()`）、`app.py:1299-1306`（`_sweep_expired_tokens`，自己再开一个 `db_session`）、`app.py:1335-1338`（`_cookie_is_valid`）。
- **现状**：一个带 cookie 的请求实际发生的是——中间件：`_cookie_is_valid` 开会话 A → `_login_token` 先 `_sweep_expired_tokens()` 开会话 B 做一条 `DELETE`（`login_token` 无 `expires_at` 索引，Seq Scan，CHAT_STREAM 已实测）→ 会话 A 里 `SELECT` 令牌 + `UPDATE` 续期 + commit；端点内 `_account_from_cookie` 把这三步**原样再来一遍**（会话 C、D）。合计约 4 个连接、6 条语句、4 次提交，同一个令牌行一个请求里被 `UPDATE` 两遍。而且中间件是 `async` 的，`_cookie_is_valid` 里的同步 psycopg 调用直接堵事件循环——FINDINGS 2026-10-31 修异步接口同步查库时「中间件这条漏了」（CHAT_STREAM 第 6 条原话）。另外 `login_token` 只增不减，清扫每请求扫全表，行数涨了以后每请求的代价跟着涨。
- **影响**：单请求中位代价不大（CHAT_STREAM 实测 <1ms），但它是**每个请求**的固定税，且随令牌表行数线性变坏；事件循环被同步查库堵住时，正在流式输出的轮次会卡顿（FINDINGS 实测首次连接最大 78ms）。
- **方案**（四步，可分批）：
  1. `_login_token` 里的 `_sweep_expired_tokens()` 删掉，清扫挪到 lifespan 里的定时任务（如每 10 分钟一次；单进程假设下不需要分布式锁）：
     ```python
     # app.py _lifespan 内：
     async def _token_sweeper():
         while True:
             await asyncio.sleep(600)
             await asyncio.to_thread(_sweep_expired_tokens)
     task = asyncio.create_task(_token_sweeper())
     # finally 里 task.cancel()
     ```
  2. 中间件查一次、端点复用：中间件把查到的令牌（或 account_id）放进 `scope["state"]`，端点侧的取账号函数先看 `request.state` 再查库。每请求从两轮查询减到一轮。
  3. 续期 + 校验合成一条语句：`UPDATE login_token SET expires_at = :deadline WHERE token_hash = :h AND expires_at > now() RETURNING account_id`——命中即有效且已续期，一次往返替代 SELECT+UPDATE。
  4. `login_token.expires_at` 加索引（`db/init.py` 照 `_ensure_login_token_expiry` 的写法补一条 `CREATE INDEX IF NOT EXISTS`）——这条属于 db 维护面，交接给 backend-infra/维护者。
- **第三方库**：无。
- **风险**：动的是登录链路（AGENTS 边界里的核心链路），第 2、3 步要维护者许可；第 1 步语义变化是「过期令牌最多再活 10 分钟才被物理删除」——期间拿它查询也会因 `expires_at > now()` 条件被拒，无安全影响。
- **工作量**：M。

### O2. `Account.avatar` 大字段跟着每一次认证请求跑（新增）

- **位置**：`db/models.py:42`（`avatar: Mapped[bytes | None] = mapped_column(LargeBinary)`）、`app.py:1197-1203`（`_require_role` 访问 `token.account`）、`app.py:300-313`（`admin_list_accounts` 全表 select）。
- **现状**：avatar 存的是处理后的 256×256 PNG（`avatar.py`，几十到几百 KB），直接放在 `account` 表的列上。认证路径上 `_login_token` 返回 ORM 对象后，`_require_role(token.account, ...)`、`_account_from_cookie` 都会触发 `account` 行的懒加载——SQLAlchemy 默认把**所有列**都取回来，包括 avatar 字节。也就是说每个带 cookie 的请求都白白把一张 PNG 从 PostgreSQL 搬到进程里再扔掉；`admin_list_accounts` 更是把所有账号的头像一次全拉。
- **影响**：每请求多几十~几百 KB 的数据库传输和反序列化；账号多了以后控制台列表接口会明显变重。属于纯浪费，无任何功能收益。
- **方案**：列级延迟加载，一行改动：
  ```python
  # db/models.py
  from sqlalchemy.orm import deferred
  avatar: Mapped[bytes | None] = deferred(mapped_column(LargeBinary))
  ```
  `read_avatar`/`upload_avatar`/`_avatar_url` 真正访问 `account.avatar` 时 SQLAlchemy 自动补一条 SELECT（只在这些端点多一次小往返）。若想连这一次也省，`read_avatar` 里可 `session.refresh(account, ["avatar"])` 显式加载。长期看头像拆独立表（`avatar(account_id PK, data bytea)`）更干净，但那要动 init.py/迁移，收益不大，deferred 够用。
- **第三方库**：无（`deferred` 是 SQLAlchemy 自带）。
- **风险**：很低；注意任何在会话关闭后访问 `account.avatar` 的代码会抛 DetachedInstanceError——现有代码里 `read_avatar` 是在 `with db_session()` 里先把 `data = account.avatar` 取出来再用的（`app.py:479-490`），已经是对的写法。
- **工作量**：S。

### O3. Redis 同步客户端在事件循环里：故障时放大成全服务卡顿（新增，与 CHAT_STREAM 第 12 条相邻但不同）

- **位置**：`reply_store.py:208-227`（同步 `Redis`，`socket_timeout=2.0`、`retry=Retry(NoBackoff(), 0)`）、`ratelimit.py` 同款；调用点在 async 协程里：`app.py:866-900`（`chat` 里 `current_turn_id`/`round_in_flight`/`stop_requested`/`begin_reply` 连发 4-5 次）、`app.py:912-970`（`_relay` 里每个内容块一次 `append_chunk`）、`app.py:592-625`（`abort` 里 `request_stop`/`current_turn_id`）。
- **现状**：FINDINGS 2026-10-31 实测 Redis 正常时一次写入中位 0.09ms，「留在事件循环里没问题」——这个结论在 Redis 健康时成立。但客户端配了 `socket_timeout=2.0`：Redis 一旦变慢（网络抖动、RDB fork、ACL 拒绝后连接重建），**每次调用最多堵事件循环 2 秒**，`chat` 一个请求要调 4-5 次，最坏 8-10 秒内整个进程的所有流式输出、所有请求全部冻结。降级逻辑（`_tolerate` 只记警告）保住了「Redis 挂了聊天照常」，但保不住「Redis 挂了别的功能不卡」——挂的方式如果是超时而不是拒连，卡的就是事件循环本身。
- **影响**：单点依赖的故障被放大成全站不可用；而且现象（所有流同时停住）极难排查——正是 FINDINGS 里「同步调用卡事件循环」教训的 Redis 版。
- **方案**：`redis` 包自带 `redis.asyncio`（**不是新依赖**），reply_store 换异步客户端，调用点加 await：
  ```python
  # reply_store.py
  from redis.asyncio import Redis
  async def begin_reply(chat_id, turn_id, question) -> None: ...
  async def append_chunk(chat_id, text) -> None: ...
  # app.py _relay 内：await append_chunk(chat_id, event)
  ```
  `ratelimit.py` 的调用点全在同步端点（线程池里跑），保持同步客户端不动。过渡期也可以更省事：把 `chat` 里那几处 reply_store 调用包 `asyncio.to_thread`（改动小，但 `_relay` 每块一次 to_thread 略费）。两个方案都不改任何降级语义。
- **第三方库**：无（redis 8.x 自带 asyncio 支持）。
- **风险**：动流式核心链路的调用方式（AGENTS：大改动要许可）；异步化后 `_tolerate` 上下文管理器要改成 async 版或换成 try/except；`round_in_flight` 等同步语义的函数在同步端点里也有调用（`read_session_partial` 是 sync def，在线程池里，可以留一个同步旁路或用 asyncio.run 桥——需要理一遍调用面，这是主要工作量）。
- **工作量**：M。

### O4. 单轮占用检查是 check-then-act，不原子（新增）

- **位置**：`app.py:877`（`round_in_flight` 读）→ `app.py:900`（`begin_reply` 写）；`reply_store.py:44-58`（`begin_reply` 用 pipeline 但无条件 SET）。
- **现状**：「同一场会话同时只跑一轮」靠先读 status 再写 status 实现，两步之间没有原子性。两个并发 `POST /api/chat`（不同 turn_id、同一 chat_id——比如两个标签页同时发、或前端重发时序错开）可以都通过 `round_in_flight` 检查，然后双双 `begin_reply`：后写的把先写的 turn 键覆盖，两轮的片段交错写进同一个 text 键——正是 INTERRUPTED_REPLY「同一场会话同时只跑一轮」一节描述要防的事故，现在的防线在并发下有缝。turn_id 幂等检查（`app.py:866-873`）只防「同一请求来两次」，防不了「两个不同请求」。
- **影响**：低概率但后果脏：Redis 半截文字两轮混写、上游多出一轮、message 表 seq 交错（`_next_seq` 的 max+1 也会撞）。多标签页是真实使用场景（ACCOUNT_MANAGEMENT 通篇在讨论多标签页）。
- **方案**：把「占用」做成原子认领。`begin_reply` 返回是否认领成功：status 键用 `SET NX` 抢占，抢不到再看是不是自己的 turn（幂等重发）：
  ```python
  # reply_store.py
  def begin_reply(chat_id, turn_id, question) -> bool:
      """认领这一轮。已经有一轮在写（且不是同一个 turn）时返回 False。"""
      with _tolerate("begin_reply", chat_id):
          ttl = load_settings().redis_key_ttl_seconds
          claimed = _redis().set(_status_key(chat_id), STREAMING, ex=ttl, nx=True)
          if claimed is None:
              cur = read_partial(chat_id)
              if cur.status == STREAMING and cur.turn_id != turn_id:
                  return False        # 别的轮在写
              # 同一 turn 的重发，或上一轮已落定：覆盖登记
              ...pipeline 照旧写 status/text/turn...
          else:
              ...pipeline 写 text/turn...
          return True
      return True   # Redis 不通：维持「降级放行」语义
  # app.py chat：round_in_flight 检查保留（快速路径），begin_reply 返回 False 时同样 409
  ```
  严格做要用 Lua 脚本把「读 status+turn、判重、写三键」合成一步（`Redis.register_script`，redis 包自带）；上面的两步版已经把窗口从「整个请求处理期间」缩到「毫秒级」，是否值得上 Lua 由维护者定。
- **第三方库**：无。
- **风险**：降级语义要保持——Redis 不通时返回 True 放行（现状如此）；改动落在 chat 核心链路，要许可 + 单独验收。
- **工作量**：S（两步版）/ M（Lua 版）。

### O5. httpx2 客户端：连接池未配置、各接口共用一套超时

- **位置**：`fastgpt.py:200-215`（`open_fastgpt`：`Timeout(10.0, read=fastgpt_read_timeout_seconds)`，未设 `limits`/`write`/`pool`）、`fastgpt.py:124-153`（`stop_chat`）、`fastgpt.py:99-122`（`records`）。
- **现状**：一个 `AsyncClient` 服务所有上游调用。超时只细分了 connect/read：`stop_chat` 的读超时也是 30 秒，而它上游自己最多等 5 秒（FASTGPT_API 实测），给它 30 秒意味着上游卡死时我们的 `_pending_stops` 要挂 30 秒才落地，`_wait_for_stop` 的 7 秒上限又让新一轮先走了——停止标记晚到掐掉新一轮的窗口反而变宽。`records` 是小查询，也吃 30 秒读超时。连接池用 httpx 默认（max_connections=100 / keepalive 20），对单一上游主机没有按场景收敛，keepalive_expiry 默认 5 秒，上游/中间层若更快关空闲连接，会偶发 `RemoteProtocolError`（httpx 对 keepalive 竞态不自动重试）。
- **影响**：故障时资源被无谓占住；停止路径的时序余量被超时配置吃掉；池参数没有按「单上游、并发 = 在线学生数」调过。
- **方案**：
  ```python
  # open_fastgpt：
  client = httpx2.AsyncClient(
      timeout=httpx2.Timeout(connect=10.0, read=settings.fastgpt_read_timeout_seconds,
                             write=10.0, pool=5.0),
      limits=httpx2.Limits(max_connections=64, max_keepalive_connections=16,
                           keepalive_expiry=30.0),
      headers=...,
  )
  # stop_chat / records / delete_item / delete_history：请求级覆盖
  await self._client.post(url, json=..., timeout=httpx2.Timeout(5.0, read=8.0))
  ```
  数字依据：stop 上游自等 5 秒 → 我们给 read 8 秒留余量；records/delete 是小请求，5+8 足够。流式 `events` 继续用客户端级配置（read=30 是维护者定的 `.env` 可调项，不动）。`max_connections` 设多少要看部署形态（单上游），64 是起点不是结论。
- **第三方库**：无。
- **风险**：低；超时数字改动会影响故障表现，改完要按 INTERRUPTED_REPLY 的实测方法过一遍停止/失败路径。
- **工作量**：S。

### O6. `_records_cache` 无上限，且只在写入时清理陈旧项

- **位置**：`app.py:139-141`、`app.py:686-726`（`_session_records`/`_drop_stale_records`）。
- **现状**：模块级 dict，每场被读过历史的会话存一份**全量** `ChatRecord` 列表（含整场文字）。陈旧项（>100 秒）只在有新写入时被顺带清理：一批会话被集中读过之后再也无人访问，这些条目就永远留在内存里。进程长跑 + 学期内几百个学生各几场会话，是持续增长的常驻内存。
- **影响**：慢性内存泄漏（有界于「所有会话历史总和」，但这个界不小）；缓存本来只是 5 秒的防刷新挡板，却按 100 秒+无限期持有。
- **方案**：加条目上限 + 读路径也顺手清陈旧：
  ```python
  _RECORDS_CACHE_MAX = 128
  def _cache_put(session_id, now, records):
      if len(_records_cache) >= _RECORDS_CACHE_MAX:
          oldest = min(_records_cache, key=lambda k: _records_cache[k][0])
          del _records_cache[oldest]
      _records_cache[session_id] = (now, records)
  # _session_records 命中检查后也调一次 _drop_stale_records(now)
  ```
  或者直接点名 **cachetools**（`TTLCache(maxsize=128, ttl=5)`，成熟、零依赖、就是干这个的）——按 AGENTS 的规矩，装不装由维护者定；手写 10 行也完全够。
- **第三方库**：cachetools（可选点名；手写无库也可）。
- **风险**：几乎无；缓存 miss 的代价只是多问一次上游（本来 5 秒后也会 miss）。
- **工作量**：S。

### O7. 聊天链路把用户问题和上游原文按帧写进日志（两处代码自己都标了「确认后再收窄」）

- **位置**：`app.py:860`（整个请求体 `model_dump_json` 入日志，含 message 全文）、`app.py:928/934`（每个发往页面的帧一行）、`fastgpt.py:66`（上游请求体全文）、`fastgpt.py:87`（上游每一行原文）。
- **现状**：一轮问答的正文至少被完整写进 `logs/server.log` 四遍（请求体、上游请求、上游逐行、发给页面逐帧）。AGENTS 明说该日志「写着用户提问和 FastGPT 的上游原文」；5MB 轮转意味着高频使用时归档文件快速堆积。两处注释都写着「排查流式输出用，确认后再收窄」——流式机制现在已实测稳定（INTERRUPTED_REPLY、CHAT_STREAM 的实测记录），收窄的时机到了。
- **影响**：隐私面（未成年学生的提问明文多处落盘）；磁盘与轮转压力；每帧一行 `logger.info` 在事件循环里也是纯开销；真出事时反而难查——一轮的轨迹散在几百行里互相穿插（CHAT_STREAM 第 7 条）。
- **方案**：INFO 只记元数据，全文降到 debug 开关（`settings.debug == 1` 才记）：
  ```python
  # app.py chat 入口：
  logger.info("chat chat=%s turn=%s retry_of=%s len=%d",
              body.chat_id, body.turn_id, body.retry_of, len(body.message))
  if load_settings().debug == 1:
      logger.debug("chat body %s", body.model_dump_json(by_alias=True))
  # _relay 每帧不再逐行记，只累计字节数；fastgpt.py 同理（events 里 66/87 两行降级）。
  ```
  配套 CHAT_STREAM 第 7 条的建议：一轮落定时记**一行**结构化摘要（turn_id、chat_id、account_id、结局、上游首字节耗时、总耗时、字节数、stop 是否发出、库是否写上），让 `grep "<turn_id>" logs/server.log` 一条命令看全貌。日志文件本身的轮转/保留策略归 backend-infra。
- **第三方库**：无。
- **风险**：低；唯一代价是排障时若没开 debug 拿不到原文——建议改完后跑一轮完整实测（照 INTERRUPTED_REPLY 的场景表）再合入。
- **工作量**：S。

### O8. SSE 响应缺 no-store / X-Accel-Buffering 头，且上游静默期没有心跳

- **位置**：`app.py:909`（`StreamingResponse(_sse(relay), media_type="text/event-stream")`，无 headers）、`app.py:1043-1049`（`_sse` 纯转发，静默期零字节）。
- **现状**：nginx 侧已经 `proxy_buffering off`（NGINX_SPA_DEPLOYMENT_GUIDE ④），但应用层没有 `X-Accel-Buffering: no` 双保险——谁改了 nginx 配置或前面再加一层代理（学校网关很常见），流就会被憋成整块。也没有 `Cache-Control: no-store`（SSE 响应理论上不该被任何缓存存下）。另外上游是整块返回（FASTGPT_API 实测：2-5 秒静默后整段到达），将来媒体工作流静默可达几分钟，期间客户端收不到任何字节，中间代理可能按空闲超时掐连接。
- **影响**：部署环境稍有变化流式就退化；长静默场景（N6 的进度事件没做之前）连接可能被中间层掐断，表现为「莫名 failed」。
- **方案**：
  ```python
  _SSE_HEADERS = {"Cache-Control": "no-store", "X-Accel-Buffering": "no"}
  return StreamingResponse(_sse(relay), media_type="text/event-stream", headers=_SSE_HEADERS)

  # _sse 加 15 秒心跳（SSE 注释帧，任何解析器都会忽略）：
  async def _sse(relay):
      while True:
          try:
              item = await asyncio.wait_for(relay.queue.get(), timeout=15.0)
          except TimeoutError:
              yield ": ping\n\n"
              continue
          if item is None:
              break
          yield item
  ```
  心跳只在「响应头已发出、上游还没吐字」的窗口出现，正常轮次（0.3-5.2 秒）几乎不会触发。N5 的 `/api/events` 同样套这两个头（草图里已带）。
- **第三方库**：无。
- **风险**：极低；确认前端手写 SSE 解析会跳过 `:` 开头的注释帧（EventSource 天然跳过；`src/api/chat.ts` 若是手写解析要看一眼）。
- **工作量**：S。

### O9. chat_log 每轮的 SQL 往返可以减半；`_next_seq` 有并发撞号面

- **位置**：`chat_log.py:57-89`（`begin_round`：DELETE + SELECT max(seq) + 2×INSERT）、`chat_log.py:92-102`（`finish_round`：SELECT 两行 + 逐行 ORM UPDATE）、`chat_log.py:252-257`（`_next_seq`）。
- **现状**：INTERRUPTED_REPLY 说「一轮开始一个事务、落定一个事务」，实测中位 0.30ms——量级没问题，但每个事务内部的往返数可以压：begin_round 5 条语句、finish_round 3 条。`_next_seq` 用 `SELECT max(seq)+1`，两个并发事务能算出同一个号（现在被「单轮占用 + 单进程」挡住；O4 的竞态一旦发生，seq 就会交错，`message_session_id_seq_idx` 排序的历史会乱序——seq 上没有唯一约束兜底）。
- **影响**：正常时是小优化；异常并发时 seq 撞号会导致历史排序错乱，且无声无息（没有约束报错）。
- **方案**：
  ```python
  # finish_round：一条 UPDATE 顶替 SELECT+两次 ORM 写
  session.execute(
      update(ChatMessage)
      .where(ChatMessage.session_id == session_id, ChatMessage.turn_id == turn_id)
      .values(status=status,
              text=sqlalchemy.case((ChatMessage.role == ROLE_ASSISTANT, text),
                                   else_=ChatMessage.text))
  )
  # begin_round：INSERT ... SELECT 把 max(seq) 合进插入语句（两条 INSERT 各带子查询），
  # 或保持现状但给 (session_id, seq) 加唯一约束把撞号变成显式报错——加约束归 db 维护面，交接。
  ```
  若 O4 的原子认领做了，撞号前提就消失，这里只剩往返数优化，优先级可降。
- **第三方库**：无。
- **风险**：低；`begin_round` 的 DELETE（同 turn 重写）语义要保留。
- **工作量**：S。

### O10. `/api/sessions` 返回裸数组、无分页、置顶排序在前端

- **位置**：`app.py:518-525`（`list_sessions` 直接返回 `list[SessionItem]`）、`db/models.py:87`（`account.sessions` 关系按 `created_at` 排序）。
- **现状**：全项目其他列表接口都返回对象（`AdminAccountsResponse`、`HistoryResponse`），只有会话列表是裸 JSON 数组；没有分页；`pinned`/`pinned_at` 的「置顶在前、按置顶时间排」逻辑只能前端做；排序是 `created_at` 升序（老会话在前），前端还得自己反转。登录响应（`LoginResponse.sessions`）也整个内嵌同一份列表。
- **影响**：接口形态不一致，将来加字段（N4 的元数据）对裸数组就是破坏性变更；会话多时登录响应变大。
- **方案**：包一层对象 + 服务端排序：
  ```python
  class SessionsResponse(BaseModel):
      sessions: list[SessionItem]
      total: int

  # 排序 SQL：
  .order_by(ChatSession.pinned.desc(),
            ChatSession.pinned_at.desc().nullslast(),
            ChatSession.created_at.desc())
  ```
  过渡期可以新旧并存（`GET /api/sessions` 保持数组、`?envelope=1` 或新路径返回对象），前端迁完删旧的。分页在会话数上百之前不急，形态先理顺。
- **第三方库**：无。
- **风险**：破坏性接口变更，必须与前端同批；排序语义变化（置顶提前）前端要确认没有二次排序依赖。
- **工作量**：S。

### O11. 两套状态词表合一（CHAT_STREAM 第 2 条的落地方案）

- **位置**：`reply_store.py:17-20`（`STREAMING/FINISHED/FAILED/ABORTED`，Redis 用 `finished`）vs `chat_log.py:29-32`（`STREAMING/COMPLETED/FAILED/ABORTED`，数据库用 `completed`）；`app.py:46-61` 把两边并排 import。
- **现状**：同义不同词（finished/completed），靠读代码的人自己确认它们永不分叉；`app.py` 里 `from server.reply_store import FAILED` 和 `chat_log.FAILED` 并存，`_merge_current_turn`（`app.py:744-767`）在两套词之间做映射。
- **影响**：加结局事件（N1）时词表要出现在第三个地方（SSE 契约），不合一就会有三套映射。
- **方案**：一个模块拥有这四个词，比如 `types` 或新文件 `turn_status.py`：
  ```python
  # server/turn_status.py
  STREAMING, COMPLETED, FAILED, ABORTED = "streaming", "completed", "failed", "aborted"
  # Redis 线上值维持 "finished" 不改（避免升级瞬间新旧进程词表错位），
  # reply_store 内部做一次映射：_WIRE = {COMPLETED: "finished"}
  ```
  `chat_log`、`reply_store`、N1 的 `TurnDoneEvent` 全部引用它。Redis 存量键值不用迁移（TTL 本来就短）。
- **第三方库**：无。
- **风险**：极低；纯内部重构，wire 格式不变。
- **工作量**：S。

---

## 三、未完善与潜在问题

### P1. 登录接口没有限流（ACCOUNT_MANAGEMENT 的 TODO 至今未接）

- **位置**：`app.py:272-280`（`login`）、`app.py:282-297`（`admin_login`）、`app.py:1178-1195`（`_verified_account`）；对照 `app.py:424-432`（`change_password` 已接 `is_locked`/`register_failure`）。
- **现状**：`ratelimit.py` 整套设施都在，但只有改密路径用了。`/api/login` 和 `/api/admin/login` 失败次数无上限——在线猜密码零成本。库里还有文档明文记录的初始口令账号（`admin`/`admin`、`test01`/`test01`，`db/init.py:9-16`），公网部署后这是最先被撞的门。ACCOUNT_MANAGEMENT「基础安全」第一条就是这个 TODO（「登录路径还没接」）。
- **影响**：账号可被在线爆破；argon2 验证是 CPU 活，无限制的登录请求同时是廉价的 DoS 面（每请求占一个线程池线程做哈希）。
- **方案**：照 `change_password` 的样子接进 `_verified_account`（一处改动盖住两个登录端点）。注意维度：账号维度用**归一化后**的用户名（ACCOUNT_MANAGEMENT 记录了 `admin`/`Admin`/`admin ` 在库里是三个账号的坑，限流键别跟着裂开），IP 维度照改密路径：
  ```python
  # app.py login/admin_login 入口（进 db_session 之前）：
  ident = body.username.strip().lower()
  if is_locked("login", ident) or is_locked("login:ip", client_ip):
      raise HTTPException(429, _RATE_LIMITED)
  # _verified_account 失败分支：register_failure 两个维度；成功：clear_failures("login", ident)
  ```
  键空间在 `h2botapp-chat:ratelimit:` 下，ACL 约束天然满足（ratelimit.py 注释）。锁定时长/次数沿用现有 15 分钟/5 次。
- **第三方库**：无。
- **风险**：低；Redis 挂时按现有语义放行（有警告日志）。注意 `login` 是 sync def，`request.client.host` 要把 `Request` 加进签名。
- **工作量**：S。

### P2. 请求体无长度上限：message、password 都能无限长（新增）

- **位置**：`types/api.py:129`（`message: str = Field(min_length=1)`，无上限）、`types/api.py:10`（`LoginRequest.password` 无上限）、`types/api.py:16-18`（`PasswordChange` 三个字段无任何约束）；Starlette/uvicorn 对 JSON body 大小无默认上限。
- **现状**：一条 10MB 的 `message` 会被完整解析、写进日志（O7 的现状让它写四遍）、存进 Redis turn 键和 message 表，再原样转发给上游（token 直接烧穿）。超长 `password` 会进 argon2（argon2-cffi 对长度宽松，CPU 代价随长度涨）并可能触发 422 之外的怪路径。`check_password_policy` 的 128 上限只在改密时查，登录不查。
- **影响**：资源滥用（上游 token、磁盘、日志、内存）；单个恶意/失控客户端能显著拖累单进程服务。
- **方案**：模型层收口 + 边缘层兜底：
  ```python
  # types/api.py
  message: str = Field(min_length=1, max_length=8000)   # 数字与维护者/产品对齐后定
  password: str = Field(min_length=1, max_length=128)   # 与 passwords._MAX_LENGTH 一致
  old_password: str = Field(max_length=128)             # PasswordChange 三个字段同
  ```
  422 会走 `_validation_error` 拼成中文句子，前端契约不破。nginx 侧 `client_max_body_size`（头像路径单独放宽到 6m，见 P10）挡住更大的裸 body。`max_length` 校验发生在完整解析 body 之后，所以 nginx 那道仍然必要。
- **第三方库**：无。
- **风险**：max_length 定小了会拒掉合法长提问（比如粘贴一整篇作文）——数字要维护者拍板；前端最好同步做输入上限提示（UI_WARNINGS 那类文案）。
- **工作量**：S。

### P3. `ChatRequest.locale` 是死字段（新增）

- **位置**：`types/api.py:131`（`locale: str | None = None`）；grep 全 `app.py`，`locale` 只出现在 profile 相关代码（`app.py:401/1231/1313-1319`），chat/`_relay`/`fastgpt.events` 都不读它。
- **现状**：前端每条消息都带 locale，后端收下就扔。也没有校验（任意字符串都过）。
- **影响**：接口契约里有一个字段在说谎——读代码的人会以为上游按 locale 回答；将来真要做多语言回答时，会误以为通路已经在。
- **方案**：二选一，都要维护者定：(a) 删字段（前端同步去掉，422 不会发生——Pydantic 默认忽略多余字段，可以先删后端再删前端）；(b) 真转发——FastGPT v4.14.5 的 `v2/chat/completions` 支持 `variables`（照 AGENTS 的规矩：以 v4.14.5 源码 `projects/app/src/pages/api/v2/chat/completions.ts` 为准实测确认，工作流里要有消费这个变量的节点才有意义），payload 加 `"variables": {"locale": body.locale}`。若保留字段，先收紧成 `Literal["zh-CN", "zh-TW", "en"] | None`。
- **第三方库**：无。
- **风险**：(b) 依赖上游工作流配置，不是我们单边能生效的事。
- **工作量**：S。

### P4. `delete_session` 的部分失败与并发竞态（新增）

- **位置**：`app.py:570-589`。
- **现状**：顺序是「上游 `delHistory` → 删库（message 行 + session 行）→ `discard_reply`」，三个已核实的问题：
  1. **流式中的会话可以被删**：不取消 `_running` 里的任务、不叫停上游。删除后 `_relay` 照跑：上游把答案写完（token 白花），`append_chunk`/`mark_finished` 在 `discard_reply` 之后把 Redis 键又建回来（带 TTL 的孤儿键），`finish_round` 更新不到行（已被删）静默空转。
  2. **上游成功、删库失败** → 500，会话在本地还在但上游上下文已清空；用户重试删除可以走通（`delHistory` 对不存在的 chatId 也回 200，FASTGPT_API 实测），但期间的 `/messages` 会触发 `_backfill_session` 把空历史「抄」进表——数据没丢（本来就要删），语义混乱。
  3. `FastGPTError` 被映射成 **500**（`app.py:578-584`），上游问题报了服务器错误，和 `_backfill_session` 用 502 的口径不一致（P7）。
- **影响**：删除与流式并发时产生孤儿 Redis 键、白烧 token；错误码口径混乱。
- **方案**：删除前先把这一轮收掉，复用 abort 的既有机制：
  ```python
  @app.delete("/api/sessions/{session_id}", status_code=204)
  async def delete_session(...):
      fastgpt = _fastgpt()
      await asyncio.to_thread(_authorize_session, session_id, login_cookie)
      # 1) 停掉正在写的一轮（与 abort_session_reply 同一段逻辑，可抽函数复用）
      turn_id = current_turn_id(session_id)
      request_stop(session_id, turn_id)
      tasks = _running.pop(session_id, set())
      if tasks:
          _ask_upstream_to_stop(session_id)
          for t in tasks: t.cancel()
          await asyncio.wait(tasks, timeout=2.0)
          await _wait_for_stop(session_id)
      # 2) 上游 → 3) 删库 → 4) discard_reply（顺序不变，此时没人再写 Redis）
  ```
  502/500 口径随 P7 一起理。上游成功、删库失败的窗口无法完全消除（跨系统没有事务），但至少要在日志里把两个阶段分开记，方便人工对账。
- **第三方库**：无。
- **风险**：动停止链路（AGENTS 核心链路，要许可）；`_wait_for_stop` 最长 7 秒会让删除请求变慢——可以给删除路径用更短的等待或不等（反正马上 delHistory，上游整轮记录都会被软删）。
- **工作量**：M。

### P5. `message` 表里卡死的 streaming 行没有对账路径（新增）

- **位置**：`chat_log.py:57-89`（`begin_round` 先写两行 `status=streaming`）、`app.py:729-767`（`_merge_current_turn`：表里 `waiting=True` 的行只有当 Redis partial 的 turn 对得上时才会被覆盖）、`app.py:997-1015`（`_write_round_end` 是唯一的落定写入）。
- **现状**：`begin_round` 的设计意图是「进程中途死了，表里留着这一轮的提问」（chat_log.py 注释）。但进程真死了之后：`finish_round` 永远不会来，Redis 键 TTL 过期，`_merge_current_turn` 里 `partial.turn_id is None` 直接 return——表里那行 `streaming` 原样端给页面，`waiting=True`，**三个点永远转**。没有任何启动对账、读时对账或超时对账。
- **影响**：一次部署重启/崩溃就会让受影响会话的最后一条回答永久处于「正在写」，用户只能干等或重试整个会话；这也是「刷新后接上」故事的未完成半场。
- **方案**：两层，可分别上：
  1. **读时兜底**（改动最小）：`read_session_messages` 里，`streaming` 行若既不是 Redis 当前轮（`partial.turn_id != row.turn_id` 或 partial 为空），就把展示状态降级为 `failed`（不写库，纯展示层），页面因此出现「消息生成失败 + 重试」而不是永远的等待气泡。
  2. **启动对账**：lifespan 里加一步——单进程假设下，进程启动时表里所有 `status=streaming` 的行必然是死轮，一条 UPDATE 全改 `failed`：
     ```python
     session.execute(update(ChatMessage).where(ChatMessage.status == chat_log.STREAMING)
                     .values(status=chat_log.FAILED))
     ```
     注意放在 lifespan 而非 import 期，且只在服务真正启动时跑一次。
  两层都做的话，(1) 管「进程活着但 `_settle_tasks` 写库失败」的残余情形（`chat_log._write` 吞 SQLAlchemyError，`chat_log.py:232-243`），(2) 管崩溃重启。
- **第三方库**：无。
- **风险**：(2) 在多进程部署下会误杀别的进程正在写的轮次——但多进程本来就部署不了（CHAT_STREAM 第 12 条），在代码注释里写明这个前提。
- **工作量**：S（读时）/ S（启动），合计 M 以内。

### P6. 数据库不可用时 `/messages` 返回 200 + 空历史（新增）

- **位置**：`chat_log.py:122-145`（`read_messages` 把 `SQLAlchemyError` 吞成 `[]`，注释写明「读不出来就当没有，让上游那份顶上」）、`app.py:645-663`（`read_session_messages` 拿 `[]` 当「老会话」走 `_backfill_session`）、`chat_log.py:147-181`（`backfill` 的 `_write` 同样吞错）。
- **现状**：DB 挂了时的完整链路：`read_messages` → `[]` → 被当成「没有记录的老会话」→ 问上游要全量历史（成功的话）→ `backfill` 写库静默失败 → 再 `read_messages` 又是 `[]` → **200 + 空 messages**。页面看到的是「这场会话一条消息都没有」。若上游也恰好失败，则 502——同一个故障两种表现。
- **影响**：「数据库不可用」被伪装成「会话是空的」。用户以为历史丢了；前端若有「空会话自动删除/重建」之类的逻辑会被误触发；排障时 200 响应完全不指向真实故障。
- **方案**：区分「查过了，没有行」和「查不了」。`read_messages` 加一个不吞错的入口（或返回 None 表示故障）：
  ```python
  # chat_log.py
  def read_messages_strict(session_id: UUID) -> list[StoredMessage]:
      with db_session() as session:   # SQLAlchemyError 原样上抛
          ...

  # app.py read_session_messages：
  try:
      stored = await asyncio.to_thread(chat_log.read_messages_strict, session_id)
  except SQLAlchemyError:
      raise HTTPException(503, "暂时读不到历史记录，请稍后再试") from None
  ```
  降级链保留给 backfill 内部（上游兜底那半不变）。`/api/status` 的 database 字段会让前端横幅同时亮，两处信号一致。
- **第三方库**：无。
- **风险**：低；行为从「错误的 200」变成「诚实的 503」，前端对 503 的文案要过一遍（`{"detail": …}` 契约不变）。
- **工作量**：S。

### P7. 上游错误一刀切：`FastGPTError` 不带任何信息，端点错误码口径不一（新增）

- **位置**：`fastgpt.py:17-18`（异常类零字段）、`fastgpt.py:79-84`（非 200 时读了正文、记了日志，然后 `raise FastGPTError` 把状态码丢了）、`app.py:578-584`（delete_session 把上游失败报 **500**）vs `app.py:669-673`（backfill 把上游失败报 **502**）。
- **现状**：上游 401（API key 错）、400（appId 错、「工作流版本过低」，FASTGPT_API 记录过这个拒绝）、429、5xx、超时，到了端点全变成同一句「暂时问不到上游」或「服务器错误」。配置错误（我们自己的 .env 写错）和上游故障（他们挂了）在响应和告警面上无法区分。
- **影响**：维护者排障要靠翻日志正文；配置错误会被当成上游抖动忽略掉；监控（若有）没法按错误类别告警。
- **方案**：异常带上类别，端点按类别映射：
  ```python
  # fastgpt.py
  class FastGPTError(Exception):
      def __init__(self, *, status_code: int | None = None, upstream_code: int | None = None,
                   message: str = ""):
          super().__init__(message or f"FastGPT error {status_code}/{upstream_code}")
          self.status_code, self.upstream_code = status_code, upstream_code

      @property
      def is_config_suspect(self) -> bool:
          return self.status_code in (400, 401, 403, 404)   # 我们的地址/密钥/appId 多半配错了

  # events()/records() 抛出时：raise FastGPTError(status_code=response.status_code)
  # _ok_body 里：raise FastGPTError(upstream_code=code)
  # app.py 端点统一：
  except FastGPTError as exc:
      if exc.is_config_suspect:
          logger.error("上游拒绝，疑似配置问题：%s", exc)
      raise HTTPException(502, _UPSTREAM_ERROR) from None
  ```
  给用户的话不变（不给上游细节），差别全在日志级别和状态码口径：上游问题一律 502（delete_session 的 500 改过来），配置嫌疑另记 error 行。
- **第三方库**：无。
- **风险**：低；纯内部信息保真，对外契约不变（除 delete_session 500→502，前端失败文案要确认兼容 502——它已经处理 backfill 的 502，应当没事）。
- **工作量**：S。

### P8. 按停止后立刻发新消息：响应头被 `_wait_for_stop` 压住最长 7 秒（新增）

- **位置**：`app.py:893-895`（`chat` 在返回 StreamingResponse **之前** `await _wait_for_stop(body.chat_id)`）、`app.py:1115-1124`（`_STOP_WAIT_SECONDS = 7.0`）、`fastgpt.py:124-153`（stop 调用本身，配合 O5 的超时收紧）。
- **现状**：等停止落地的机制是对的（FASTGPT_API：上游每轮开始会删停止标记，标记晚到会掐掉新一轮），但它放在响应头发出之前。用户「按停止 → 马上改口重发」是高频动作，此时新请求要干等上一轮的 `_stop_upstream` 落地（正常几百毫秒，上游卡时到 7 秒上限）才拿到响应头。INTERRUPTED_REPLY 专门修过「响应头要立刻回」（0.013 秒实测），这条路径把那个修复又局部推翻了。
- **影响**：停止后重发的体验退化：页面等待气泡不转、前端超时重发逻辑可能被触发（turn_id 幂等兜底，不会生成两遍，但请求白白多一轮）。
- **方案**：把等待挪进 `_relay` 任务（登记照旧在前，等待发生在真正调上游之前）：
  ```python
  # chat()：删掉 await _wait_for_stop(...)，begin_reply 之后直接建任务、回响应头
  # _relay()：
  await asyncio.to_thread(chat_log.begin_round, ...)
  await _wait_for_stop(chat_id)      # 挪到这里：等落地再问上游，时序约束不变
  async for event in fastgpt.events(...)
  ```
  时序核对：停止标记必须在我们调 `v2/chat/completions` 之前落地（上游在**它那轮开始时**删标记）——挪动后依然满足；页面侧提前看到 `streaming` 状态，语义无害。`retry_of` 的 `_clear_failed_turn`（也在响应头之前，`app.py:897-898`）同理可以挪进任务，但它涉及删上游记录，失败时页面拿不到 409/502 之类的即时信号——建议第一期只挪 `_wait_for_stop`。
- **第三方库**：无。
- **风险**：动停止时序（文档明确机制），改完要按 INTERRUPTED_REPLY 的停止实测场景表复测（停止先到/对话先到/停完立刻发新轮）。
- **工作量**：S～M。

### P9. cookie 没有 `Secure` 标志（新增；与 backend-infra 交界，接口层视角记录）

- **位置**：`app.py:1340-1349`（`_set_cookie`：`httponly=True, samesite="lax", path="/"`，无 `secure`）。
- **现状**：生产形态是 nginx 终结 HTTPS 反代到本机 3001（NGINX_SPA_DEPLOYMENT_GUIDE），nginx→uvicorn 一段是 http，所以代码里没写 `secure` 在开发环境是自洽的；但浏览器看到的是 https 站点，cookie 没标 Secure 意味着若用户被诱导访问同域的 http 端口/降级路径，令牌会明文发出。`login` cookie 是 7 天有效的 bearer 令牌，值得按最严格处理。
- **影响**：令牌泄露面；学生设备环境不可控（学校网络中间盒），这不是理论风险。
- **方案**：配置驱动：`Settings` 加 `cookie_secure: bool = False`（`.env` 的 `COOKIE_SECURE=1` 在生产开），`_set_cookie` 传 `secure=settings.cookie_secure`。进一步可把 cookie 名改成 `__Host-login`（浏览器强制 secure+path=/+无 domain），但那要前后端同改且开发环境 http 下直接不可用，不建议。samesite=lax 已挡住跨站 POST（CSRF 主面），维持。
- **第三方库**：无。
- **风险**：生产忘开则形同虚设、开发误开则登录坏掉——用配置项而非硬编码正是为了两边都对。部署清单项，交接 backend-infra。
- **工作量**：S。

### P10. 头像上传的实际大小限制不在我们手里（FINDINGS 已证实的坑，未收口）

- **位置**：`app.py:462-476`（`upload_avatar` 只读 `MAX_UPLOAD_BYTES + 1`）、FINDINGS 2026-11-02 条目（starlette `max_part_size` 只管普通表单字段，**不管文件部分**；上传文件整个落 `SpooledTemporaryFile`，无上限）。
- **现状**：端点内「只读上限加一的字节」防住了内存，但防不住传输和落盘：FastAPI 解析 multipart 时**整个请求体已经收完并 spool 到临时文件**，端点才开始读。一个 2GB 的「头像」会先完整走一遍网络和磁盘。
- **影响**：磁盘/带宽滥用面；单进程服务在大上传期间线程池被占用。
- **方案**：两道边缘闸：(a) nginx 给 `/api/avatar` 单独 `client_max_body_size 6m`（其余 `/api/` 可以收到 1m，顺便兜住 P2）；(b) 应用层提前拒——端点加 `request: Request` 参数，看 `Content-Length` 头超上限直接 413（对不带该头的 chunked 请求无效，所以 (a) 仍是主闸）：
  ```python
  length = request.headers.get("content-length")
  if length is not None and int(length) > avatar_image.MAX_UPLOAD_BYTES + 64 * 1024:
      raise HTTPException(413, "文件太大，请传 5 MB 以内的")
  ```
- **第三方库**：无。
- **风险**：低；413 的 `{"detail": …}` 契约与前端兼容（非 200 都读 detail）。nginx 改动归部署面，交接。
- **工作量**：S。

### P11. ratelimit 的健壮性小项（合并条目）（新增）

- **位置**：`ratelimit.py:37-45`（`is_locked`）、`ratelimit.py:24-34`（`register_failure`）、`ratelimit.py:55-74` 与 `reply_store.py:208-227`（两份几乎相同的 `_redis()` 工厂）。
- **现状**（四个小点）：
  1. `is_locked` 里 `int(count)` 裸转换：键值被写成非数字（比如未来有人复用键名、或 SET NX 与 INCR 的竞态留下怪值）时抛 `ValueError`，穿透到通用异常处理器变成 500——限流模块自己成了故障点。
  2. `register_failure` 的 SET NX + INCR 两步不原子：并发失败时计数可能少一（窗口语义无大碍，记录在案即可，要修就是一条 Lua 或 `INCR` + `EXPIRE NX`（Redis 7+ 支持 `EXPIRE key ttl NX`，一步原子且只给第一次加过期））。
  3. ratelimit 和 reply_store 各建一个连接池、各写一份配置：两份 `socket_timeout`/ACL 注释要同步维护，将来改连接参数容易漏一边。
  4. 计数窗口是「第一次失败起 15 分钟」的固定窗：攻击者可以每 15 分钟来 5 次地低速爆破（5 次/15 分钟 = 480 次/天/账号）。对初始口令账号（P1）这个速率不算安全。
- **影响**：单看都是小毛病；合起来是「限流设施能更结实」的清单。第 4 点若 P1 落地后仍担心，可把 MAX_FAILURES 收紧或改指数退避（每轮锁定时间翻倍，键值存 `count` 和 `lock_until` 两个字段）。
- **方案**：
  ```python
  # 1) 防御性解析：
  try: count = int(raw)
  except (TypeError, ValueError): count = 0
  # 2) INCR + EXPIRE NX（Redis 7+，部署是 8.10.2，满足）：
  n = client.incr(key)
  if n == 1: client.expire(key, WINDOW_SECONDS, nx=True)
  # 3) 抽公共工厂 server/redis_client.py：build_redis(settings) -> Redis，两个模块共用
  ```
- **第三方库**：无。
- **风险**：极低；第 2 点从「SET NX 语义」换成「INCR 语义」要确认部署 Redis ≥7（TECH.md：8.10.2，满足）。
- **工作量**：S。

### P12. `/api/avatar` 发了 ETag 但不处理条件请求（新增）

- **位置**：`app.py:478-497`（`read_avatar` 返回 `ETag` 和 `Cache-Control: private, max-age=86400`，但不看 `If-None-Match`）。
- **现状**：ETag 只用来给 `_avatar_url` 拼版本参数（`app.py:1324-1333`，换图换 URL 破缓存），响应头的 ETag 本身没有兑现——浏览器过期后带 `If-None-Match` 再验证时，服务器仍回 200 + 整张 PNG。Starlette 不会自动做 304。
- **影响**：小带宽浪费；「发了 ETag 却不 honoring」是接口层的言而无信，将来上 CDN/代理时行为更迷惑。
- **方案**：
  ```python
  etag = f'"{_avatar_version(data)}"'
  if request.headers.get("if-none-match") == etag:
      return Response(status_code=304, headers={"ETag": etag, "Cache-Control": "private, max-age=86400"})
  ```
  （端点签名加 `request: Request`。）
- **第三方库**：无。
- **风险**：几乎无。
- **工作量**：S。

### P13. `logout` 对无效令牌返回 401，不幂等（新增）

- **位置**：`app.py:363-381`（`logout`）、`app.py:342-361`（`admin_logout`）。
- **现状**：令牌已过期/已吊销时点退出会得到 401 +「未登录」+ 清 cookie。前端把 401 当「被踢」处理的路径（ACCOUNT_MANAGEMENT 里那套 expired 状态机）可能被一次主动退出误触发；HTTP 语义上 DELETE 型操作应当幂等。
- **影响**：小；主要是前端状态机的边角（退出和被踢走同一条 401 路径，文案/行为可能不对）。
- **方案**：令牌无效时也回 204 + 清 cookie（「你要的退出状态已经达成」）：
  ```python
  with db_session() as session:
      token = _login_token(session, login_cookie)
      if token is not None:
          session.delete(token)
  result = Response(status_code=204)
  _clear_cookie(result, _COOKIE_NAME)
  return result
  ```
  若采纳 N5，这里同时 `events.publish(account_id, {"valid": False, "reason": "logout"})` 通知其他标签页。
- **第三方库**：无。
- **风险**：极低；前端若有依赖 401 的退出逻辑要同步看一眼。
- **工作量**：S。

### P14. 管理端点的防护与审计缺口（接口层视角，审计表本体归 backend-infra）

- **位置**：`app.py:315-339`（`admin_reset_password`：无频率限制，审计只有 `logger.info("控制台重置了密码 %s", account_id)` 一行）、`app.py:300-313`（账号列表同样无审计）。
- **现状**：admin cookie 一旦失窃（XSS、共享设备），攻击者可以无限速重置任何账号密码并踢下线，事后只有一行应用日志可查——而 `logs/server.log` 5MB 就轮转，审计价值有限。ACCOUNT_MANAGEMENT「基础安全」已列 `audit_log` 表 TODO（登录成功/失败、改密、重置、停用……「里面绝不能出现密码」）。
- **影响**：管理面是全站权限最高点，它的滥用检测和事后追溯现在最弱。
- **方案**：接口层先做两件不依赖审计表的事：(a) `admin_reset_password` 接 ratelimit（scope `"admin:reset"`，按 admin 账号 id + IP 计数，阈值可以宽——它本来是低频操作）；(b) 重置/列表的日志行升级为带操作者身份的固定格式（`logger.info("audit admin_reset operator=%s target=%s", admin_id, account_id)`），在审计表落地前至少可 grep。审计表本身（DDL、保留期、init.py 补列）按 README 分工归 backend-infra 篇，此处不展开。
- **第三方库**：无。
- **风险**：低；(a) 注意别把合法管理员锁在外面（阈值 10 次/15 分钟起步）。
- **工作量**：S。

### P15. `_merge_current_turn` 的文本比对兜底在编辑重发后会失真（新增，小项）

- **位置**：`app.py:770-799`（表里没有当前轮时，按「最后一条 user 记录的文字与 Redis 里的 question `strip()` 相等」判断要不要补提问行）。
- **现状**：这个兜底的注释自己承认是「按老办法」。两个已知失真面：上游记录与 Redis question 有任何文本差异（前端 trim/换行处理、上游对消息做过加工——FINDINGS 记录过上游回答开头带换行的例子）就会重复显示提问；N9 的编辑重发（问题文本被改）会让「删旧轮」后的窗口期里新旧文本对不上。
- **影响**：偶发的重复提问气泡；只在「表里没有这一轮」的异常路径出现（写库失败或轮次早于建表），概率低。
- **方案**：P5 的对账 + N1 的结局事件落地后，这条路径的出现率进一步降低，短期只需在兜底分支加一行 warning 日志（带 turn_id），让「出现了兜底」这件事可观测；中期随 O11 词表统一时把 `_merge_current_turn` 整体简化（表为准，Redis 只补当前轮，删掉文本比对）。
- **第三方库**：无。
- **风险**：无。
- **工作量**：S。

---

## 附：与既有文档的关系及建议的动手顺序

CHAT_STREAM_KNOWN_ISSUES 的「收敛顺序」五条与本篇的对应：1（结局事件）= N1；2（词表合一）= O11；3（/partial 收窄）= N1 的后半；4（中间件查库）= O1；5（结构化日志）= O7。本篇新增的主要发现：O2（avatar 大字段）、O3（Redis 同步调用堵事件循环）、O4（单轮占用竞态）、P2（无长度上限）、P3（locale 死字段）、P4（删除会话竞态）、P5（卡死 streaming 行）、P6（DB 挂时假 200）、P7（上游错误一刀切）、P8（停止后 7 秒压响应头）、P10（头像上传无边缘限制）。

若按「风险低、独立可验收」优先排一个建议顺序（最终以维护者排期为准）：

1. **一批小而独立的**：O7（日志收窄，代码里自己留的 TODO）、O8（SSE 头+心跳）、P2（长度上限）、P6（503 替代假 200）、P7（错误保真）、O11（词表合一）、P12/P13（304、logout 幂等）、O2（avatar deferred）、O6（缓存上限）。
2. **登录安全一批**：P1（登录限流）+ P14(a)（管理端点限流）+ O1（中间件查库，含令牌清扫定时化）。
3. **核心流式链路一批**（每条单独做、单独验收，AGENTS 边界）：O4（原子认领）→ P8（等待挪位）→ N1（结局事件，联动前端）→ P4（删除会话）→ P5（streaming 对账）。
4. **新功能按产品优先级**：N2/N3（分页搜索）、N4（会话元数据）、N5（事件通道，联动 ACCOUNT_MANAGEMENT 的前端待办）、N6（进度转发，联动上游工作流）、N8（OpenAPI）、N9/N10/N11。

依赖点名汇总（全部只是建议，装不装由维护者定）：**cachetools**（O6 的 TTLCache，可选，手写十行可替代）。其余所有方案均不需要新第三方库：`redis.asyncio`（O3）在已装的 redis 8.x 里；`pg_trgm`（N3）是 PostgreSQL 扩展而非 Python 包；`deferred`（O2）是 SQLAlchemy 自带。
