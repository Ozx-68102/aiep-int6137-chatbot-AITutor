# 后端基建改进调研：配置、安全、数据库、日志、部署运维

## 概览

**读了哪些文件**（全部在 `main` 上逐行读完，`.env` 按规矩没读，只读了 `.env.example`）：

- 规矩与文档：`/AGENTS.md`、`/server/AGENTS.md`、`/docs/TECH.md`、`/docs/NGINX_SPA_DEPLOYMENT_GUIDE.md`、`/docs/PARENT_PORTAL_PRIVACY.md`
- 后端基建代码：`/server/src/server/` 下的 `settings.py`、`passwords.py`、`log.py`、`avatar.py`、`ratelimit.py`、`reply_store.py`、`app.py`（全文 1375 行）、`fastgpt.py`、`chat_log.py`、`__init__.py`、`types/env.py`、`types/api.py`
- 数据库：`/server/src/server/db/` 全部 5 个文件（`__init__.py`、`session.py`、`models.py`、`init.py`、`backfill.py`）
- 配置与脚本：`/server/pyproject.toml`、`/server/.python-version`、`/.env.example`、`/.nvmrc`、`/package.json`、`/scripts/` 三个脚本、`/.githooks/` 两个钩子、`/.gitignore`

**基建现状**：

- **配置怎么进来**：根目录 `.env` → `types/env.py` 的 `Settings`（pydantic-settings）。`settings.py` 的 `load_settings()` 从源文件位置向上找「同时有 `.env.example` 和 `server/pyproject.toml` 的目录」定位仓库根，校验失败直接让进程起不来；`DEBUG=1` 时容忍 FastGPT 三项为空。配置在进程内缓存一份（`_cached`）。
- **数据存哪**：PostgreSQL（SQLAlchemy 2 同步 ORM + psycopg3），账号、会话、消息、登录令牌、头像字节全在库里；建表靠 `db/init.py` 的 `create_all` 加 5 个手写的「补列」函数，没有迁移工具。Redis 只存易失状态（半截回答、停止标记、限流计数），键都在 `h2botapp-chat:` 前缀下（ACL 限制），不通时一律「记警告、放行」降级。
- **日志怎么走**：`log.py` 自研 `_SizeLogFile` 写 `logs/server.log`，满 5MB 改名归档成带时间戳的文件，归档永不删除；文件 handler 同时挂到 root、`uvicorn`、`uvicorn.access`，终端另走 uvicorn 的彩色格式。日志里有用户提问全文和 FastGPT 上游原文（AGENTS.md 自己也这么写）。
- **怎么部署**：前端 `pnpm build` 出 `dist/`，nginx 做 SPA 回落 + `/api/` 反代（`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md`，默认 `listen 80`）；后端单进程 uvicorn 听 `127.0.0.1:3001`，`scripts/start-server.sh` 或 `uv run server` 前台拉起，没有进程守护、没有 CI、没有自动化测试（硬约束：不引入测试框架）。

**值得肯定、别在改造里弄坏的点**：`passwords.py` 用 argon2-cffi 默认参数（Argon2id，t=3、m=64MiB、p=4），强于 OWASP 建议下限，且有 `needs_rehash` 在登录成功时顺手升级旧哈希；登录令牌是 `secrets.token_urlsafe(32)`（256 位随机），库里只存 sha256 哈希；改密和管理员重置都在同一事务里吊销该账号全部令牌；头像上传做了格式白名单（PNG/JPEG/HEIF）、5MB 与 2000 万像素双上限、统一重编码成 PNG 并剥 EXIF；Redis 降级策略在 `reply_store.py` 和 `ratelimit.py` 里写法一致。没有 CORS 中间件是刻意设计（同源部署，AGENTS.md 明说），不建议加。

以下按四个维度编号，共 28 条。每条给位置、现状、影响、方案（关键处附草图）、第三方库、风险、工作量（S/M/L）。所有验证手段都遵守「不引入测试框架」：改完跑 `uv run ruff check .`、`uv run ruff format --check .`，核心链路手动过一遍。

---

## 安全加固

### 1. 登录接口没有防爆破，ratelimit 只接在改密端点上

- **位置**：`/server/src/server/app.py` 的 `login()`（`/api/login`）、`admin_login()`（`/api/admin/login`）；`/server/src/server/ratelimit.py`
- **现状**：`ratelimit.py` 的模块注释写着「登录、改密码的失败计数」，但 grep 全仓库确认 `is_locked` / `register_failure` / `clear_failures` 只被 `change_password` 调用（app.py 第 424、431、432 行附近）。`/api/login` 和 `/api/admin/login` 可以无限次尝试，注释与实现已经走偏。
- **影响**：对着 `admin/admin`、`test01/test01`（见第 5 条）和学生 6 位弱密码可以不限速爆破。而且每次尝试都让服务器跑一遍 argon2 verify（64MiB 内存、3 轮迭代），并发打过来本身就是拒绝服务向量——爆破者不猜中密码也能把 CPU 打满。
- **方案**：把现成的 `ratelimit` 接到两个登录端点上，复用 `_key()`（键自动落在 ACL 放行的 `h2botapp-chat:` 前缀下）。草图（以 `/api/login` 为例，`/api/admin/login` 同理）：

  ```python
  # login() 需要多收一个 request: Request 参数来取 client.host
  client_ip = request.client.host if request.client else "unknown"
  with db_session() as session:
      row = session.scalar(select(Account).where(Account.username == body.username))
  # 账号不存在也要有键可锁，不然可以用「不存在用户名」无限试
  ident = str(row.id) if isinstance(row, Account) else f"unknown:{body.username}"
  if is_locked("login", ident) or is_locked("login:ip", client_ip):
      raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, _RATE_LIMITED)
  try:
      with db_session() as session:
          result, token = _login_account(session, body.username, body.password)
  except HTTPException as exc:
      if exc.status_code == status.HTTP_401_UNAUTHORIZED:
          register_failure("login", ident)
          register_failure("login:ip", client_ip)
      raise
  clear_failures("login", ident)
  ```

- **第三方库**：无。现有 Redis 计数够用；slowapi 这类库引入的只是依赖面，不带来新能力。
- **风险**：Redis 挂掉时限流照既有哲学「放行」，登录短暂不设防——这是仓库已有的取舍，保持一致即可。IP 维度阈值见第 3 条，别照抄 5 次。
- **工作量**：S

### 2. login cookie 没有 Secure 标志，名字也没有 `__Host-` 前缀

> **2026-11-05 维护者拍板**：正式部署会是 HTTPS，但现在还没有任何部署（开发期是 HTTP 的 localhost）。本条整体（Secure、`__Host-` 前缀，连同 TLS 与 nginx 加固）挪到部署日专项一批做，做成配置开关（开发关、生产开）；开发期不动。

