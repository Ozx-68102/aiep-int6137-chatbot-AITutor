# 后端接口层改进调研

> 调研范围：FastAPI 路由、FastGPT 代理、流式转发、回复存储（Redis）、限流，以及接口层对数据库的使用方式。数据库运维/部署面、日志基建、前端不在本篇（分别见 backend-infra.md 等）。
> 代码基线：main 分支快照 `1eadc4e8c042`。文中行号均指该快照下的文件行号。
> 本篇是只读调研：所有方案都是建议，动不动、怎么动由维护者决定。按 server/AGENTS.md 的边界规矩，凡涉及流式核心链路、接口契约、依赖变化的条目都单独标注了风险。

## 概览

### 读了哪些文件

- `server/AGENTS.md`（后端特有规矩、FastGPT v4.14.5 版本基线、Redis ACL 前缀约束）
- `server/src/server/`：`app.py`（1375 行，全部路由和流式转发）、`fastgpt.py`（上游客户端）、`chat_log.py`（自有 message 表读写）、`reply_store.py`（Redis 半截回复）、`ratelimit.py`（失败计数限流）、`url.py`、`settings.py`、`log.py`、`avatar.py`、`passwords.py`、`__init__.py`（uvicorn 入口）
- `server/src/server/types/`：`api.py`（接口模型）、`env.py`（配置模型）、`__init__.py`
- `server/src/server/db/`：`models.py`（表结构与索引）、`session.py`（引擎与会话）、`init.py`（幂等建表/补加数据列）、`backfill.py`（历史搬迁命令）
- 文档：`docs/FASTGPT_API.md`、原 `docs/INTERRUPTED_REPLY.md`（已退役，内容并入 `docs/CHAT_STREAM_PROTOCOL.md`）、`docs/ACCOUNT_MANAGEMENT.md`、原 `docs/CHAT_STREAM_KNOWN_ISSUES.md`（已退役，内容并入 `docs/CHAT_STREAM_PROTOCOL.md` 等）、`docs/MESSAGE_ACTIONS.md`、`docs/TECH.md`、`docs/FINDINGS.md`（相关条目）、`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md`（SSE 反向代理部分）

### 架构简述

后端是 Backend for Frontend：浏览器只访问它（生产经 nginx 把 `/api/` 反向代理到 `127.0.0.1:3001`，开发直连），它再用 httpx2 异步客户端代理内部部署的 FastGPT v4.14.5（`POST /v2/chat/completions` 流式对话、`POST /v2/chat/stop` 停止、`getPaginationRecords` 取历史、`item/delete` 与 `delHistory` 删记录）。uvicorn 单进程跑（模块级可变状态决定只能单进程，`app.py:131-141`、原 CHAT_STREAM_KNOWN_ISSUES 第 12 条——已退役，单进程前提见 docs/CHAT_STREAM_PROTOCOL.md）。

一轮对话的完整路径：`POST /api/chat`（`app.py:854-909`）先做轮次幂等检查（同一 `turn_id` 不重开）、单轮占用检查（`round_in_flight`，409）、停止标记检查（`stop_requested`），然后在 Redis 登记这一轮（`begin_reply`），起后台任务 `_relay` 拉上游流，**立刻**返回 SSE 响应头。`_relay`（`app.py:912-970`）把上游每个内容块写进 Redis（`append_chunk`）并推进 SSE 队列；上游 `[DONE]` 到达则 `mark_finished`。落定后 `_settle_round`/`_write_round_end`（`app.py:978-1015`）把最终文字和状态写进自有 `message` 表，失败轮还会叫停上游并按 `turn_id` 与上游核对并修正一次。

状态存三处：**PostgreSQL**（`account`/`session`/`message`/`login_token`/`language_setting`，页面显示的历史以 `message` 表为准）；**Redis**（`h2botapp-chat:{会话id}:status|text|turn|stop` 四个键，管「正在写的这一轮」的续期、停止标记，外加 `h2botapp-chat:ratelimit:*` 失败计数，全部带 TTL）；**FastGPT**（模型上下文的唯一来源，最近 6 轮由上游节点的 `history` 决定，我们改不了——`docs/FASTGPT_API.md`「历史与上下文」的结论）。

登录态：`login` cookie 存随机令牌，数据库里 `login_token` 存 SHA-256 哈希，7 天滑动续期；每个带 cookie 的请求由 ASGI 中间件 `_RefreshLoginCookie`（`app.py:158-190`）重发 cookie，端点内 `_account_from_cookie` 校验并把 role 判断收在一层。聊天侧只认 `chat` role，`/api/admin/*` 只认 `admin_login` cookie 里的 `admin` role。

已知的核心待修问题曾在原 `docs/CHAT_STREAM_KNOWN_ISSUES.md` 里成文（已退役，内容并入 `docs/CHAT_STREAM_PROTOCOL.md`；根因「这一轮的结局没有跟着流走」现已修复）。本篇不推翻它，而是把其中后端部分落到文件/函数级方案，并补充该文档没覆盖的发现（下文标注「新增」的条目）。

---

## 一、新功能机会

### N1. 流加结局事件 `event: done`，`/partial` 收窄成「还在写吗」

> **已实现（2026-11-05）**：流里加结局帧 event: done（TurnDoneEvent：turn_id/status/reason/bytes_sent），done 帧是即时判断、数据库是最终事实；/partial 收窄成只回答「还在写吗」（streaming 回 200，其余一律 404）；前端解读 partial.status 的点收敛到零。功能描述见 docs/CHAT_STREAM_PROTOCOL.md。调研原文以 LayerFS 历史为准。

