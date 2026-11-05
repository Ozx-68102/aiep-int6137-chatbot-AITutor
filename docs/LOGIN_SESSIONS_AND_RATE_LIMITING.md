# 登录态、令牌与限流

登录态怎么维持、怎么过期、登录和改密码怎么防爆破。写于 2026-11-05，描述现状。

账号功能本身的待办（注册、强制改密码、停用账号、审计表）归 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)；会话过期之后页面上的表现（原地态、警示条、就地重登录）归 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)；密码规则和控制台归 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)。代码主要在 [server/src/server/app.py](../server/src/server/app.py) 和 [server/src/server/ratelimit.py](../server/src/server/ratelimit.py)。

## cookie 生命周期

- 登录凭据存在名为 `login` 的 cookie 里：cookie 里放的是令牌原文，数据库 `login_token` 表存它的哈希（`token_hash`，唯一索引）。cookie 是 `httponly` + `samesite=lax`。
- **滑动 7 天**：每个带 cookie 的请求（`/api/status` 除外）都把有效期续到 7 天后（`_COOKIE_MAX_AGE`），同时重发一次 cookie。
- **没有绝对上限**：维护者拍板否掉了「30 天绝对会话上限」的调研方案——与主流产品的登录态一致：不退出登录、不换浏览器设备，就可以长期用（拍板记录见 [improvement-research/backend-infra.md](improvement-research/backend-infra.md) 第 4 条注记）。配套前提记录在案：公网上线时 HTTPS + Secure cookie 是必要条件；对失窃 cookie 的补救靠现有吊销路径（改密码、控制台重置都会让令牌全部失效，见「吊销路径」）。
- **部署日待办**：cookie 现在没有 `Secure` 标志（本机 http 开发要用），名字也没有 `__Host-` 前缀；上 TLS 时要把这两项做成配置开关同批切换（调研 backend-infra 第 2、27 条，未实现，留部署日）。
- 控制台那一边是独立的 `admin_login` cookie：聊天页拿不到它，控制台也不认 `login`。两边的登录互不通用，role 判定在 `_account_from_cookie` 那一层（聊天接口只认 `chat`，`/api/admin/*` 只认 `admin`）。

## 令牌表与定时清扫

`login_token` 表（[server/src/server/db/models.py](../server/src/server/db/models.py) 的 `LoginToken`）：`account_id`、`token_hash`（唯一）、`created_at`、`expires_at`。

- **`expires_at` 有索引**（`ix_login_token_expires_at`）：清扫的 `DELETE ... WHERE expires_at <= now()` 和续期的 `WHERE expires_at > now()` 都吃它。索引在两处声明且保持一致：模型 metadata（`create_all` 引导的新库建出来）和迁移 0001（`CREATE INDEX IF NOT EXISTS`，老库跑迁移建出来），谁先跑都不冲突。
- **清扫不再挂在请求路径上**：原来每个带令牌的请求都全表扫一遍 `DELETE`；现在是 lifespan 里的定时任务（`_sweep_expired_tokens_loop`）——启动立刻跑一次，之后每 600 秒一次。失败只记一条警告、不掐循环，数据库恢复后下一轮补上。单进程前提（见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「单进程前提」），不需要分布式锁。
- **迁移路径**：alembic 已落地——`server/alembic.ini` + `server/migrations/`，`migrations/env.py` 复用应用自己的 `get_engine()` 拿数据库 URL（不在 alembic.ini 里另配密钥）；建表引导仍走 `create_all`（`uv run python -m server.db.init`）。**此后表结构变更（加列、加索引、改约束）一律写新的迁移文件**，不再往 init.py 里加手写字段补丁。规矩全文见 [server/AGENTS.md](../server/AGENTS.md)「迁移」一节。

## 每请求的成本：一条语句 + 请求态复用

带 cookie 的请求（`/api/status` 除外）经过中间件 `_RefreshLoginCookie`：