- **位置**：`app.py` 的 `_set_cookie()` / `_clear_cookie()`；`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md` 默认 `listen 80`
- **现状**：`response.set_cookie(key=name, value=token, max_age=7天, httponly=True, samesite="lax", path="/")`——grep 确认全文没有 `secure=True`。部署指南的默认配置是纯 HTTP。
- **影响**：HTTP 部署下，有效期 7 天的登录令牌明文过网，同一网络（学校 Wi-Fi 正是这种环境）可被嗅探重放。就算以后上了 HTTPS，没有 Secure 标志的 cookie 仍会跟着 HTTP 请求发出去（用户手输地址、页面里一个 http:// 链接就触发）。`__Host-` 前缀能让浏览器强制 secure + path=/ + 不带 domain，防 cookie tossing。
- **方案**：`Settings` 加一个 `cookie_secure: bool = False`（环境变量 `COOKIE_SECURE`），`_set_cookie` / `_clear_cookie` 都传 `secure=settings.cookie_secure`（注意 clear 必须和 set 属性一致，否则删不掉）。HTTPS 上线的同一批把 `COOKIE_SECURE=1` 打开；再往后可以择机把 cookie 改名 `__Host-login`（改名等于全员令牌作废一次，挑发版窗口做，前后端和 `server/AGENTS.md`「登录状态」一节同步改）。
- **第三方库**：无
- **风险**：在还是 HTTP 的环境误开 `secure=True`，浏览器直接不存 cookie，全员登录不上——所以开关默认关，与 TLS 同批启用（见第 26 条）。
- **工作量**：S

### 3. IP 维度限流阈值 5 次/15 分钟，在学校 NAT 出口会锁掉一整批人

- **位置**：`app.py` 的 `_RATELIMIT_IP_SCOPE = "password:ip"`；`ratelimit.py` 的 `MAX_FAILURES = 5`、`WINDOW_SECONDS = 15 * 60`
- **现状**：改密失败按「账号」和「来源 IP」两个维度各计 5 次、锁 15 分钟。目标用户是小三学生（`docs/PARENT_PORTAL_PRIVACY.md`），学校场景里一班甚至全校共用一个出口 IP。
- **影响**：五个学生输错旧密码，整个学校出口 IP 在 15 分钟内都改不了密码，表现是一句「尝试次数太多」，老师无从排查。这是很容易自然触发的可用性事故，不需要攻击者出场。
- **方案**：账号维度保持 5 次不动；IP 维度改成粗闸门（比如 50 次/15 分钟），或者把 IP 键改成 `ip + 账号 id` 组合（同一 IP 打不同账号互不牵连，仍能拦「一个 IP 扫一批账号」）。两个常量提升为 `Settings` 字段（`RATELIMIT_MAX_FAILURES`、`RATELIMIT_WINDOW_SECONDS`），部署方可按网络拓扑调。
- **第三方库**：无
- **风险**：放宽 IP 维度后，对「拿一批用户名在一个 IP 上各试几次」的喷洒攻击变弱——账号维度的 5 次锁仍在，兜得住主要风险；第 1 条给登录加上同维度计数后防护面更完整。
- **工作量**：S

### 4. 会话是纯滑动 7 天、无绝对上限；过期令牌清扫挂在每个请求上

> **2026-11-04 维护者拍板**：方案 (a)「30 天绝对会话上限」**不采纳**，维持纯滑动续期——与主流产品的登录态一致：不退出登录、不换浏览器设备，就可以长期用。方案 (b) 清扫定时化、(c) `expires_at` 索引与上限无关，照做。配套前提记录在案：公网上线时第 2 条的 HTTPS + Secure cookie 是必要条件；对失窃 cookie 的补救靠现有吊销路径（改密码、控制台重置、停用账号都会让令牌失效）。

- **位置**：`app.py` 的 `_RefreshLoginCookie` 中间件、`_login_token()`、`_sweep_expired_tokens()`；`db/models.py` 的 `LoginToken`
- **现状**：每个带 cookie 的请求都把 `expires_at` 续到 now+7 天（中间件里 `_cookie_is_valid` 续一次，端点里 `_login_token` 又续一次）；`_login_token` 和登录端点开头都调 `_sweep_expired_tokens()`，对 `login_token` 全表做 `DELETE ... WHERE expires_at <= now`，而 `models.py` 里 `expires_at` 没有索引。
- **影响**：a) 被窃的 cookie 只要持续使用就永不过期，没有「最长 30 天必须重新登录」这种绝对上限；b) 每个认证请求都带一次全表扫描 DELETE，是纯写放大，令牌行数涨起来后所有接口跟着变慢；c) 中间件+端点重复查询让 DB QPS 翻倍（详见第 15 条）。
- **方案**：a) `LoginToken` 加绝对寿命：续期时不超过 `created_at + 30 天`（`_login_deadline()` 改成 `min(now+7d, created_at+30d)`，不用加列）；b) `_sweep_expired_tokens` 从请求路径挪到 `_lifespan` 里的周期任务（`asyncio.create_task` 每 10 分钟跑一次，进程启动时先跑一次），请求路径不再扫表；c) 给 `expires_at` 加索引——按 `init.py` 现有「补列」风格加一个 `_ensure_login_token_expiry_index`，将来归 alembic 管（第 13 条）。
- **第三方库**：无
- **风险**：加了绝对上限后，天天用的学生每 30 天被要求重新登录一次——学校场景可接受，且和「重置通道存在」的既有前提一致。
- **工作量**：M

### 5. 初始口令 admin/admin、test01/test01 写死在 init.py，且豁免密码策略

- **位置**：`/server/src/server/db/init.py`（`_INITIAL_USERNAME/_INITIAL_PASSWORD`、`_CONSOLE_USERNAME/_CONSOLE_PASSWORD`）
- **现状**：跑一遍 `uv run python -m server.db.init` 就建出两个密码人尽皆知的账号；`docs/PARENT_PORTAL_PRIVACY.md` 把 `must_change_password`（首次登录强制改密）列为「远期、未排期」。
- **影响**：部署后只要没人手动改密，控制台等于不设防；叠加第 1 条（登录无限速），这是全仓库最现实的入侵路径。admin 账号能列全部账号、给任何人重置密码。
- **方案**：分两步走。短期（本批可做）：init 建号时改用现成的 `generate_password(12)` 生成随机初始密码，**只在 init 的标准输出里打一次**，同时保留 `--keep-defaults` 之类的显式旗标给本地开发用；部署文档加「装完立刻用打印出来的密码登录并改掉」步骤。中期：把远期清单里的 `must_change_password` 提上来，作为学生弱密码方案（6 位起）的配套——隐私文档自己写了「放宽的前提是重置通道存在」，同理初始口令豁免的前提应该是强制改密存在。
- **第三方库**：无
- **风险**：随机初始密码让「学校统一发号」多一步抄写；`generate_password` 只用字母数字正是为此设计的，成本可控。改 init.py 行为属于「动真实数据」边缘，落地前按 AGENTS.md 规矩先向维护者说明。
- **工作量**：S

### 6. 请求体没有长度上限：message、password 字段可以无限长

