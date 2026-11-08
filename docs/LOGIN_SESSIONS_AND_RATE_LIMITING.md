# 登录态、令牌与限流

登录态怎么维持、怎么过期、登录和改密码怎么防暴力破解。写于 2026-11-05，描述现状。

账号功能本身的待办（注册、强制改密码、停用账号、审计表）归 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)；会话过期之后页面上的表现（留在原页面的过期状态、警示条、在原页面重新登录）归 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)；密码规则和控制台归 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)。代码主要在 [server/src/server/app.py](../server/src/server/app.py) 和 [server/src/server/ratelimit.py](../server/src/server/ratelimit.py)。

## cookie 生命周期

- 登录凭据存在名为 `login` 的 cookie 里：cookie 里放的是令牌原文，数据库 `login_token` 表存它的哈希（`token_hash`，唯一索引）。cookie 是 `httponly` + `samesite=lax`。
- **滑动 7 天**：每个带 cookie 的请求（`/api/status` 除外）都把有效期续到 7 天后（`COOKIE_MAX_AGE`，[server/src/server/security/cookies.py](../server/src/server/security/cookies.py)），同时重发一次 cookie。
- **没有绝对上限**：维护者决定否掉了「30 天绝对会话上限」的调研方案——与主流产品的登录态一致：不退出登录、不换浏览器设备，就可以长期用（决定记录见 [improvement-research/backend-infra.md](improvement-research/backend-infra.md) 第 4 条注记）。配套前提记录在案：公网上线时 HTTPS + Secure cookie 是必要条件；对失窃 cookie 的补救靠现有吊销路径（改密码、控制台重置都会让令牌全部失效，见「吊销路径」）。
- **部署日待办**：cookie 现在没有 `Secure` 标志（本机 http 开发要用），名字也没有 `__Host-` 前缀；上 TLS 时要把这两项做成配置开关同批切换（调研 backend-infra 第 2、27 条，未实现，留部署日）。
- 控制台那一边是独立的 `admin_login` cookie：聊天页拿不到它，控制台也不认 `login`。两边的登录互不通用，role 判定在 `account_from_cookie` 那一层（聊天接口只认 `chat`，`/api/admin/*` 只认 `admin`）。

## 令牌表与定时清扫

`login_token` 表（[server/src/server/db/models.py](../server/src/server/db/models.py) 的 `LoginToken`）：`account_id`、`token_hash`（唯一）、`created_at`、`expires_at`。

- **`expires_at` 有索引**（`ix_login_token_expires_at`）：清扫的 `DELETE ... WHERE expires_at <= now()` 和续期的 `WHERE expires_at > now()` 都用它。索引在两处声明且保持一致：模型 metadata（`create_all` 引导的新数据库建出来）和迁移 0001（`CREATE INDEX IF NOT EXISTS`，老数据库跑迁移建出来），谁先跑都不冲突。
- **清扫不再挂在请求路径上**：原来每个带令牌的请求都全表扫一遍 `DELETE`；现在是 lifespan 里的定时任务（`sweep_expired_tokens_loop`）——启动立刻跑一次，之后每 600 秒一次。失败只记一条警告、不中止循环，数据库恢复后下一轮补上。单进程前提（见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「单进程前提」），不需要分布式锁。2026-11-06 起清扫语句带 `RETURNING account_id`：被扫掉令牌的账号会收到 `/api/events` 推送（reason `expired`，见「推送通道」一节）。
- **迁移路径**：alembic 已实施——`server/alembic.ini` + `server/migrations/`，`migrations/env.py` 复用应用自己的 `get_engine()` 拿数据库 URL（不在 alembic.ini 里另配密钥）；建表引导仍走 `create_all`（`uv run python -m server.db.init`）。**此后表结构变更（加列、加索引、改约束）一律写新的迁移文件**，不再往 init.py 里加手写字段补丁。规矩全文见 [server/AGENTS.md](../server/AGENTS.md)「迁移」一节。

## 每请求的成本：一条语句 + 请求态复用

带 cookie 的请求（`/api/status` 除外）经过中间件 `RefreshLoginCookie`（[server/src/server/middleware.py](../server/src/server/middleware.py)）：