1. **校验 + 续期合成单条 SQL**（`_renew_login_token`）：`UPDATE login_token SET expires_at = 新期限 WHERE token_hash = ... AND expires_at > now() RETURNING account_id`——命中即有效且已续期，一次往返替代原来的 SELECT + UPDATE 两趟。`synchronize_session=False`：会话里不挂着 LoginToken 对象，省掉 auto 策略先做的那次 SELECT。令牌不存在或已过期都返回 None，401 的语义留在调用方。
2. **同步查库放线程里**：中间件是 async 的，psycopg 是同步的，这一步走 `asyncio.to_thread`，不堵事件循环（FINDINGS 2026-10-31「异步接口里的同步数据库调用会卡住事件循环」那条，中间件这半边当时漏了，现在补上了）。
3. **查询结果经请求态复用**：中间件把验好的账号 id（连同 cookie 原文用于比对）放进 contextvar（`_REQUEST_ACCOUNT`），每个请求入口先重置再写，绝不串上一个请求。端点侧的 `_account_from_cookie` 先看这份缓存（`_cached_account`），命中就只做一次按主键的取行拿活 ORM 对象——每个带 cookie 的请求从两轮查库减到一轮。`asyncio.to_thread` 和端点线程池都会拷贝上下文，同步、异步端点都读得到。
- **头像大字段不跟着跑**：`Account.avatar`（几十 KB 的 bytea）是列级延迟加载（`deferred`，[server/src/server/db/models.py](../server/src/server/db/models.py)），认证和列表请求不背着它；真正读头像的端点才多一次按主键的 SELECT。

本机实测的历史数据（2026-11-02，改造前）：每请求查令牌 + 续期中位 0.53 毫秒、清扫中位 0.31 毫秒——代价本来不大，改造防的是令牌表行数涨上去之后的线性变坏和事件循环卡顿。

## 401 带原因

会话类 401（带了 cookie 但令牌不认识/已过期/被吊销）的响应体在 `detail` 之外多带一个 `reason` 字段：

```json
{"detail": "未登录", "reason": "expired"}
```

- 实现是 `_SessionUnauthorized` 异常 + 专属异常处理器（比 HTTPException 的处理器更具体，按 MRO 优先分派）。加字段是向后兼容的：老前端只读 `detail`，不受影响。
- **词表两个**：`expired`（令牌不认识/已过期/被吊销——无法也无需细分，`login_token` 没有 `revoked_at` 列）；`disabled`（账号被停用——`account.disabled` 列还没建，后端暂时发不出这个值，前端已按词表接好，列建好即通）。词表来源是 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「会话状态通道」的最小 HTTP 版。
- **不带 reason 的 401**：登录端点密码不对的 401（那是表单错误，不是会话过期，前端走表单错误路径）；没带 cookie 的匿名请求（维持现状）。退出登录时令牌已死的 401 也带 `reason: expired`（退出也是会话过期语义）。
- **前端**：auth 是 ready 时收到带 reason 的 401 → 进「会话过期原地态」（页面状态全保留、警示条、就地重登录，行为和恢复流程见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）；不带 reason → 保守回退旧的整页登录路径；checking/anonymous 阶段的 401 照旧走整页登录屏。
- `/api/events` 推送通道（服务器主动推「你被踢了」）仍未做，是 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md) 里的 backlog：现在只能靠「下一次请求吃 401」发现。

## 限流

登录（`/api/login`、`/api/admin/login`）和改密码（`/api/password`）都接上了现成的 [server/src/server/ratelimit.py](../server/src/server/ratelimit.py)（Redis 计数）。