- **位置**：`/server/src/server/types/api.py`：`ChatRequest.message`（只有 `min_length=1`）、`LoginRequest.password`（只有 `min_length=1`）、`PasswordChange` 三个字段（完全无限制）
- **现状**：模型层只设下限。改密的 128 上限在端点里、由 `check_password_policy` 检查——但那发生在 `verify_password(account.password_hash, body.old_password)` **之后**，旧密码是任意长度先被 argon2 消化一遍。`message` 则一路透传给 FastGPT 和 Redis（`append` 进半截文字键）、PostgreSQL（`message.text`）。
- **影响**：超长正文浪费带宽、内存和 CPU；配合第 1 条（登录不限速），「发一个 10MB 的 password 字段」是廉价的资源攻击。消息无上限也让 `chat_message.text` 和 Redis 里的半截文字没有可预算的大小。
- **方案**：模型层加 `max_length`：`LoginRequest.password` 和 `PasswordChange` 三字段设 128（和 `_MAX_LENGTH` 对齐，超长直接 422，进不了 argon2）；`ChatRequest.message` 设一个产品上限（比如 8000 字符——先查 `src/` 前端输入框有没有限制，两端对齐，别后端先砍）。`.env.example` 不用动。
- **第三方库**：无
- **风险**：message 上限设小了会截正常长提问；以前端现状为准，前端没限就一起加。
- **工作量**：S

### 7. 日志记录用户提问全文与上游原文，且归档无限期保留（PII / PDPO）

- **位置**：`app.py` 的 `chat()`（`logger.info("对话请求 %s", body.model_dump_json(...))`）、`_relay()`（`"发给页面 %s"` 逐块记）、`fastgpt.py`（`"FastGPT 请求 %s"` 全 payload、`"FastGPT 上游 %s"` 每行 SSE）；`log.py`（归档只增不删）
- **现状**：这几处代码注释自己写着「排查流式输出用，确认后再收窄」——排查用的日志成了常驻。`logs/server.log` 和所有 `server-<时间戳>.log` 归档合起来就是全部学生提问和 AI 回答的明文副本，没有任何保留期限。`docs/PARENT_PORTAL_PRIVACY.md` 远期清单也承认「现在 chat_message 表和 logs/server.log 是无限期留的」。
- **影响**：PDPO 第 2 项保障原则要求「不超过必要期间」；资料当事人是未成年人，标准更高。日志文件一旦外泄（备份、误拷、服务器被入），等于泄露全部聊天记录，而且这份副本不在任何「删除会话」逻辑的覆盖范围内——用户在页面上删了会话，日志里还在。
- **方案**：a) 把上述四处正文级日志从 `logger.info` 降为 `logger.debug`，`configure_logging` 里 `server` logger 的级别由 `settings.debug` 决定（DEBUG=1 才开 debug）——这就是注释里说的「确认后再收窄」，流式排查期已过；b) 归档保留策略见第 22 条；c) 在 `PARENT_PORTAL_PRIVACY.md` 的保留期限决定里把日志一并覆盖，写清「日志是聊天记录的副本，同生命周期」。
- **第三方库**：无
- **风险**：下次排查流式问题时可看的东西变少——`DEBUG=1` 临时打开即可，`.env` 里本来就留着这个开关。
- **工作量**：M

### 8. 头像上传：应用层校验齐全，但 nginx 默认 1MB 会先把它截掉

- **位置**：`avatar.py`（`MAX_UPLOAD_BYTES = 5MB`、`MAX_PIXELS = 2000 万`、格式白名单、重编码）；`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md` 的 `/api/` location（没有 `client_max_body_size`）
- **现状**：应用层做得对：白名单 PNG/JPEG/HEIF、显式拒 SVG（注释写明「同源下它能带脚本」）、5MB 字节上限（`upload_avatar` 只读 `MAX_UPLOAD_BYTES + 1` 字节，不整读进内存）、像素上限在 `load()` 之前查（防解压炸弹）、EXIF 方向先摆正再重编码剥掉。但 nginx 没配 `client_max_body_size`，默认值是 1m。
- **影响**：1–5MB 的头像（iPhone 原图轻松超过）本地直连 3001 能传、生产走 nginx 就是 413——而 413 的正文是 nginx 的 HTML 错误页，前端只认 `{"detail": "字符串"}`，用户看到的是「无法连接到服务器」，和 `app.py` 里 422 handler 注释描述的坑一模一样。
- **方案**：指南的 `/api/` location 加 `client_max_body_size 6m;`（multipart 编码有开销，比应用上限留一点余量）；前端把「响应不是 JSON」的分支映射成友好提示属于前端侧配套，此处在文档里提一句即可。
- **第三方库**：无
- **风险**：无。
- **工作量**：S

### 9. 响应没有任何安全头（CSP、nosniff、防嵌入）

- **位置**：`docs/NGINX_SPA_DEPLOYMENT_GUIDE.md` 全部配置；`app.py`（也没有注入安全头的中间件）
- **现状**：两层都没设 `Content-Security-Policy`、`X-Content-Type-Options`、`X-Frame-Options`/`frame-ancestors`、`Referrer-Policy`。前端用 react-markdown + KaTeX 渲染 AI 输出（`package.json` 可见依赖）。
- **影响**：CSP 是 XSS 的最后一道闸——AI 输出内容不完全可控（上游工作流可能被提问诱导），渲染链一旦有洞没有兜底；页面可被任意站点 iframe 嵌入做点击劫持；`nosniff` 缺失让「上传内容当脚本执行」类问题多一条路。
- **方案**：nginx server 级 `add_header`（草图见第 25 条的完整配置）。CSP 从宽起步：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'`——`style-src 'unsafe-inline'` 是给 KaTeX/内联样式留的，先按这个跑通再逐项收紧。注意 nginx 的 `add_header` 继承规则：location 里只要出现任何 `add_header`，server 级的就全不继承，指南里 `location = /index.html` 和 `/assets/` 已经各有一条 `Cache-Control`，安全头要么在这两个 location 里重复，要么用 `include snippets/security-headers.conf;` 的写法统一。
- **第三方库**：无
- **风险**：CSP 收得太紧会打坏 KaTeX 或 markdown 渲染；必须在真实部署上把「发一条带公式的消息」过一遍再定稿。
- **工作量**：M

### 10. 依赖漏洞面：没有审计手段，ruff 混在运行时依赖里，httpx2 来源值得确认