### N2. 消息分页接口（新增）

> **暂缓（2026-11-05 决定）**：现在不做——当前用量离需要分页很远。触发条件：单场会话的消息数涨到页面加载可感变慢（几百条量级），或维护者点名要分页/搜索。届时与 N3、O10 及前端的会话列表搜索/日期分组一并立项。

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

> **暂缓（2026-11-05 决定）**：随 N2（消息分页）同批暂缓，触发条件见 N2 注记。

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

> **部分完成（2026-11-06）**：后端已实现——`GET /api/events` 已完成（进程内总线 `pushbus.py` ＋ `routes/events.py`；触发点三个：定时清扫→`expired`、改密→`password_changed`、控制台重置→`admin_reset`；`state` 命名事件、`{valid,reason,message}` 信封、连上先发状态、推完 valid:false 关流）。前端 EventSource 未接，接上整条链路才算完整。契约与部署边界见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「推送通道」一节；与设计稿的出入记录在 docs/ACCOUNT_MANAGEMENT.md「会话状态通道」注记。调研原文以 LayerFS 历史为准。

- **位置**：新端点；设计全文在 `docs/ACCOUNT_MANAGEMENT.md`「会话状态通道」一节（协议、三个触发点、心跳、`revoke_tokens` 统一函数都已定）；吊销令牌现在散在三处：`change_password`（`app.py:450-451`）、`admin_reset_password`（`app.py:334-335`）、`logout`/`admin_logout`。
- **现状**：账号被强制下线/密码被重置后，客户端要等下一次请求收到 401 才知道；多标签页退出互不知晓。ACCOUNT_MANAGEMENT 已把方案定到「进程内事件总线，不用 Redis pub/sub」（单进程假设成立，CHAT_STREAM 第 12 条）。
- **影响**：「改密码或被禁用之后客户端要立刻知道」这条核心需求没有服务端支撑；前端只能靠 30 秒 `/api/status` 轮询保底，而 status 还不带鉴权语义。
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
                      yield ": ping\n\n"   # 心跳，防代理切断空闲连接
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

> **已实现（2026-11-05）**：请求转换成 detail:true，中继层只挑 flowNodeStatus 组成 event: progress 帧转发（name/status 原样、不做映射文案）；flowNodeResponse 与 updateVariables 任何级别不整行写进日志、绝不转发。功能描述见 docs/CHAT_STREAM_PROTOCOL.md。调研原文以 LayerFS 历史为准。

### N7. 健康探针拆分：liveness 与带 upstream 的 readiness

- **位置**：`app.py:499-515`（`read_status`/`_database_available`）、`reply_store.py:104-108`（`store_available`）。
- **现状**：`GET /api/status` 是唯一的状态口：每次都真查一次 DB（`select(1)`）+ Redis ping，无鉴权，30 秒 × 每个在线客户端。它报 database 和 reply_store，但**不报上游 FastGPT**——上游挂了，页面常驻提示一切正常，用户发消息才失败。
- **影响**：部署侧没有零依赖的存活检查端点（进程死锁时 `/api/status` 也会挂住，分不清「进程没了」和「依赖没了」）；用户和维护者都要靠发消息试出上游故障。
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
- **现状**：`/docs`、`/openapi.json` 不设防：无标题版本、无分组、无错误响应说明；`docs/TECH.md` 让人「接口清单看 app.py 源码」。前后端联调、控制台后续批次、以及任何新加入的人都要读 1375 行 app.py。
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

> **已实现（2026-11-05）**：编辑重发复用 POST /api/chat + retryOf，不新增端点；悬空提问改拿我们自己 message 表里读出的提问原文比对（MESSAGE_ACTIONS.md 方案①，chat_log.read_question），接口没加字段。功能描述见 docs/MESSAGE_ACTIONS.md。调研原文以 LayerFS 历史为准。

### N10. 会话创建的幂等（新增）

> **暂缓（2026-11-05 决定）**：前端已不再盲目重试建会话类 POST（frontend-app P1 注记），重复建的现实风险已被挡住；幂等键属跨栈的锦上添花根治，维护者决定先记着，回头跨栈批次再做。

- **位置**：`app.py:527-541`（`create_session`，id 由服务端 `uuid4` 生成）、`types/api.py:26-27`（`SessionCreate` 只有 title）。
- **现状**：`POST /api/chat` 有 turn_id 幂等（CHAT_STREAM 表扬过的那条），但 `POST /api/sessions` 没有：网络抖动/双击下客户端重发会建出两个空会话。删除接口有 `delHistory` 幂等保底处理（对不存在的 chatId 也返回 200），创建没有对应机制。
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

> **已实现（2026-11-05）**：清扫从请求路径挪进 lifespan 定时任务（启动一次 + 每 600 秒）；校验加续期合成单条 UPDATE...RETURNING（synchronize_session=False），中间件查询结果经 contextvar 请求态复用（端点仍做一次主键取行拿活 ORM 对象），中间件查数据库包 asyncio.to_thread；expires_at 索引经 alembic 迁移 0001 建立。功能描述见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md。调研原文以 LayerFS 历史为准。

### O2. `Account.avatar` 大字段跟着每一次认证请求跑（新增）

> **已实现（2026-11-05）**：Account.avatar 改成列级延迟加载（SQLAlchemy deferred，server/src/server/db/models.py），认证与列表请求不再背着头像字节；真正读头像的端点多一次按主键的 SELECT。功能描述见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「每请求的成本」一节。调研原文以 LayerFS 历史为准。

### O3. Redis 同步客户端在事件循环里：故障时放大成全服务卡顿（新增，与 CHAT_STREAM 第 12 条相邻但不同）