1. **校验 + 续期合成单条 SQL**（`renew_login_token`，[server/src/server/security/tokens.py](../server/src/server/security/tokens.py)）：`UPDATE login_token SET expires_at = 新期限 WHERE token_hash = ... AND expires_at > now() AND account_id = account.id RETURNING account_id, must_change_password`——命中即有效且已续期，2026-11-06 起还顺带带回账号的「必须改密」标记（PostgreSQL 渲染成 UPDATE … FROM account，仍是一次往返），一次往返替代原来的 SELECT + UPDATE 两趟。`synchronize_session=False`：会话里不挂着 LoginToken 对象，省掉 auto 策略先做的那次 SELECT。令牌不存在或已过期都返回 None，401 的语义留在调用方。
2. **同步查数据库放线程里**：中间件是 async 的，psycopg 是同步的，这一步走 `asyncio.to_thread`，不堵事件循环（FINDINGS 2026-10-31「异步接口里的同步数据库调用会卡住事件循环」那条，中间件这半边当时漏了，现在补上了）。
3. **查询结果经请求态复用**：中间件把验好的账号（cookie 原文用于比对、账号 id、必须改密标记，三元组；2026-11-06 起）放进 contextvar（`REQUEST_ACCOUNT`，[server/src/server/security/context.py](../server/src/server/security/context.py)），每个请求入口先重置再写，绝不混上一个请求。端点侧的 `account_from_cookie`（[server/src/server/security/accounts.py](../server/src/server/security/accounts.py)）先看这份缓存（`_cached_account`，仍是模块内私有），命中就只做一次按主键的取行，拿到可用的 ORM 对象——每个带 cookie 的请求从两轮查数据库减到一轮。`asyncio.to_thread` 和端点线程池都会拷贝上下文，同步、异步端点都读得到。
- **头像大字段不跟着跑**：`Account.avatar`（几十 KB 的 bytea）是列级延迟加载（`deferred`，[server/src/server/db/models.py](../server/src/server/db/models.py)），认证和列表请求不背着它；真正读头像的端点才多一次按主键的 SELECT。

本机实测的历史数据（2026-11-02，改造前）：每请求查令牌 + 续期中位 0.53 毫秒、清扫中位 0.31 毫秒——代价本来不大，改造防的是令牌表行数涨上去之后的线性变坏和事件循环卡顿。

## 401 带原因

会话类 401（带了 cookie 但令牌不认识/已过期/被吊销）的响应体在 `detail` 之外多带一个 `reason` 字段：

```json
{"detail": "未登录", "reason": "expired"}
```

- 实现是 `SessionUnauthorized` 异常 + 专属异常处理器（比 HTTPException 的处理器更具体，按 MRO 优先分派）。加字段是向后兼容的：老前端只读 `detail`，不受影响。
- **词表两个**：`expired`（令牌不认识/已过期/被吊销——无法也无需细分，`login_token` 没有 `revoked_at` 列）；`disabled`（账号被停用——`account.disabled` 列还没建，后端暂时发不出这个值，前端已按词表接好，列建好即通）。词表来源是 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「会话状态通道」的最小 HTTP 版。
- **不带 reason 的 401**：登录端点密码不对的 401（那是表单错误，不是会话过期，前端走表单错误路径）；没带 cookie 的匿名请求（维持现状）。退出登录时令牌已失效的 401 也带 `reason: expired`（退出也是会话过期语义）。
- **前端**：auth 是 ready 时收到带 reason 的 401 → 进「会话过期后留在原页面的状态」（页面状态全保留、警示条、在原页面重新登录，行为和恢复流程见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）；不带 reason → 保守回退旧的整页登录路径；checking/anonymous 阶段的 401 照旧走整页登录屏。
- `/api/events` 推送通道（服务器主动推「你已被强制下线」）仍未做，是 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md) 里的 backlog：现在只能靠「下一次请求收到 401」发现。

## 限流

登录（`/api/login`、`/api/admin/login`）和改密码（`/api/password`）都接上了现成的 [server/src/server/ratelimit.py](../server/src/server/ratelimit.py)（Redis 计数）。