- **位置**：`/server/pyproject.toml`、`/server/uv.lock`
- **现状**：15 个运行时依赖，全部只有下限没有上限，靠 `uv.lock` 锁版本；`ruff>=0.17.2`（检查工具）列在 `dependencies` 而不是 dev 组；仓库没有任何漏洞审计步骤（`scripts/check-server.sh` 只跑 ruff 两项）。另外 `TECH.md` 写「访问 FastGPT 只用 httpx2 2.16.0」——httpx 生态里的常见包名是 `httpx`，`httpx2` 这个发布名值得核对 PyPI 上的来源和维护者（是不是同一拨人、下载量和审计状态如何），这是供应链层面的基本尽调。
- **影响**：pillow、starlette（随 fastapi）、redis、psycopg 这类传递面大的库出了已知 CVE，lockfile 会长期带着洞没人知道；ruff 混在运行时依赖里让「生产要装什么」变模糊。
- **方案**：a) 审计不进运行时依赖：`check-server.sh` 或发版清单里加一步 `uvx pip-audit`（uvx 临时环境跑，不碰 `pyproject.toml`）；b) ruff 挪到 `[dependency-groups]` 的 dev 组（uv 原生支持，`uv sync` 默认仍装 dev，行为不变）；c) 建立节奏：每月 `uv lock --upgrade` + 跑 ruff 验收 + 手动过登录/聊天/停止核心链路；d) 核对 httpx2 来源，若确认是无人审计的改名分叉，评估回 `httpx`（`fastgpt.py` 里的 API 面很小：`AsyncClient`、`stream`、`Timeout`、`HTTPError`，替换成本低）。
- **第三方库**：pip-audit（点名；只作审计工具经 uvx 运行，不进依赖清单）
- **风险**：`uv lock --upgrade` 可能引入破坏性变更，所以要有固定节奏加人工验收，而不是自动升；换 httpx 属于「动核心链路」，按 AGENTS.md 规矩先报备再动。
- **工作量**：S（审计与 dev 组）/ M（httpx2 评估替换）

### 11. 反代头信任边界：IP 限流依赖 XFF，只在「回环绑定 + nginx 前置」下才正确

- **位置**：`server/__init__.py`（`uvicorn.run(app, host="127.0.0.1", port=3001)`，其余全默认）；`app.py` `change_password` 里 `request.client.host`；nginx 指南的 `X-Forwarded-For` 设置
- **现状**：uvicorn 默认 `proxy_headers=True`、`forwarded_allow_ips="127.0.0.1"`，即只信任从回环地址来的 `X-Forwarded-For`。nginx 同机反代正好满足，所以 `request.client.host` 现在是真实客户端 IP——链路正确，但完全建立在两个隐含前提上（只听回环、前面必是 nginx）。这两个前提在代码里没有任何显式表达。
- **影响**：将来任何人把 host 改成 `0.0.0.0`「方便联调」，XFF 就成了客户端可伪造头，IP 维度限流直接失效；反过来若某层代理没设 XFF，所有用户共享 nginx 的回环 IP，IP 维度限流误伤所有人（叠加第 3 条的低阈值更糟）。
- **方案**：a) `uvicorn.run(...)` 里显式写 `proxy_headers=True, forwarded_allow_ips="127.0.0.1"`，把隐含依赖变成看得见的声明，加一行注释说明「只听回环是安全前提」；b) `start-server.sh` 和部署文档同样写明；c) 限流处发现 `client.host` 是回环地址时 `logger.warning` 一次（说明 XFF 链断了），静默失效正是 `server/AGENTS.md` 里 Redis ACL 那条教训的同款坑。
- **第三方库**：无
- **风险**：无。
- **工作量**：S

---

## 配置与运维

### 12. Settings 的 .env 定位逻辑绑定仓库目录形状

- **位置**：`/server/src/server/types/env.py` 的 `_env_file()`
- **现状**：从 `env.py` 所在位置逐级向上，找「同时存在 `.env.example` 和 `server/pyproject.toml` 的目录」，取其下 `.env`；找不到抛 `RuntimeError("找不到仓库根目录")`。`model_config` 里 `extra="ignore"`。
- **影响**：a) 任何脱离仓库形状的部署——只拷 `server/` 到 `/opt`、打进容器、以 site-packages 安装——启动即崩，而且崩在 import 期，报错和真实原因隔了一层；b) `extra="ignore"` 让拼错的变量名静默通过：`DATABASE_PASSWORD` 拼错会被 `min_length=1` 拦住，但 `FASTGPT_READ_TIMEOUT_SECONDS` 拼错就静默用默认 30，排查时想不到是变量名的事。
- **方案**：a) `_env_file()` 优先读显式环境变量 `H2BOT_ENV_FILE`，向上探测只作 fallback——生产用 systemd `EnvironmentFile=` 或容器 env 注入时根本不需要 `.env` 文件，pydantic-settings 本来就直接读进程环境；b) 启动时 `logger.info` 一行「配置来源：<路径或 process-env>」（`configure_logging` 已经在打印日志路径，照同样格式加）；c) `extra` 保持 ignore（改成 forbid 会被无关环境变量误伤），但把「拼错静默」写进 `docs/TECH.md` 环境变量一节作提醒。
- **第三方库**：无
- **风险**：无；`_env_file()` 在 `Settings` 类定义时求值，改动只影响启动路径。
- **工作量**：S

### 13. 没有迁移工具：schema 演进靠 init.py 手写补列，只进不退、无版本记录

> **2026-11-05**：alembic 已安装（1.20.1，进 uv.lock）。引入计划：建迁移目录、基线 = stamp 现有表结构、第一个迁移 = `login_token.expires_at` 索引；建表引导仍走 create_all，不做全量改造。

- **位置**：`/server/src/server/db/init.py`（`create_all` + `_ensure_pinned_column` 等 5 个手写 inspect+ALTER 函数）；`db/models.py`
- **现状**：新表靠 `create_all`，改列靠每列一个手写函数；什么时候跑靠人记（`server/AGENTS.md`：「改了数据库结构之后跑」）。没有版本号、没有回滚、没有「库现在处于什么状态」的记录；改约束（比如远期清单里明写的「家长 role 要扩 `account_role_check` 枚举」）在这套机制里没有路径——`_ensure_role_column` 的注释自己演示了加约束要小心全表扫描，这种知识现在只存在于注释里。
- **影响**：schema 每演进一次就多一个一次性函数，环境之间（开发机、部署机）没有任何手段核对一致性；「先迁移后起服务」的部署顺序没有工具承载，靠文档口头约定。远期清单上排着的家长绑定表、保留期限字段都会继续往 init.py 上堆。
- **方案**：引入 alembic：`uv add alembic`，`server/` 下 `alembic init`，第一个 revision 用 `--autogenerate` 对着现有库生成后人工核对成「与当前 schema 完全一致的 baseline」，此后所有变更走 `alembic revision --autogenerate` + 人工 review + `alembic upgrade head`。`init.py` 瘦身成只管初始账号（`_ensure_initial_account`、`_ensure_console_admin`），补列函数全部退役。`server/AGENTS.md` 的「常用指令」加 `uv run alembic upgrade head`。
- **第三方库**：alembic（点名。SQLAlchemy 官方迁移工具，事实标准；自己写版本表加迁移 runner 等于重造它，且「依赖优先于手搓」是两份 AGENTS.md 的明文规矩）
- **风险**：baseline 必须和存量库逐列一致，生成后先 `pg_dump --schema-only` 对照；首次在生产跑之前先做备份（第 20 条）。这是「动数据结构」级别的大改动，按规矩先向维护者完整说明再动手。
- **工作量**：M

### 14. 连接池全默认、没有 pre_ping：数据库重启后第一批请求报错，高峰期线程抢连接