> **已完成（2026-11-06）**：客户端换成 `redis.asyncio`（`infra/redis_client.py` 共享单例，连接参数、双 2 秒短超时、不重试逐项保留），全部调用点改 await（限流、半截存取、停止标记、状态探针），原同步端点里碰 Redis 的按异步端点重排、DB 侧的 to_thread 原样保留；「Redis 不通就放行/降级」哲学与键前缀规矩逐处保持。慢 Redis 从此只卡 await 它的那一个协程，不再阻塞事件循环。真实环境冒烟测试：整轮对话、1 秒急停、双发 409、限流计数、改密全路径通过。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「降级与超时」。调研原文以 LayerFS 历史为准。

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

> **已完成（2026-11-06）**：「查＋占」合成 `reply_store.claim_round` 一个原子动作——`SET … GET` 单命令（写状态键同时原子拿回旧值，旧值 streaming 即没抢到、回 409；抢到当场完成原 begin_reply 的三键登记）。没按本节设想的 Lua 脚本做：生产环境 ACL 不放行 evalsha（docs/FINDINGS.md 2026-11-06 条目），脚本一降级守卫整个失效；`SET NX` 也不行（落定轮的状态键活到 TTL，NX 永远失败）。同轮次幂等预检、被停路径优先级（忙压过停）、Redis 降级放行全部保持。真实环境冒烟测试：进行中双发不同轮 409、同轮重发 409、落定后下一轮不误拦。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「同一场会话同时只跑一轮」。调研原文以 LayerFS 历史为准。

- **位置**：`app.py:877`（`round_in_flight` 读）→ `app.py:900`（`begin_reply` 写）；`reply_store.py:44-58`（`begin_reply` 用 pipeline 但无条件 SET）。
- **现状**：「同一场会话同时只跑一轮」靠先读 status 再写 status 实现，两步之间没有原子性。两个并发 `POST /api/chat`（不同 turn_id、同一 chat_id——比如两个标签页同时发、或前端重发时序错开）可以都通过 `round_in_flight` 检查，然后双双 `begin_reply`：后写的把先写的 turn 键覆盖，两轮的片段交错写进同一个 text 键——正是原 INTERRUPTED_REPLY（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）「同一场会话同时只跑一轮」一节描述要防的事故，现在的防线在并发下有缝。turn_id 幂等检查（`app.py:866-873`）只防「同一请求来两次」，防不了「两个不同请求」。
- **影响**：低概率但后果脏：Redis 半截文字两轮混写、上游多出一轮、message 表 seq 交错（`_next_seq` 的 max+1 也会冲突）。多标签页是真实使用场景（ACCOUNT_MANAGEMENT 通篇在讨论多标签页）。
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
  严格做要用 Lua 脚本把「读 status+turn、判断是否重复、写三键」合成一步（`Redis.register_script`，redis 包自带）；上面的两步版已经把窗口从「整个请求处理期间」缩到「毫秒级」，是否值得上 Lua 由维护者定。
- **第三方库**：无。
- **风险**：降级语义要保持——Redis 不通时返回 True 放行（现状如此）；改动落在 chat 核心链路，要许可 + 单独验收。
- **工作量**：S（两步版）/ M（Lua 版）。

### O5. httpx2 客户端：连接池未配置、各接口共用一套超时

- **位置**：`fastgpt.py:200-215`（`open_fastgpt`：`Timeout(10.0, read=fastgpt_read_timeout_seconds)`，未设 `limits`/`write`/`pool`）、`fastgpt.py:124-153`（`stop_chat`）、`fastgpt.py:99-122`（`records`）。
- **现状**：一个 `AsyncClient` 服务所有上游调用。超时只细分了 connect/read：`stop_chat` 的读超时也是 30 秒，而它上游自己最多等 5 秒（FASTGPT_API 实测），给它 30 秒意味着上游卡死时我们的 `_pending_stops` 要挂 30 秒才生效，`_wait_for_stop` 的 7 秒上限又让新一轮先走了——停止标记晚到中止新一轮的窗口反而变宽。`records` 是小查询，也受 30 秒读超时限制。连接池用 httpx 默认（max_connections=100 / keepalive 20），对单一上游主机没有按场景收敛，keepalive_expiry 默认 5 秒，上游/中间层若更快关空闲连接，会偶发 `RemoteProtocolError`（httpx 对 keepalive 竞态不自动重试）。
- **影响**：故障时资源被无谓占住；停止路径的时序余量被超时配置消耗掉；池参数没有按「单上游、并发 = 在线学生数」调过。
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
- **风险**：低；超时数字改动会影响故障表现，改完要按原 INTERRUPTED_REPLY（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）的实测方法过一遍停止/失败路径。
- **工作量**：S。

### O6. `_records_cache` 无上限，且只在写入时清理陈旧项

> **更正注记（2026-11-06，取代原「已完成（2026-11-05）」注记）**：原注记说「这份进程内缓存整个不存在了」，与代码不符。实际情况：缓存已退出页面历史主路径——历史改成以我们自己的消息表为唯一事实来源后，主路径直读表，只剩老会话首次打开时的补录（history.backfill_session，数据库无记录才从上游取一次）还读这份缓存；删上游记录后的失效逻辑也还在（routes/chat.py）。但缓存代码保留：history.py 的 records_cache 仍是无上限字典，session_records 每次读上游都无条件写入，慢性内存增长只是触发面缩小、没有根除。维护者已决定保留代码（2026-11-06），下面的「加条目上限」方案不再实施。