- **两个维度，各自锁各自的**：账号维度 + 来源 IP 维度。任何一个满了就 429「尝试次数太多，请 15 分钟后再试」。
- **参数**：窗口 15 分钟、5 次（`WINDOW_SECONDS` / `MAX_FAILURES`），第一次失败起算窗口、后续不续期。锁定期间连密码哈希都不碰（argon2 很耗 CPU）——先查锁定再进验证。
- **账号维度的标识**：登录用**归一化用户名**（`strip().lower()`）——数据库里 `admin`、`Admin`、`"admin "` 是三个账号，限流键照原文用的话换个写法就把计数摊开，锁定形同虚设；改密用账号 id。两边的账号计数碰不到一起。
- **IP 维度是共用的**：登录和改密合用同一个 IP 桶（scope `password:ip`），标识是 `request.client.host`。**维护者知情**：学校 NAT 场景下一个出口 IP 后面是一整批人，5 次/15 分钟的阈值会互相牵连（调研 backend-infra 第 3 条）。**反向代理下的信任边界是隐含前提，不是显式配置**：本仓 uvicorn 走默认的 `proxy_headers=True`，`forwarded_allow_ips` 默认只信回环地址；部署指南的「回环绑定 + nginx 前置」形态里，nginx 同机反向代理恰好在信任范围内，`request.client.host` 拿到的是 `X-Forwarded-For` 里的真实客户端 IP——「所有用户共用 127.0.0.1 一个桶」在默认部署下不成立，IP 维度真实剩余的误伤风险就是上面维护者知情的学校 NAT 共享出口 IP 场景。但这条链路完全建立在两个代码里没有写明的前提上（只听回环、前面必是正确设置 `X-Forwarded-For` 的 nginx）：谁把监听地址改成所有网卡，`X-Forwarded-For` 就成了客户端可伪造的头，IP 限流直接失效；哪层代理没设这个头，所有用户又会共享 nginx 的回环 IP（事实与方案详见调研 backend-infra 第 11 条）。429 目前不带 `Retry-After`。部署日必须处理：把隐含的信任边界写成显式配置（backend-infra 第 11 条的方案：`uvicorn.run` 里显式声明、启动脚本和部署文档写明、限流处发现回环地址时记一条警告），并给 429 补 `Retry-After`。
- **计数语义**：登录只数 401——「查无此人」和「密码不对」是同一句 401、计数也不分这两种，不然「试几次以后是不是 429」会把用户名存不存在漏出去（防用户名枚举）；403（密码对了但 role 不属于这一边）说明密码已经验对，不记。成功登录清账号维度的计数，IP 维度的让它自然过期（同一个 IP 上还有别的账号在正常登录，不该跟着被清）。
- **键空间**：`h2botapp-chat:ratelimit:{scope}:{identifier}`。前缀必须是 `h2botapp-chat:`——部署的 Redis ACL 只放行这一个前缀，别的前缀会静默失效（[FINDINGS.md](FINDINGS.md) 2026-11-02 那条）。计数键用 `SET NX + EX` 原子建键再 `INCR`，不会留下永不过期的计数。
- **Redis 不通时放行**：计数是加固手段不是业务数据，Redis 不通就放行并记一条警告——不能因为 Redis 不通让人登不了、改不了密码。

## 吊销路径

三条路都会让令牌失效，页面在下一次请求时收到带 `reason: expired` 的 401，进入会话过期后留在原页面的状态（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）：

- **改密码**（`/api/password`）：写新哈希和吊销令牌在同一个事务里（`DELETE` 该账号全部 `login_token`），不留「密码改了、旧令牌仍有效」的缝；所有设备都强制下线，含当前这一台；两个 cookie 都清掉。同时给该账号所有在线页面推 `password_changed`（见「推送通道」一节），并清掉「必须改密」标记（见下一节）。
- **控制台重置**（`/api/admin/accounts/reset-password`）：同样一个事务里改哈希 + 删该账号全部令牌，对任何账号可用（含管理员自己）；同时给目标账号打上「必须改密」标记（见下一节）并推 `admin_reset`（见「推送通道」一节）。
- **退出登录**：一条 `DELETE ... RETURNING` 删掉当前这个还没过期的令牌（过期的行交给定时清扫）。退出不走推送：用户自己的动作，发起页自己知道；跨标签页的退出感知由前端的 localStorage 标记负责（见「已知限制」）。

## 必须改密标记

密码来自别人手的账号，首次登录必须自己设一个。`account.must_change_password` 布尔列（迁移 0002，存量行默认假、不追溯）做标记，三个地方动它：

- 初始化脚本创建的预设账号（`test01`、控制台预设 `admin`）创建时打上标记——预设口令只是入场券，进场就得换。预设口令本身豁免密码政策（[ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md) 记录的既有决定），标记把它的暴露窗口压到首次改密之前。
- 控制台「重置密码」给目标账号打上标记：与写哈希、吊销令牌同一个事务（重置密码是 10 位随机字母数字、同样豁免政策，管理员看过，必须由本人换掉）。
- 本人在 `/api/password` 改密成功时清除标记（同事务）。

**服务端强制**：cookie 校验的续期语句顺带带回标记（见「每请求的成本」一节，不加数据库查询），中间件（`middleware.py`）对标记账号请求 `/api/` 且不在豁免集的路径直接回 403：`{"detail": "请先修改密码，然后才能继续使用", "code": "must_change_password"}`，不进端点。豁免集：`/api/login`（重新登录不拦，响应里带标记）、`/api/password`（改密本身）、`/api/logout`、`/api/profile`、`/api/status`、`/api/avatar`、`/api/events`（推送通道，只读）。非 `/api` 路径（静态资源）不受影响。