- **位置**：`/server/src/server/db/session.py` 的 `get_engine()`
- **现状**：`create_engine(URL.create(...), connect_args={"connect_timeout": 5})`，其余全默认：QueuePool `pool_size=5`、`max_overflow=10`，无 `pool_pre_ping`、无 `pool_recycle`。同时 `app.py` 里大量端点是同步 `def`，FastAPI 把它们扔进 anyio 线程池（默认 40 线程），每个线程里的 `db_session()` 都要从池里拿连接。
- **影响**：a) Postgres 重启或空闲断连后，池里的死连接要等到借出时才发现，用户看到的是第一批 500；b) 高峰（一整班同时登录/刷新）40 个线程抢 15 个连接，多出来的排队等 `connect_timeout`，慢查询时雪崩；c) 第 15 条的重复查询会进一步放大池压力。
- **方案**：`create_engine` 显式给池参数并进 `Settings`（`DATABASE_POOL_SIZE` 默认 10、`DATABASE_POOL_OVERFLOW` 默认 20）：

  ```python
  _engine = create_engine(
      URL.create(...),
      connect_args={"connect_timeout": 5},
      pool_pre_ping=True,          # 借出前先 ping，死连接自动换新
      pool_size=settings.database_pool_size,
      max_overflow=settings.database_pool_overflow,
      pool_recycle=1800,           # 半小时强制换连接，防中间设备掐空闲连接
  )
  ```

- **第三方库**：无
- **风险**：`pool_pre_ping` 每次借出多一个往返，本机 PG 上微秒级，可忽略。池上限放大后 PG 侧 `max_connections`（默认 100）要留余量，部署文档提一句。
- **工作量**：S

### 15. 每个认证请求至少 3 次 DB 往返：中间件与端点重复验证、清扫 DELETE 搭车

- **位置**：`app.py` 的 `_RefreshLoginCookie`（`_cookie_is_valid` → `_login_token` 查询+续期+commit）、各端点 `_account_from_cookie`（再走一遍 `_login_token`）、`_login_token` 开头的 `_sweep_expired_tokens()`（第三次，DELETE）
- **现状**：同一个令牌在一次请求里被查两遍、续期两遍（中间件 set-cookie 前查一次，端点鉴权再查一次），外加一次全表 DELETE 清扫。
- **影响**：DB QPS 是必要值的 3 倍，连接池占用同步放大；教室并发场景最先顶不住的就是这里。第 4 条解决清扫，这条解决重复验证。
- **方案**：中间件验证通过后把 `LoginToken`（或至少「已验证」标记+account_id）放进 `scope["state"]`，Starlette 会把它暴露成 `request.state`；`_account_from_cookie` 先看 state 里有没有现成结果，有就复用、没有再查库（保持独立调用时的行为不变）。另一个更激进的方向是中间件只凭「cookie 存在」就重发 set-cookie，把校验和续期完全留给端点——但那样无效 cookie 也会被续命刷新，前一个方案更稳。
- **第三方库**：无
- **风险**：`_password_account` 同时看两个 cookie、`_admin_from_cookie` 走另一条线，复用逻辑要分别覆盖；改动集中在 app.py 一个文件，但属于「动登录/会话核心链路」，按规矩先报备。
- **工作量**：M

### 16. 没有进程守护：前台脚本拉起，崩了没人扶、重启后不会自起

- **位置**：`/scripts/start-server.sh`（`exec uv run uvicorn ... ` 前台进程）；`docs/TECH.md`、nginx 指南（都只说「跑在 127.0.0.1:3001」，没说怎么保活）
- **现状**：开发用 `pnpm run dev:backend` 没问题，但部署指南假设后端「已经在跑」，没有任何保活方案；进程崩溃或机器重启后服务消失，直到有人发现。
- **影响**：一次未捕获异常之外的崩溃（OOM、机器重启）= 无限期停服；学生「连不上」的报障和真实原因之间隔着一次人工登录服务器。
- **方案**：给部署文档补一节 systemd（unit 草图如下），放 `docs/NGINX_SPA_DEPLOYMENT_GUIDE.md` 或单独的 `docs/SERVER_DEPLOYMENT.md`；`start-server.sh` 保持开发用途不动。要点：专用非 root 用户、`Restart=on-failure`、依赖 `postgresql.service`/`redis.service` 顺序、`--timeout-graceful-shutdown 30`（见第 17 条）、`ReadWritePaths` 只放开 logs 目录。

  ```ini
  # /etc/systemd/system/h2bot-server.service
  [Unit]
  Description=H2 Bot backend (FastAPI/uvicorn)
  After=network-online.target postgresql.service redis-server.service
  Wants=network-online.target

  [Service]
  Type=exec
  User=h2bot
  WorkingDirectory=/opt/h2bot/server
  ExecStart=/usr/local/bin/uv run uvicorn server.app:app \
      --host 127.0.0.1 --port 3001 --timeout-graceful-shutdown 30
  Restart=on-failure
  RestartSec=3
  NoNewPrivileges=true
  PrivateTmp=true
  ProtectSystem=strict
  ReadWritePaths=/opt/h2bot/logs

  [Install]
  WantedBy=multi-user.target
  ```

- **第三方库**：无
- **风险**：systemd 接管 stdout 后，`log.py` 的终端 handler 输出会进 journal，和 `logs/server.log` 内容重复——接受，或给 `configure_logging` 加个「无 TTY 就不挂 stream handler」的判断（`sys.stderr.isatty()`），顺手的事。
- **工作量**：M

### 17. 优雅停机：SSE 长连接与后台落库任务没有收尾逻辑

- **位置**：`app.py` 的 `_lifespan`（finally 只 `aclose` FastGPT 客户端）；`_running`、`_settle_tasks`、`_stop_tasks` 三个进程级任务注册表；`start-server.sh` / `server/__init__.py`（都没设 graceful timeout）
- **现状**：uvicorn 的 `timeout_graceful_shutdown` 默认 `None`——收到 SIGTERM 后无限等现有连接结束，而本服务的「现有连接」包含可以持续几分钟的 SSE 流。同时 `_settle_tasks`（每轮落定后写 `message` 表的独立任务）和 `_stop_tasks`（叫停上游的 fire-and-forget 任务）在关停时没人 await：进程退出时它们直接被丢弃。
- **影响**：发版重启的窗口里，正在进行的轮次可能「Redis 里有半截、库里没落定」，`_write_round_end` 里那段「失败后找上游核对补全」的逻辑也来不及跑；上游没被叫停会继续白写 token（`fastgpt.py` 注释里明说的浪费）。等第 16 条上了 systemd，90 秒默认 SIGKILL 时限会把这些半成品硬切断。
- **方案**：a) 启动命令加 `--timeout-graceful-shutdown 30`；b) `_lifespan` 的 finally 里补收尾：先 `asyncio.wait(_settle_tasks, timeout=10)`、`asyncio.wait(_stop_tasks, timeout=5)`（这些任务内部都已是容错写法，等不到也不致命），`_running` 里的流式任务逐个 `cancel()`——cancel 会走 `_relay` 现成的 `CancelledError` 分支，状态被标成 aborted，页面语义正确。草图：

  ```python
  finally:
      for tasks in _running.values():
          for task in tasks:
              task.cancel()
      if _settle_tasks:
          await asyncio.wait(set(_settle_tasks), timeout=10)
      if _stop_tasks:
          await asyncio.wait(set(_stop_tasks), timeout=5)
      fastgpt = _app.state.fastgpt
      if isinstance(fastgpt, FastGPT):
          await fastgpt.aclose()
  ```