- **两个维度，各自锁各自的**：账号维度 + 来源 IP 维度。任何一个满了就 429「尝试次数太多，请 15 分钟后再试」。
- **参数**：窗口 15 分钟、5 次（`WINDOW_SECONDS` / `MAX_FAILURES`），第一次失败起算窗口、后续不续期。锁定期间连密码哈希都不碰（argon2 是 CPU 活）——先查锁定再进验证。
- **账号维度的标识**：登录用**归一化用户名**（`strip().lower()`）——库里 `admin`、`Admin`、`"admin "` 是三个账号，限流键照原文用的话换个写法就把计数摊开，锁定形同虚设；改密用账号 id。两边的账号计数碰不到一起。
- **IP 维度是共用的**：登录和改密合用同一个 IP 桶（scope `password:ip`），标识是 `request.client.host`。**维护者知情**：学校 NAT 场景下一个出口 IP 后面是一整批人，5 次/15 分钟的阈值会互相牵连（调研 backend-infra 第 3 条）。**反代后会升级成全员同桶**：uvicorn 现在不信任代理头（未开 `proxy_headers`），按仓内部署指南的「回环绑定 + nginx 前置」形态，所有用户 IP 都是 127.0.0.1——任何一人连错 5 次，15 分钟内**所有人**的登录与改密都吃 429（被动拒绝服务；429 目前也不带 `Retry-After`）。部署日必须处理：uvicorn `proxy_headers` + 信任 nginx 的 `X-Forwarded-For`（或把限流挪到 nginx 层），并给 429 补 `Retry-After`。
- **计数语义**：登录只数 401——「查无此人」和「密码不对」是同一句 401、计数也不分这两种，不然「试几次以后是不是 429」会把用户名存不存在漏出去（防用户名枚举）；403（密码对了但 role 不属于这一边）说明密码已经验对，不记。成功登录清账号维度的计数，IP 维度的让它自然过期（同一个 IP 上还有别的账号在正常登录，不该跟着被清）。
- **键空间**：`h2botapp-chat:ratelimit:{scope}:{identifier}`。前缀必须是 `h2botapp-chat:`——部署的 Redis ACL 只放行这一个前缀，别的前缀会静默失效（[FINDINGS.md](FINDINGS.md) 2026-11-02 那条）。计数键用 `SET NX + EX` 原子建键再 `INCR`，不会留下永不过期的计数。
- **Redis 挂时放行**：计数是加固手段不是业务数据，Redis 不通就放行并记一条警告——不能因为 Redis 挂了让人登不了、改不了密码。

## 吊销路径

三条路都会让令牌失效，页面在下一次请求时收到带 `reason: expired` 的 401，进会话过期原地态（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）：

- **改密码**（`/api/password`）：写新哈希和吊销令牌在同一个事务里（`DELETE` 该账号全部 `login_token`），不留「密码改了、旧令牌还活着」的缝；所有设备都踢，含当前这一台；两个 cookie 都清掉。
- **控制台重置**（`/api/admin/accounts/reset-password`）：同样一个事务里改哈希 + 删该账号全部令牌，对任何账号可用（含管理员自己）。
- **退出登录**：一条 `DELETE ... RETURNING` 删掉当前这个还没过期的令牌（过期的行交给定时清扫）。

## 已知限制

- **`disabled` 这个 reason 暂时发不出**：`account.disabled` 列还没建（[ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「数据库要加的」）。前端已按词表接好（红色终态提示、不给登录按钮），列建好、后端接上即通。
- **`login_token` 没有 `revoked_at` 列**：服务器分不清「令牌不认识 / 被撤销 / 账号被停用」，会话类 401 一律 `expired`。列是 ACCOUNT_MANAGEMENT 的待办。
- **IP 桶与改密路径共用**：学校 NAT 出口一批人共用一个 IP，互相牵连锁定（见「限流」一节，维护者知情）。
- **cookie 无绝对上限**：被窃的 cookie 只要持续使用就一直续期；补救靠吊销路径，部署日必须配 HTTPS + Secure cookie。
- **多标签页登录态不同步**：一个标签页退出/改密，另一个要等下一次请求吃 401 才知道。等 `/api/events` 推送通道（backlog）。
- **`/password` 页提交吃到 401 时没有可见反馈**：会话过期原地态的提示到不了那个独立页面（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)「已知限制」）。