**契约**：`LoginResponse` 和 `ProfileResponse` 都带 `must_change_password` 布尔字段（snake_case，与两个模型的既有字段同约定，无别名）。前端已实现（2026-11-06）：登录或页面恢复时标记为真就强制进入修改密码拦截——只渲染强制改密页、路径守卫把地址按在 `/force-change-pwd`（2026-11-08 与自助改密的 `/change-pwd` 拆成两条 URL：守卫记下来路——只记 `/chat/:id`——改密成功或放弃登录都回那里就地重新登录；claimPath 不再认领任何密码地址，登录后一律归位根路径——旧版认领 `/password` 正是「改完密又弹回改密页」死循环的根），不改完不放行；被标记的登录不算登录成功，服务器发的只是一条能到豁免集的受限会话，强制页的「放弃本次登录」即放弃这次登录——尽力作废该会话、回登录页，标记不清除、下次登录仍被拦（2026-11-07 补上，此前拦截页没有出口）；拦截期间登录态被判死（推送失效帧、提交收到 401）时直接带文案回登录页、不静默吞掉（2026-11-08 修正，此前会把人困在闸门里毫无反应）；任何业务请求收到 403（code `must_change_password`）也经全局保底事件进入同一拦截。改密成功后服务器在同一事务里吊销全部令牌并清 cookie：页面先就地亮「密码已修改，请用新密码重新登录」，再回来路就地登录（收尾不走 enterLoginGuarded——那道守卫会吞掉成功路径）。实现在 `src/App.tsx` 的拦截分支与 `src/hooks/use-auth-flow.ts` 的路径守卫、`src/session/password-return.ts` 的来路记忆、`src/api/http.ts` 的保底事件、`src/components/settings/ChangePasswordPage.tsx` 的强制模式。

**永久决定（2026-11-06）**：服务器端不对控制台（`/api/admin/*`）一侧做强制改密，这是最终决定，不是等入口补上的过渡状态（维护者原话「服务器不做那么细」；当初的顾虑是控制台没有「改自己密码」的入口，强制会把管理员锁死在控制台外）。控制台重置打上的标记照旧在聊天侧生效。控制台的自助改密入口（前端另一批在做）只为管理员方便，不与强制联动。

## 推送通道 `/api/events`