- **第三方库**：无
- **风险**：收尾代码自己跑在关停路径上，超时必须给足且不能抛——上面每个 `asyncio.wait` 都带 timeout，`_relay` 的 finally 已经处理过「取消中不能 await 队列」的坑（`put_nowait`），沿用同一模式。
- **工作量**：M

### 18. 单 worker 约束没有成文：加 `--workers` 会静默打断「停止/重发」语义

- **位置**：`server/__init__.py`（`uvicorn.run(app, ...)` 单进程）；`app.py` 的 `_running`、`_pending_stops`、`_records_cache`（全是进程内 dict/set）
- **现状**：abort 的核心动作是「从 `_running` 里找到那个 asyncio.Task 并 cancel」；「等叫停落地再开新轮」靠 `_pending_stops`；防刷新打垮上游靠 `_records_cache`。这三样都只在单进程内成立。Redis 里有停止标记和半截文字，但任务本体不在 Redis 里。
- **影响**：性能不够时最自然的动作是 `uvicorn --workers 4`，而它会让 `/abort` 大概率落到另一个 worker 上——找不到任务、直接返回 204，用户按了停止但回答继续写。这和 `server/AGENTS.md` 里「Redis ACL 前缀不对就静默失效」是同一类陷阱：不报错，功能没了。
- **方案**：短期（本批就能做）：在 `server/AGENTS.md` 和部署文档写明「只能单 worker 运行；容量瓶颈先考虑第 15 条的查询瘦身和机器规格，不要加 --workers」。长期若确需多进程：轮次归属搬进 Redis（每个 chat_id 由持锁的 worker 处理，abort 只写标记、持有者轮询/键空间通知感知后自己 cancel）——这是大改，立项前先按规矩报备。
- **第三方库**：无
- **风险**：文档层面无风险；长期方案改动核心链路，单独评估。
- **工作量**：S（文档）/ L（真多进程化）

### 19. 健康检查恒回 200，外部监控无法用状态码告警

- **位置**：`app.py` 的 `read_status()`（`/api/status`）
- **现状**：免登录，返回 `{"database": "ok|unavailable", "reply_store": "ok|unavailable"}`，但 HTTP 状态码恒 200。nginx 指南的验证清单也只 `curl /api/status` 看有没有 JSON。
- **影响**：uptime 探测、负载均衡健康检查、cron 告警这类只看状态码的监控，在数据库整个挂掉时仍然显示「服务正常」；前端常驻提示依赖 200+正文的现有语义，又不能直接改它的行为。
- **方案**：保留 `/api/status` 原样（前端契约不动），新增 `/api/healthz`：`database != ok` 时返回 503，`reply_store` 不可用只降级不回 503（沿用「Redis 是可选加固」的既有哲学）。监控和 nginx 指南的验证清单指向新端点。两个端点都在 `_RefreshLoginCookie` 的豁免清单里加上（现在只豁免 `/api/status`，healthz 不该触发 cookie 续期查询）。
- **第三方库**：无
- **风险**：无；纯增量端点。
- **工作量**：S

### 20. 数据库没有任何备份与恢复安排

- **位置**：全仓库——没有备份脚本、没有恢复文档；`.gitignore` 排除的只是仓库内文件，PG 数据本来就不在仓库里
- **现状**：账号、会话、`message` 表里的全部聊天记录只存在于部署机的一个 PostgreSQL 实例；Redis 里的东西按设计可丢，PG 里的不行。
- **影响**：机器故障、误操作（`init.py` 或将来 alembic 迁移跑错）、磁盘损坏都等于全量数据丢失。学生聊天记录是个人资料，丢失本身按 PDPO 也算需要交代的事件；第 13 条引入迁移工具后，「迁移前可回退」的前提就是有备份。
- **方案**：a) cron 跑 `pg_dump -Fc h2bot`，保留最近 N 份并异地存一份（哪怕 scp 到另一台机器）；b) 写一页《备份与恢复》进 `docs/`：dump 命令、恢复命令（`pg_restore`）、演练一次并记录日期；c) 备份文件含个人数据，权限 `chmod 600`、传输走加密通道，写进同一页。
- **第三方库**：无（pg_dump/pg_restore 是 PostgreSQL 自带）
- **风险**：备份成为新的 PII 集中点，访问控制要和 `.env` 同级对待。
- **工作量**：S

### 21. 启动顺序与依赖就绪：服务起了但 PG/Redis 没起时，行为是「半死」而不是「明确失败」

- **位置**：`db/session.py`（engine 懒创建，首次查询才连）；`ratelimit.py`/`reply_store.py`（Redis 懒连接 + 降级）；`app.py` `_lifespan`（只建 FastGPT 客户端，不探依赖）
- **现状**：`server/AGENTS.md` 写「起服务前，本机 PostgreSQL 和 Redis 必须在运行」，但代码不检查：PG 没起时进程照常启动，所有接口 500（`_database_available` 返回 unavailable，`/api/status` 仍 200）；Redis 没起时按设计静默降级，限流和半截回答无声失效——`server/AGENTS.md` 自己记录过这种静默失效踩过坑（ACL 前缀那条）。
- **影响**：开机自启场景（第 16 条）里服务比数据库先起是常态；运维看到「进程在跑」但全站 500，或者更糟——Redis 没起、一切「正常」、限流裸奔，日志里只有 warning 没人看。
- **方案**：`_lifespan` 启动段做依赖自检并**大声**报告：PG 用 `SELECT 1`（复用 `_database_available`），失败直接 `raise RuntimeError` 让进程退出交给 systemd `Restart=on-failure` 重试（配合 `RestartSec=3` 天然形成「等数据库起来」的语义）；Redis ping 失败则按既有哲学放行，但从 warning 升级为启动日志里一条显眼的「限流与半截回答已降级」。
- **第三方库**：无
- **风险**：PG 短暂不可用会让服务进入重启循环——这正是 systemd 场景想要的行为；开发场景 `uv run server` 前台跑，报错直接可见，无额外成本。
- **工作量**：S

---

## 可观测性

### 22. 日志归档只增不减：轮转有了，保留策略没有