- **位置**：`app.py:139-141`、`app.py:686-726`（`_session_records`/`_drop_stale_records`）。
- **现状**：模块级 dict，每场被读过历史的会话存一份**全量** `ChatRecord` 列表（含整场文字）。陈旧项（>100 秒）只在有新写入时被顺带清理：一批会话被集中读过之后再也无人访问，这些条目就永远留在内存里。进程长跑 + 学期内几百个学生各几场会话，是持续增长的常驻内存。
- **影响**：慢性内存泄漏（有界于「所有会话历史总和」，但这个界不小）；缓存本来只是 5 秒的防刷新临时措施，却按 100 秒+无限期持有。
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

> **已实现（2026-11-05）**：INFO 只留元数据；全文日志（对话请求体、FastGPT 请求、上游每行、发给页面每帧）全部降到 debug（.env 的 DEBUG=1 打开）；flowNodeResponse/updateVariables 任何级别不整行写进日志；每轮落定打一行 turn_summary。功能描述见 docs/TURN_LOGGING_AND_DIAGNOSTICS.md。调研原文以 LayerFS 历史为准。

### O8. SSE 响应缺 no-store / X-Accel-Buffering 头，且上游静默期没有心跳

> **已实现（2026-11-05）**：SSE 响应统一带 Cache-Control: no-store 和 X-Accel-Buffering: no（_SSE_HEADERS）；流上 15 秒没有动静发一帧 ": ping" 注释心跳。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「心跳与响应头」一节。调研原文以 LayerFS 历史为准。

### O9. chat_log 每轮的 SQL 往返可以减半；`_next_seq` 有并发编号冲突的风险