服务器侧的登录态失效，原来页面要等下一次请求收到 401 才知道；现在直接推给该账号所有开着的页面。2026-11-06 后端实施完成（进程内总线 `pushbus.py` ＋ `routes/events.py`），**前端已于同日接上**（`src/session/push-channel.ts` ＋ `src/hooks/use-auth-flow.ts` 接线：登录后建连，失效帧进入与带 reason 的 401 同一套留在原页面的过期状态，重新登录后新建连接、不做手动重连；设计脉络见 [ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「会话状态通道」）。

- **建立连接**：登录后 `new EventSource("/api/events")`，同源自动带 cookie，不需要也不能另设请求头。每个标签页各挂一条。未登录 401；控制台的 admin cookie 不认这条通道（也是 401）；admin 角色走聊天侧登录态来连回 403。本端点在「必须改密」豁免集里。
- **帧**：命名事件 `state`。连上第一帧一定送达 `data: {"valid":true,"account":"<用户名>"}`——断线重连成功后也先收到它，状态天然补齐，前端不用另写补状态逻辑。登录态失效时推 `data: {"valid":false,"reason":"…","message":"…"}`，随后服务器主动结束这条流。心跳是 15 秒一帧的 `: ping` 注释帧（EventSource 自动忽略）。帧风格与聊天流一致（紧凑分隔符、不转义非 ASCII），响应头同一份（no-store ＋ X-Accel-Buffering: no）。
- **reason 词表**：`expired`（定时清扫扫掉过期令牌）／`password_changed`（本账号改密，全设备下线）／`admin_reset`（控制台重置了密码）。与会话类 401 的 reason 同词源（`expired` 同词），两套词表可当一套用；不认识的 reason 也按失效处理。`disabled` 暂不在词表（`account.disabled` 列没建，与 401 侧同一缺口）。
- **收到 valid:false 之后**：前端应进「会话过期后留在原页面的状态」（与收到带 reason 的 401 同一套行为：会话、消息、草稿在原页面保留，输入区禁用、挂常驻警示条；文案可用帧里的 `message`，或按 reason 自配）。EventSource 随后自动重连会收到 401（cookie 已失效）并彻底停止重试——这是预期，**重新登录成功后新建一条连接**，不要依赖旧连接重连，也不要手动无限重连。
- **多标签页**：改密/重置推给该账号全部连接，触发操作的那个标签页也会收到（服务器不区分发起者，触发页表现可以从轻）。退出登录不推送（见「吊销路径」）。
- **部署边界**：总线是进程内存（账号 → 订阅队列组），依赖单进程硬性规定（server/AGENTS.md「边界」）；多进程部署前必须先换成跨进程通道。队列有界（32），满了丢帧记 debug；关停哨兵一定送达。

## 人机验证（Turnstile）

两个登录接口（`/api/login`、`/api/admin/login`）在执行既有逻辑之前先过一道 Cloudflare Turnstile 人机验证。登录表单平时不渲染 widget——点「登录」才现渲染（显式渲染，sitekey 是公开信息，写在前端 `src/hooks/use-turnstile.ts`），验证通过后立即带一次性令牌提交登录，令牌放在请求体的 `cf-turnstile-response` 字段里；点击到出结果之间登录按钮持续禁用并转圈，每一段都有终点（等脚本上限 10 秒、挑战超时由 widget 回调兜底、登录请求 15 秒超时）；服务端 [server/src/server/turnstile.py](../server/src/server/turnstile.py) 拿密钥调 siteverify，三件事全对才放行：`success` 为真、`action` 与接口的约定值一致（`login` / `admin_login`）、`hostname` 在 `TURNSTILE_HOSTNAMES` 允许名单里。任何一项不对、配置缺失，或者 siteverify 本身调用失败，一律 403（宁可挡住不放开），detail 是「人机验证未通过，请确认后重试」。

- **位置**：门槛在锁定检查和密码验证之前——没过人机验证的登录尝试不碰数据库、不碰 argon2，也不计入限流的失败计数。
- **令牌一次性**：siteverify 兑换一次即作废。因此 widget 从不复用：验证没通过或服务器拒绝（密码不对等）时现场原地保留、登录按钮锁住，直到用户改动用户名或密码——widget 随之移除、按钮解锁，再点「登录」渲染全新 widget 跑新一轮验证；连不上服务器不锁按钮，再点一次直接就是新一轮。
- **配置**：`.env` 的 `TURNSTILE_SECRET`（Cloudflare 控制台 widget 详情页的 Secret Key，只在服务端，绝不进前端）和 `TURNSTILE_HOSTNAMES`（siteverify 返回的前端主机名允许名单，逗号分隔；开发用 `localhost`，部署时换成真实域名，不得包含 localhost / 127.0.0.1）。widget 在 Cloudflare 控制台登记的前端域名必须覆盖实际访问的主机名：没登记时浏览器端 widget 直接报错，表单按验证失败处理（按钮锁住，改动用户名或密码解锁）。
- **其他接口不设门槛**：发消息、改密码、控制台操作都有登录 cookie 保护，不在人机验证范围内。

## 已知限制

- **`disabled` 这个 reason 暂时发不出**：`account.disabled` 列还没建（[ACCOUNT_MANAGEMENT.md](ACCOUNT_MANAGEMENT.md)「数据库要加的」）。前端已按词表接好（红色终态提示、不给登录按钮），列建好、后端接上即通。
- **`login_token` 没有 `revoked_at` 列**：服务器分不清「令牌不认识 / 被撤销 / 账号被停用」，会话类 401 一律 `expired`。列是 ACCOUNT_MANAGEMENT 的待办。
- **IP 桶与改密路径共用**：学校 NAT 出口一批人共用一个 IP，互相牵连锁定（见「限流」一节，维护者知情）。
- **cookie 无绝对上限**：被窃的 cookie 只要持续使用就一直续期；补救靠吊销路径，部署日必须配 HTTPS + Secure cookie。
- **多标签页登录态（原「不同步」限制，2026-11-06 已关闭）**：前端「主动退出」跨标签页联动：`signOut` 写 localStorage 标记 `h2bot-logout`，其他标签页听到 storage 事件立即回登录界面、并各自清掉自己的草稿。服务器侧失效（改密、控制台重置、令牌过期）：`/api/events` 推送通道前端接上后实时推到所有开着的标签页、进入留在原页面的过期状态，不再等下一次请求的 401（401 仍作保底）。机制见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)「多标签页同步」。
- **改密页提交的反馈（原限制，2026-11-08 重做关闭）**：按钮点击即禁用加转圈；成功就地亮「密码已修改」横幅再收尾跳登录；401 的表单错误按 reason 映射成「会话已过期，请重新登录」，出口直通登录页（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)「已知限制」）。