- **位置**：`log.py` 的 `_SizeLogFile._rotate()` / `_archive_path()`；`/logs/` 目录
- **现状**：满 5MB 把 `server.log` 改名成 `server-<YYYYmmdd-HHMMSS-ffffff>.log`，然后新开文件。归档永不删除、不压缩。轮转实现本身是稳的（`emit` 前查大小、rename 后重开、异常吞掉走 `logging.raiseExceptions`）。
- **影响**：磁盘缓慢但必然地被吃掉；叠加第 7 条（每个提问和每块流式输出都进日志），活跃部署一天就能产出一个 5MB 归档。无限归档同时就是无限期的 PII 副本。
- **方案**：最小改动在 `_rotate()` 末尾加清理：列出同目录 `server-*.log`，按文件名里的时间戳排序，保留最近 30 个（约 150MB 上限），其余删除；保留数量做成 `log.py` 模块常量即可，不用进 Settings。想省心的替代是交给系统 logrotate（`/etc/logrotate.d/h2bot`，`copytruncate` 模式不需要应用配合），但那要求部署文档多一节，且和自研轮转并存会互相干扰——二选一，建议先做 handler 内清理。
- **第三方库**：无
- **风险**：删除动作在日志 handler 里执行，写错目录后果严重——`_archive_path` 已经限定在 `baseFilename` 同目录，清理也只在同一目录 glob，风险可控。
- **工作量**：S

### 23. 日志无结构、无请求关联 id，第三方日志和业务日志混写一个文件

- **位置**：`log.py`（`_FORMAT = "%(asctime)s %(levelname)s %(name)s %(message)s"`；`configure_logging` 把文件 handler 挂到 root，root 级别放开到 INFO）
- **现状**：纯文本单行格式。聊天相关日志大多带 `chat_id`，但 access 日志（uvicorn.access 也进文件）和业务日志之间没有关联手段；root 放开后 httpx2 等第三方 INFO 日志全部混入 `server.log`。查「某一个请求从进来到上游回来发生了什么」只能按时间戳肉眼对。
- **影响**：并发一多（教室里几十个学生同时提问），交错的时间线基本不可读；第 7 条降噪之后，留下的日志更值得读得懂。
- **方案**：分两档。a) 不加库：`contextvars` 存 request id（ASGI 中间件生成或复用 `chat_id`/`turn_id`），配一个 `logging.Filter` 把它注入 record，`_FORMAT` 加 `%(request_id)s`——总共二十行左右，纯标准库；b) 要 JSON 结构化就点名 structlog：processor 链输出 JSON、天然支持 contextvars 绑定，`log.py` 的 formatter 层整体替换，业务代码里的 `logger.info("...", args)` 调用面基本不动。以本项目「单机、日志进文件、人肉排查」的体量，a 档性价比更高；b 档等真有日志聚合需求（接 Loki/ELK）再上。
- **第三方库**：structlog（点名，仅 b 档需要；a 档无）
- **风险**：b 档改日志格式，`AGENTS.md`/`server/AGENTS.md` 里关于日志内容的描述要同步；a 档无风险。
- **工作量**：a=S，b=M

### 24. 未捕获异常只落一行日志，没有错误上报与聚合

- **位置**：`app.py` 的 `_unhandled_error`（注释：「这里只记一行。栈由 uvicorn 打一遍就够」）
- **现状**：500 的异常记 `method path exc` 一行，栈靠 uvicorn 再打一遍进同一个文件；没有任何主动通知渠道。
- **影响**：生产上出了 500，唯一的发现途径是有人想起去看 `server.log`；同一个错误反复发生反复打栈，没有聚合计数，「这个错一天出现几次」要 grep 才知道。
- **方案**：点名 sentry-sdk（FastAPI 集成一行 `sentry_sdk.init(integrations=[FastApiIntegration()])`，DSN 进 `.env`/Settings）。两个前提必须满足，否则不上：a) 自托管 Sentry（项目基调是学生数据不出自己的服务器，`PARENT_PORTAL_PRIVACY.md` 明写，SaaS Sentry 与此冲突）；b) `send_default_pii=False` 并确认请求正文不进事件——聊天正文是 PII，报错上下文里不能带。在这两个前提成立之前，本条可以缓：先靠第 23 条的 request id 让人肉排查变快。
- **第三方库**：sentry-sdk（点名；是否采用、自托管还是不用，由维护者定）
- **风险**：默认配置可能把请求上下文（含 body）送进事件，上线前必须逐项核对 scrub 配置——配错了比不配更糟。
- **工作量**：M

### 25. 没有任何指标：QPS、时延、上游失败率只能从日志里刨

- **位置**：全仓库（无 `/metrics`；nginx access log 是唯一的系统性数据源，而指南没提怎么用它）
- **现状**：应用零打点。「上游连不上」的次数、每轮回答的失败率、argon2 verify 的耗时、DB 池的等待，全部散在日志行里。第 15 条说「中间件让 DB 查询翻倍」，这类判断现在也只能靠读代码，没有数据佐证。
- **影响**：容量规划（比如第 18 条要不要多进程化）和回归定位（发版后变慢了吗）没有量化依据；故障复盘只能靠时间戳对齐日志。
- **方案**：务实分两步。a) 零依赖先做：部署文档加一节「用 nginx access log 看基础面」——`goaccess`（点名，只读分析工具，装在服务器上，不进应用依赖）一条命令出 HTML 报表，QPS、状态码分布、最慢 URL 都有了；b) 真有持续监控需求时再点名 prometheus-client 进应用：加 `/metrics`（只听回环、nginx 不转发，天然不对外），打三类指标就够——HTTP 请求时延直方图、上游失败计数器（`FastGPTError` 抛出点）、DB 池状态（SQLAlchemy 事件钩子）。不建议现在顺手做 b：没有采集端（Prometheus server）之前，打点只是自嗨。
- **第三方库**：goaccess（a，服务器侧工具）、prometheus-client（b，届时进依赖）——都只点名，本批不引入
- **风险**：`/metrics` 若将来被转发出去会泄露内部行为数据，文档写明「仅回环」。
- **工作量**：a=S，b=M

---

## 部署

### 26. nginx 配置完善度：缺 body 上限、安全头、gzip、HTTP/2、TLS 参数、边缘限速