- **位置**：`chat_log.py:57-89`（`begin_round`：DELETE + SELECT max(seq) + 2×INSERT）、`chat_log.py:92-102`（`finish_round`：SELECT 两行 + 逐行 ORM UPDATE）、`chat_log.py:252-257`（`_next_seq`）。
- **现状**：原 INTERRUPTED_REPLY（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）说「一轮开始一个事务、落定一个事务」，实测中位 0.30ms——量级没问题，但每个事务内部的往返数可以压：begin_round 5 条语句、finish_round 3 条。`_next_seq` 用 `SELECT max(seq)+1`，两个并发事务能算出同一个号（现在被「单轮占用 + 单进程」挡住；O4 的竞态一旦发生，seq 就会交错，`message_session_id_seq_idx` 排序的历史会乱序——seq 上没有唯一约束保底）。
- **影响**：正常时是小优化；异常并发时 seq 编号冲突会导致历史排序错乱，且无声无息（没有约束报错）。
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
  # 或保持现状但给 (session_id, seq) 加唯一约束把编号冲突变成显式报错——加约束归 db 维护面，交接。
  ```
  若 O4 的原子认领做了，编号冲突的前提就消失，这里只剩往返数优化，优先级可降。
- **第三方库**：无。
- **风险**：低；`begin_round` 的 DELETE（同 turn 重写）语义要保留。
- **工作量**：S。

### O10. `/api/sessions` 返回裸数组、无分页、置顶排序在前端

> **暂缓（2026-11-05 决定）**：随 N2/N3（会话规模化）同批暂缓；会话数涨到加载可感变慢再回头看。

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

### O11. 两套状态词表合一（CHAT_STREAM 第 2 条的实施方案）

> **已实现（2026-11-05）**：server/src/server/turn_status.py 独家拥有 streaming/completed/failed/aborted 四个状态词；Redis 线上值保持 "finished"，reply_store 在自己的边界上映射。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「状态词表」一节。调研原文以 LayerFS 历史为准。

---

## 三、未完善与潜在问题

### P1. 登录接口没有限流（ACCOUNT_MANAGEMENT 的 TODO 至今未接）

> **已实现（2026-11-05）**：/api/login 和 /api/admin/login 接上现成 ratelimit：账号维度用归一化用户名（strip().lower()），IP 维度用 request.client.host、与改密路径共用 IP 桶（维护者知情）；只数 401（含「查无此人」，防用户名枚举）；锁定 15 分钟/5 次沿用现状；Redis 挂时放行。功能描述见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md。调研原文以 LayerFS 历史为准。

### P2. 请求体无长度上限：message、password 都能无限长（新增）

> **2026-11-04 维护者决定**：`message` 的长度上限定为 **8000 字**。密码相关字段的上限照本节建议（128，与现有密码策略常量一致）。本节其余内容（nginx 请求体上限的保底限制、前端输入提示）不变，实施时一起做。

> **部分实现（2026-11-05）**：后端模型上限已完成（message max_length=8000、密码类 128，422 仍回一句中文），前端提问框和编辑框 maxLength 8000 对齐；nginx client_max_body_size 保底限制留部署日。功能描述见 docs/CHAT_PAGE_BEHAVIOR.md「输入」一节。调研原文以 LayerFS 历史为准。

### P3. `ChatRequest.locale` 是已废弃的字段（新增）

> **已完成（2026-11-06）**：字段已删。前端仍在发它也无碍：pydantic v2 默认忽略多余字段，不会 422。报错文案的三语化由前端按状态码映射负责（已成事实），后端不需要请求级语言字段。调研原文以 LayerFS 历史为准。

- **位置**：`types/api.py:131`（`locale: str | None = None`）；grep 全 `app.py`，`locale` 只出现在 profile 相关代码（`app.py:401/1231/1313-1319`），chat/`_relay`/`fastgpt.events` 都不读它。
- **现状**：前端每条消息都带 locale，后端收下就扔。也没有校验（任意字符串都过）。
- **影响**：接口契约里有一个字段在说谎——读代码的人会以为上游按 locale 回答；将来真要做多语言回答时，会误以为通路已经在。
- **方案**：二选一，都要维护者定：(a) 删字段（前端同步去掉，422 不会发生——Pydantic 默认忽略多余字段，可以先删后端再删前端）；(b) 真转发——FastGPT v4.14.5 的 `v2/chat/completions` 支持 `variables`（照 AGENTS 的规矩：以 v4.14.5 源码 `projects/app/src/pages/api/v2/chat/completions.ts` 为准实测确认，工作流里要有消费这个变量的节点才有意义），payload 加 `"variables": {"locale": body.locale}`。若保留字段，先收紧成 `Literal["zh-CN", "zh-TW", "en"] | None`。
- **第三方库**：无。
- **风险**：(b) 依赖上游工作流配置，不是我们单边能生效的事。
- **工作量**：S。

### P4. `delete_session` 的部分失败与并发竞态（新增）

> **已完成（2026-11-06）**：删除顺序改为维护者决定的「先本地后上游」——本地删成功或本来就不存在（重复删除/上次尝试中途失败）都继续删上游（上游删除幂等，404 当成功），上游失败照样回 204 只记 warning；本地因数据库错误失败回 503、上游一点不动、会话完好可重试。最坏窗口从「上游没了、本地挂着一个已失效的会话（用户可见）」变成「本地没了、上游残留（不可见、可续删）」。真实环境对上游实测 204。已知边界如实记录：中间态重试会先被鉴权的 404 挡住（存在性检查在 security/accounts.py，拿掉会留下越权漏洞），但该状态下会话已从列表消失、用户无感知。调研原文以 LayerFS 历史为准。

- **位置**：`app.py:570-589`。
- **现状**：顺序是「上游 `delHistory` → 删本地数据库（message 行 + session 行）→ `discard_reply`」，三个已核实的问题：
  1. **流式中的会话可以被删**：不取消 `_running` 里的任务、不叫停上游。删除后 `_relay` 照跑：上游把答案写完（token 白白消耗），`append_chunk`/`mark_finished` 在 `discard_reply` 之后把 Redis 键又建回来（带 TTL 的残留键），`finish_round` 更新不到行（已被删）静默空转。
  2. **上游成功、本地数据库删除失败** → 500，会话在本地还在但上游上下文已清空；用户重试删除可以走通（`delHistory` 对不存在的 chatId 也回 200，FASTGPT_API 实测），但期间的 `/messages` 会触发 `_backfill_session` 把空历史「抄」进表——数据没丢（本来就要删），语义混乱。
  3. `FastGPTError` 被映射成 **500**（`app.py:578-584`），上游问题报了服务器错误，和 `_backfill_session` 用 502 的口径不一致（P7）。
- **影响**：删除与流式并发时产生没人再读的残留 Redis 键、白白消耗 token；错误码口径混乱。
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
  502/500 口径随 P7 一起理。上游成功、本地数据库删除失败的窗口无法完全消除（跨系统没有事务），但至少要在日志里把两个阶段分开记，方便人工核对并修正。
- **第三方库**：无。
- **风险**：动停止链路（AGENTS 核心链路，要许可）；`_wait_for_stop` 最长 7 秒会让删除请求变慢——可以给删除路径用更短的等待或不等（反正马上 delHistory，上游整轮记录都会被软删除）。
- **工作量**：M。

### P5. `message` 表里卡死的 streaming 行没有核对路径（新增）

> **已实现（2026-11-05）**：两层核对都完成——读时 _merge_current_turn 把「Redis 编号对不上的 streaming 行」展示层降级为 failed（不写进数据库）；启动时 lifespan 里 chat_log.fail_stuck_rounds 一条 UPDATE 标掉全部卡死的轮次（单进程前提）。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「卡死行核对」一节。调研原文以 LayerFS 历史为准。

### P6. 数据库不可用时 `/messages` 返回 200 + 空历史（新增）

> **已完成（2026-11-06）**：`chat_log.read_messages` 的数据库错误如实上抛（不再吞成空列表），GET messages 与会话列表两个读端点接住回 503（detail 一句中文人话）；「真的没记录」和「读不出来」从此分得清。流式轮次进行中写进数据库失败的故意吞异常（归档降级）原样保留，读写两个方向的语义差异写进了 docstring。调研原文以 LayerFS 历史为准。

- **位置**：`chat_log.py:122-145`（`read_messages` 把 `SQLAlchemyError` 吞成 `[]`，注释写明「读不出来就当没有，让上游那份顶上」）、`app.py:645-663`（`read_session_messages` 拿 `[]` 当「老会话」走 `_backfill_session`）、`chat_log.py:147-181`（`backfill` 的 `_write` 同样吞错）。
- **现状**：DB 挂了时的完整链路：`read_messages` → `[]` → 被当成「没有记录的老会话」→ 问上游要全量历史（成功的话）→ `backfill` 写进数据库静默失败 → 再 `read_messages` 又是 `[]` → **200 + 空 messages**。页面看到的是「这场会话一条消息都没有」。若上游也恰好失败，则 502——同一个故障两种表现。
- **影响**：「数据库不可用」被伪装成「会话是空的」。用户以为历史丢了；前端若有「空会话自动删除/重建」之类的逻辑会被误触发；排查故障时 200 响应完全不指向真实故障。
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
  降级链保留给 backfill 内部（走上游保底的那半不变）。`/api/status` 的 database 字段会让前端横幅同时亮，两处信号一致。
- **第三方库**：无。
- **风险**：低；行为从「错误的 200」变成「诚实的 503」，前端对 503 的文案要过一遍（`{"detail": …}` 契约不变）。
- **工作量**：S。

### P7. 上游错误一刀切：`FastGPTError` 不带任何信息，端点错误码口径不一（新增）

> **已完成（2026-11-06）**：`FastGPTError(step, *, upstream_status=None, snippet=None)`——带上哪一步、上游状态码、非 200 响应正文开头（截断 200 字符；成功正文与请求头绝不入内，学生数据和 API key 都不会带出），str() 是一句能直接写进日志的平常话；全部 raise 点补齐。补录、点赞点踩反馈等非流式端点的上游失败统一 502；删会话经顺序重排（P4：先本地后上游）后是例外——上游删失败只记 warning、照样回 204，理由同 P4 注记与 routes/sessions.py 的代码注释（会话已从用户眼前消失，回错误码只会让页面把不存在的会话显示成「删除失败」）。流式侧维持「流结束＋done 帧如实报」不变。调研原文以 LayerFS 历史为准。

- **位置**：`fastgpt.py:17-18`（异常类零字段）、`fastgpt.py:79-84`（非 200 时读了正文、记了日志，然后 `raise FastGPTError` 把状态码丢了）、`app.py:578-584`（delete_session 把上游失败报 **500**）vs `app.py:669-673`（backfill 把上游失败报 **502**）。
- **现状**：上游 401（API key 错）、400（appId 错、「工作流版本过低」，FASTGPT_API 记录过这个拒绝）、429、5xx、超时，到了端点全变成同一句「暂时问不到上游」或「服务器错误」。配置错误（我们自己的 .env 写错）和上游故障（他们挂了）在响应和告警面上无法区分。
- **影响**：维护者排查故障要靠翻日志正文；配置错误会被当成上游抖动忽略掉；监控（若有）没法按错误类别告警。
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

> **已完成（2026-11-06）**：等叫停生效从响应头之前挪进流任务（`relay_turn`：登记提问之后、调上游之前）——响应头立刻回，页面等待气泡马上出现，最长 7 秒的等待不再表现为「死机」。等待期间被停走既有取消清理；7 秒小于 15 秒心跳，等待期不发心跳。场景澄清（比本条标题窄）：这个等待只发生在「上一轮失败、后端补发过叫停」之后的立即重发；用户按停止那条路本来就不等。附带口径变化：turn_summary 的 duration/first_byte 现在含这段等待（见 docs/TURN_LOGGING_AND_DIAGNOSTICS.md）。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「停止」。调研原文以 LayerFS 历史为准。

- **位置**：`app.py:893-895`（`chat` 在返回 StreamingResponse **之前** `await _wait_for_stop(body.chat_id)`）、`app.py:1115-1124`（`_STOP_WAIT_SECONDS = 7.0`）、`fastgpt.py:124-153`（stop 调用本身，配合 O5 的超时收紧）。
- **现状**：等停止生效的机制是对的（FASTGPT_API：上游每轮开始会删停止标记，标记晚到会中止新一轮），但它放在响应头发出之前。用户「按停止 → 马上改口重发」是高频动作，此时新请求要干等上一轮的 `_stop_upstream` 生效（正常几百毫秒，上游卡时到 7 秒上限）才拿到响应头。docs/CHAT_STREAM_PROTOCOL.md（原 INTERRUPTED_REPLY，已退役）专门记过「响应头要立刻回」（0.013 秒实测），这条路径把那个修复又局部推翻了。
- **影响**：停止后重发的体验退化：页面等待气泡不转、前端超时重发逻辑可能被触发（turn_id 幂等保底，不会生成两遍，但请求白白多一轮）。
- **方案**：把等待挪进 `_relay` 任务（登记照旧在前，等待发生在真正调上游之前）：
  ```python
  # chat()：删掉 await _wait_for_stop(...)，begin_reply 之后直接建任务、回响应头
  # _relay()：
  await asyncio.to_thread(chat_log.begin_round, ...)
  await _wait_for_stop(chat_id)      # 挪到这里：等写完再问上游，时序约束不变
  async for event in fastgpt.events(...)
  ```
  时序核对：停止标记必须在我们调 `v2/chat/completions` 之前写入（上游在**它那轮开始时**删标记）——挪动后依然满足；页面侧提前看到 `streaming` 状态，语义无害。`retry_of` 的 `_clear_failed_turn`（也在响应头之前，`app.py:897-898`）同理可以挪进任务，但它涉及删上游记录，失败时页面拿不到 409/502 之类的即时信号——建议第一期只挪 `_wait_for_stop`。
- **第三方库**：无。
- **风险**：动停止时序（文档明确机制），改完要按原 INTERRUPTED_REPLY（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md）的停止实测场景表复测（停止先到/对话先到/停完立刻发新轮）。
- **工作量**：S～M。

### P9. cookie 没有 `Secure` 标志（新增；与 backend-infra 交界，接口层视角记录）

- **位置**：`app.py:1340-1349`（`_set_cookie`：`httponly=True, samesite="lax", path="/"`，无 `secure`）。
- **现状**：生产形态是 nginx 终结 HTTPS 反向代理到本机 3001（NGINX_SPA_DEPLOYMENT_GUIDE），nginx→uvicorn 一段是 http，所以代码里没写 `secure` 在开发环境是自洽的；但浏览器看到的是 https 站点，cookie 没标 Secure 意味着若用户被诱导访问同域的 http 端口/降级路径，令牌会明文发出。`login` cookie 是 7 天有效的 bearer 令牌，值得按最严格处理。
- **影响**：令牌泄露面；学生设备环境不可控（学校网络中间盒），这不是理论风险。
- **方案**：配置驱动：`Settings` 加 `cookie_secure: bool = False`（`.env` 的 `COOKIE_SECURE=1` 在生产开），`_set_cookie` 传 `secure=settings.cookie_secure`。进一步可把 cookie 名改成 `__Host-login`（浏览器强制 secure+path=/+无 domain），但那要前后端同改且开发环境 http 下直接不可用，不建议。samesite=lax 已挡住跨站 POST（CSRF 主面），维持。
- **第三方库**：无。
- **风险**：生产忘开则形同虚设、开发误开则登录坏掉——用配置项而非硬编码正是为了两边都对。部署清单项，交接 backend-infra。
- **工作量**：S。

### P10. 头像上传的实际大小限制不在我们手里（FINDINGS 已证实的坑，未解决）

- **位置**：`app.py:462-476`（`upload_avatar` 只读 `MAX_UPLOAD_BYTES + 1`）、FINDINGS 2026-11-02 条目（starlette `max_part_size` 只管普通表单字段，**不管文件部分**；上传文件整个落 `SpooledTemporaryFile`，无上限）。
- **现状**：端点内「只读上限加一的字节」防住了内存，但防不住传输和落盘：FastAPI 解析 multipart 时**整个请求体已经收完并 spool 到临时文件**，端点才开始读。一个 2GB 的「头像」会先完整走一遍网络和磁盘。
- **影响**：磁盘/带宽滥用面；单进程服务在大上传期间线程池被占用。
- **方案**：两道边缘限制：(a) nginx 给 `/api/avatar` 单独 `client_max_body_size 6m`（其余 `/api/` 可以收到 1m，顺便接住 P2）；(b) 应用层提前拒——端点加 `request: Request` 参数，看 `Content-Length` 头超上限直接 413（对不带该头的 chunked 请求无效，所以 (a) 仍是主要限制）：
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
  4. 计数窗口是「第一次失败起 15 分钟」的固定窗：攻击者可以每 15 分钟来 5 次地低速暴力破解（5 次/15 分钟 = 480 次/天/账号）。对初始口令账号（P1）这个速率不算安全。
- **影响**：单看都是小毛病；合起来是「限流设施能更结实」的清单。第 4 点若 P1 完成后仍担心，可把 MAX_FAILURES 收紧或改指数退避（每轮锁定时间翻倍，键值存 `count` 和 `lock_until` 两个字段）。
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

> **已完成（2026-11-06）**：GET /api/avatar 认条件请求了——If-None-Match 与当前 ETag 等值（处理引号、W/ 前缀、* 通配、逗号多值）回 304 不带 body、保留 ETag 头，浏览器用本地缓存；不匹配走原逻辑。调研原文以 LayerFS 历史为准。

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

> **决定不改（2026-11-05）**：现状是故意设计——无法吊销时按会话过期语义回 401 带 reason（routes/auth.py 注释写明「令牌已死时的退出也是会话过期语义」）；前端已经接住：退出调用碰到 401 时静默进未登录态、不弹错（App.tsx 退出函数的 catch 分支）。后端改成「一律回成功」用户可见差异为零，维护者决定不改，本条关闭。

- **位置**：`app.py:363-381`（`logout`）、`app.py:342-361`（`admin_logout`）。
- **现状**：令牌已过期/已吊销时点退出会得到 401 +「未登录」+ 清 cookie。前端把 401 当「被强制下线」处理的路径（ACCOUNT_MANAGEMENT 里那套 expired 状态机）可能被一次主动退出误触发；HTTP 语义上 DELETE 型操作应当幂等。
- **影响**：小；主要是前端状态机的边角（退出和被强制下线走同一条 401 路径，文案/行为可能不对）。
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
- **现状**：admin cookie 一旦失窃（XSS、共享设备），攻击者可以无限速重置任何账号密码并强制该账号下线，事后只有一行应用日志可查——而 `logs/server.log` 5MB 就轮转，审计价值有限。ACCOUNT_MANAGEMENT「基础安全」已列 `audit_log` 表 TODO（登录成功/失败、改密、重置、停用……「里面绝不能出现密码」）。
- **影响**：管理面是全站权限最高点，它的滥用检测和事后追溯现在最弱。
- **方案**：接口层先做两件不依赖审计表的事：(a) `admin_reset_password` 接 ratelimit（scope `"admin:reset"`，按 admin 账号 id + IP 计数，阈值可以宽——它本来是低频操作）；(b) 重置/列表的日志行升级为带操作者身份的固定格式（`logger.info("audit admin_reset operator=%s target=%s", admin_id, account_id)`），在审计表实施前至少可 grep。审计表本身（DDL、保留期、init.py 补加数据列）按 README 分工归 backend-infra 篇，此处不展开。
- **第三方库**：无。
- **风险**：低；(a) 注意别把合法管理员锁在外面（阈值 10 次/15 分钟起步）。
- **工作量**：S。

### P15. `_merge_current_turn` 的文本比对保底处理在编辑重发后会失真（新增，小项）

> **更正注记（2026-11-06，取代原「已完成（2026-11-05）」注记）**：原注记说「『按提问文本比对』的保底处理整个删除」，与代码不符。实际情况：合并主路径（history.merge_current_turn）确已按轮次编号对号——Redis 里半截的这一轮，编号与表里的行对得上才合并，对不上如实降级为 failed 展示（启动核对随后清理数据库）；但「表里没有这一轮」的补提问分支仍按提问文本比对防重（代码注释自书「按老办法」）。维护者已决定保留该分支（2026-11-06）：真删会让写库失败但仍在生成的轮次从页面整个消失。编辑重发、上游文本加工两个失真情形在该分支里仍然存在，见下文「现状」。

- **位置**：`app.py:770-799`（表里没有当前轮时，按「最后一条 user 记录的文字与 Redis 里的 question `strip()` 相等」判断要不要补提问行）。
- **现状**：这个保底处理的注释自己承认是「按老办法」。两个已知失真情形：上游记录与 Redis question 有任何文本差异（前端 trim/换行处理、上游对消息做过加工——FINDINGS 记录过上游回答开头带换行的例子）就会重复显示提问；N9 的编辑重发（问题文本被改）会让「删旧轮」后的窗口期里新旧文本对不上。
- **影响**：偶发的重复提问气泡；只在「表里没有这一轮」的异常路径出现（写进数据库失败或轮次早于建表），概率低。
- **方案**：P5 的核对 + N1 的结局事件完成后，这条路径的出现率进一步降低，短期只需在保底分支加一行 warning 日志（带 turn_id），让「出现了保底处理」这件事可观测；中期随 O11 词表统一时把 `_merge_current_turn` 整体简化（表为准，Redis 只补当前轮，删掉文本比对）。
- **第三方库**：无。
- **风险**：无。
- **工作量**：S。

### P16. 启动核对不清 Redis 轮次键：崩溃后 `/partial` 最长 600 秒仍答 200（新增，小项）

> **已完成（2026-11-06）**：启动核对补上 Redis 这半边——lifespan 里 `reply_store.clear_leftover_round_keys` 用 SCAN 清掉 `h2botapp-chat:` 前缀下 `:status`/`:text`/`:turn`/`:stop` 四种残留键，无论清了几个都记一行 info，Redis 失败只警告不阻止启动。安全依据与数据库侧同一条：单进程前提下进程刚启动时不可能真有轮次在写。真实环境验证：预先塞 3 个残留键再重启，日志如实报 3 个、零残留。功能描述见 docs/CHAT_STREAM_PROTOCOL.md「轮次键 TTL 与崩溃窗口」。调研原文以 LayerFS 历史为准。

- **位置**：`app.py` lifespan 的启动核对（只调 `chat_log.fail_stuck_rounds` 清理数据库）；`reply_store.py` 的 `:status` / `:turn` / `:text` 键等 `REDIS_KEY_TTL_SECONDS`（现 600 秒）自然过期。
- **现状**：进程崩溃重启后，数据库里 streaming 行被标成 failed，但 Redis 里的状态键还活着——`/partial` 仍答「还在写」，页面会对卡死的轮次继续轮询/续传，直到键 TTL 到期才走 404 → 读时保底修正（docs/CHAT_STREAM_PROTOCOL.md「轮次键 TTL 与崩溃窗口」）。
- **影响**：崩溃窗口（≤600 秒）内页面假等待；触发条件是崩溃恰好落在某轮进行中，概率低；有保底修正、能自行恢复，不会永久卡死。
- **方案**：启动核对把标 failed 的会话 id 集合带出来，对每个 id 删掉 Redis 三个轮次键（reply_store 已有键名工具，补一个 `clear_round` 类函数；Redis 不通照旧走「放行」降级）。单进程前提下不存在误删活轮。
- **第三方库**：无。
- **风险**：低——只动卡死的轮次的键，且与数据库内的核对同一时刻发生。
- **工作量**：S。

---

## 附：与既有文档的关系及建议的动手顺序

原 CHAT_STREAM_KNOWN_ISSUES.md（已退役，内容并入 docs/CHAT_STREAM_PROTOCOL.md 等）的「收敛顺序」五条与本篇的对应：1（结局事件）= N1；2（词表合一）= O11；3（/partial 收窄）= N1 的后半；4（中间件查数据库）= O1；5（结构化日志）= O7。本篇新增的主要发现：O2（avatar 大字段）、O3（Redis 同步调用堵事件循环）、O4（单轮占用竞态）、P2（无长度上限）、P3（locale 已废弃的字段）、P4（删除会话竞态）、P5（卡死 streaming 行）、P6（数据库挂时假 200）、P7（上游错误一刀切）、P8（停止后 7 秒压响应头）、P10（头像上传无边缘限制）。

若按「风险低、独立可验收」优先排一个建议顺序（最终以维护者的安排为准）：

1. **一批小而独立的**：O7（日志收窄，代码里自己留的 TODO）、O8（SSE 头+心跳）、P2（长度上限）、P6（503 替代假 200）、P7（错误保真）、O11（词表合一）、P12/P13（304、logout 幂等）、O2（avatar deferred）、O6（缓存上限）。
2. **登录安全一批**：P1（登录限流）+ P14(a)（管理端点限流）+ O1（中间件查数据库，含令牌清扫定时化）。
3. **核心流式链路一批**（每条单独做、单独验收，AGENTS 边界）：O4（原子认领）→ P8（等待挪位）→ N1（结局事件，联动前端）→ P4（删除会话）→ P5（streaming 核对）。
4. **新功能按产品优先级**：N2/N3（分页搜索）、N4（会话元数据）、N5（事件通道，联动 ACCOUNT_MANAGEMENT 的前端待办）、N6（进度转发，联动上游工作流）、N8（OpenAPI）、N9/N10/N11。

依赖点名汇总（全部只是建议，装不装由维护者定）：**cachetools**（O6 的 TTLCache，可选，手写十行可替代）。其余所有方案均不需要新第三方库：`redis.asyncio`（O3）在已装的 redis 8.x 里；`pg_trgm`（N3）是 PostgreSQL 扩展而非 Python 包；`deferred`（O2）是 SQLAlchemy 自带。