- **位置**：`/docs/NGINX_SPA_DEPLOYMENT_GUIDE.md` 的「完整配置」
- **现状**：指南把 SPA 回落、`index.html` 不缓存、assets 一年 immutable、SSE 关缓冲（`proxy_buffering off`）和 300s 读超时都做对了，教学式的行文也好；但对照生产清单缺：`client_max_body_size`（第 8 条）、安全头（第 9 条）、gzip（JS/CSS 文本资产不压缩，首屏流量白花）、HTTP/2、`server_tokens off`、`limit_req`（应用层限流之外的边缘粗闸，对第 1 条的登录爆破是最便宜的第一道防线）、TLS 只有一句「certbot 会自动改」（手动配的话没有 `ssl_protocols`/HSTS 可抄）、`proxy_set_header Connection ""`（HTTP/1.1 反代上游的标准写法，去掉 hop-by-hop 头）。
- **影响**：以上每一项都对应一个真实的风险或浪费，且指南是部署者的唯一依据——指南没写，生产上就不会有。
- **方案**：更新指南，给出一份「HTTPS 完整配置」作为新增章节（保留现有 HTTP 教学配置不动，增量式补充，符合指南「写给第一次部署的人」的定位）。草图（`limit_req_zone` 必须放 `http` 块，指南里要说明这一点）：

  ```nginx
  # http 块（/etc/nginx/nginx.conf 或 conf.d/ 顶层）：
  limit_req_zone $binary_remote_addr zone=api_login:10m rate=10r/m;

  server {
      listen 443 ssl;
      http2 on;
      server_name h2bot.example.com;
      ssl_certificate     /etc/letsencrypt/live/h2bot.example.com/fullchain.pem;
      ssl_certificate_key /etc/letsencrypt/live/h2bot.example.com/privkey.pem;
      ssl_protocols TLSv1.2 TLSv1.3;

      root /var/www/h2bot/dist;
      client_max_body_size 6m;
      server_tokens off;

      gzip on;
      gzip_types text/css application/javascript application/json image/svg+xml;
      gzip_min_length 1024;

      # 安全头（include 成 snippet，供各 location 复用，绕开 add_header 不继承的坑）
      include snippets/h2bot-security-headers.conf;   # 内容见第 9 条草图 + HSTS

      location = /index.html {
          add_header Cache-Control "no-cache";
          include snippets/h2bot-security-headers.conf;
      }
      location /assets/ {
          add_header Cache-Control "public, max-age=31536000, immutable";
          include snippets/h2bot-security-headers.conf;
      }
      location / { try_files $uri $uri/ /index.html; }

      location /api/login {
          limit_req zone=api_login burst=10 nodelay;
          include snippets/h2bot-proxy-api.conf;
      }
      location /api/ {
          include snippets/h2bot-proxy-api.conf;
      }
  }
  server {
      listen 80;
      server_name h2bot.example.com;
      return 301 https://$host$request_uri;
  }
  ```

  `snippets/h2bot-proxy-api.conf` 即现有指南 ④ 的内容加 `proxy_set_header Connection "";`。
- **第三方库**：无
- **风险**：指南改动大，需在一台真实 nginx 上 `nginx -t` + 走一遍指南自带的验证清单（回落、反代、逐字流式）再合入。
- **工作量**：M

### 27. TLS 启用与应用行为联动：Secure cookie、协议感知必须同批做

- **位置**：nginx 指南「HTTPS」一节；`app.py` `_set_cookie`；`types/env.py`（无协议相关配置）
- **现状**：指南把 HTTPS 当附录；应用完全不知道外面是什么协议——cookie 无 Secure（第 2 条）、没有任何读 `X-Forwarded-Proto` 的逻辑。uvicorn 的 `proxy_headers` 开着，`request.url.scheme` 在 nginx 设了 `X-Forwarded-Proto $scheme` 的前提下其实已经是对的，只是没人用它。
- **影响**：只按指南「certbot 跑一下」上 TLS，cookie 仍无 Secure 标志，HTTPS 的收益打折（降级访问时令牌照发）；反过来先开 `COOKIE_SECURE=1` 再上证书，中间窗口全员登录不上。
- **方案**：把第 2 条的 `COOKIE_SECURE` 开关、第 26 条的 TLS 配置、HSTS（`max-age` 从小值起步，确认全站 HTTPS 无误后再放大）写成指南里的同一个上线批次清单：证书 → 301 跳转 → `COOKIE_SECURE=1` → 验证登录/退出/改密 → HSTS。顺序错了任何一步都有对应的回退动作（关旗标即回退）。
- **第三方库**：无
- **风险**：批次顺序执行错导致全员登出——清单里写明验证点和回退开关。
- **工作量**：S（依赖第 2、26 条先落地）

### 28. 前端发布非原子覆盖，以及「前后端同机」的信任边界只有代码约束

- **位置**：nginx 指南「部署步骤」（`sudo cp -r dist /var/www/h2bot/`）与「以后每次发新版前端」（覆盖）；`server/__init__.py`/`start-server.sh`（回环绑定）；`server/AGENTS.md`（Redis ACL 前缀规矩）
- **现状**：两个小问题同属部署边界。a) 发布是往正在服务的目录里覆盖拷贝：`index.html` 换新、assets 拷贝进行中的窗口里，用户可能拿到「新 index 引用还没拷完的 asset」而白屏——概率低，但每次发版都存在，且指南没提。b) 后端只听回环是对的，PG/Redis 也默认本机，但指南没有告诉部署者「5432/6379 同样不能对外」；PG 的 `h2bot_app` 是全权账号，Redis 只有 `h2botapp-chat:` 前缀的 ACL 兜着。
- **影响**：a) 发布窗口偶发白屏，报障难复现；b) 部署者为了「远程调试方便」把 PG 或 Redis 端口开出去，是这类单机部署最常见的翻车方式，而仓库文档目前没有任何一处提醒。
- **方案**：a) 发布改原子切换：`rsync` 到 `/var/www/h2bot/releases/<时间戳>/`，`ln -sfn` 把 `current` 指过去，nginx `root /var/www/h2bot/current`；保留最近 3 个版本，回滚就是把软链指回去。指南「部署步骤」加 5 行 shell。b) 指南加「端口与防火墙」小节：对外只开 80/443；`ufw allow 80,443/tcp && ufw deny 3001,5432,6379` 三行示例；写明 Redis ACL 前缀和 PG 账号权限的现状（引 `server/AGENTS.md`）。
- **第三方库**：无
- **风险**：软链切换后 certbot 的 webroot 验证路径若指向旧 releases 目录会失效——指南示例用 `root .../current` 即无此问题。
- **工作量**：S

---

## 建议的落地顺序

| 批次 | 条目 | 说明 |
| --- | --- | --- |
| 第一批（小而急，纯加固） | 1、5、6、8、14、19、21、22 | 登录防爆破、初始口令、body 上限、nginx 1MB 坑、池参数、healthz、启动自检、日志清理——互不纠缠，单条都是 S |
| 第二批（会话与停机，动核心链路，先报备） | 2、4、15、16、17 | cookie Secure、会话绝对上限、查询瘦身、systemd、优雅停机——都在登录/会话链路上，按 AGENTS.md 规矩逐条向维护者说明后做 |
| 第三批（部署文档与 TLS 同批） | 26、27、28、9、3 | nginx 完整配置 + TLS + Secure cookie + 安全头 + 限流阈值调整，一次发版窗口做完 |
| 第四批（工具与结构，需要维护者拍板依赖） | 13、10、12、7、18、23 | alembic、依赖审计、Settings 定位、日志降噪、单 worker 成文、request id |
| 缓做（有前提或需求驱动） | 24、25 | Sentry（前提：自托管 + PII scrub）、指标（前提：有采集端） |

**总体第三方库结论**：真正建议引入的只有 **alembic**（第 13 条，schema 演进已到手工机制的极限，且是两份 AGENTS.md「依赖优先于手搓」规矩的直接应用）。**pip-audit**、**goaccess** 是服务器侧工具经 uvx/系统包管理器运行，不进应用依赖。**structlog**、**sentry-sdk**、**prometheus-client** 各自绑定了明确的前提条件，条件不成立就不引入。**slowapi 不需要**——现有 `ratelimit.py` 的 Redis 计数已经覆盖了它的主要能力，缺的只是把登录端点接上去（第 1 条）。

*本文档为只读调研产物：未读 `.env`，未包含任何真实密钥值；所有论断可在对应行的代码里复核。*
