# 账号管理

登录这块的待办：注册、修改密码、管理员后台。

这份文件只讲账号和登录两件事。

## 顺序

1. 先做「修改密码」。
2. 再加 role 列，登录按 role 分流（聊天页和控制台两个登录接口、两个 cookie）。
3. 再把旧的 `admin` 账号改名成 `test01`。
4. 最后做控制台界面。

先做改密码的好处：它不依赖 role，做完就能用；`admin`/`admin` 这个账号正好是第一个测试对象——改密码做完，密码这一半就完成了。

## 用户名

- [ ] 比较时转小写，判重按小写来；**存的是用户输入的原样**（去掉首尾空格）。
- [ ] 用户名里含 `admin`（不分大小写）就拒绝：「您不能以该用户名创建账户」。
- [ ] 已被占用：「抱歉，该用户名已被使用，请换一个吧」。
- [ ] 检查顺序：先查禁用词，再查重复。
- [ ] 字符集限制 `[A-Za-z0-9_]{3,32}`。

数据库要跟上：现在的 `UNIQUE (username)` 比的是原样字符串，挡不住 `TEST01` 和 `test01`。两条路选一条：

- 函数唯一索引：`CREATE UNIQUE INDEX ... ON account (lower(username))`；
- 或者加一列 `username_key` 存小写值，unique 建在它上面。

登录时的查询也要改成按小写比（[server/src/server/app.py](../server/src/server/app.py) 里现在是 `Account.username == username`）。

## 注册

- [ ] `POST /api/register`：用户名 + 密码 + 再输一次密码。
- [ ] 后端收 `password` 和 `password_confirm` 两个字段，自己比一次。
- [ ] 密码规则：长度 8–128；带首尾空格直接拒绝（不 trim）；不能包含用户名。
- [ ] 系统预设的初始口令豁免这些规则（`admin`/`admin`，以后控制台生成的初始密码也算）。
- [ ] 注册成功直接签发登录 cookie，自动进聊天页。
- [ ] 界面：登录页加「注册」入口，前端实时校验两次密码一致 + 强度检测器。

强度检测器：长度分档 + 字符多样性 + 常见模式（连续字符、重复字符、包含用户名），4 档标签（太弱 / 弱 / 一般 / 强）。

**分工**：前端是提示，后端是门槛。两边的硬门槛（长度、首尾空格、不能包含用户名）必须一字不差；强度评分只是建议，不拿它拦人。

## 修改密码（第一个做的）

- [ ] 后端加 `POST /api/password`：旧密码 + 新密码 + 确认新密码。
- [ ] 校验旧密码（`_password_matches` 已经有了）。
- [ ] 写新 hash。
- [ ] 吊销这个账号其它设备的登录 token；当前设备也踢掉，重新登录。
- [ ] 改密码这条路径也限流。
- [ ] 设置弹窗里加「修改密码」：[src/components/settings/SettingsModal.tsx](../src/components/settings/SettingsModal.tsx)。

## 强制改密码

- [ ] `account` 加 `must_change_password` 列（init.py 里补，跟 `_ensure_avatar_column` 一个写法）。
- [ ] 登录时为真就跳改密码页。
- [ ] 后端兜底：除 `/api/profile` 和改密接口外，其余聊天接口返回 403「请先修改密码」。

## 共用的密码方法

后端抽一个 `server/src/server/passwords.py`：

- [ ] `hash_password(password)`
- [ ] `verify_password(stored_hash, password)`
- [ ] `needs_rehash(stored_hash)`
- [ ] `generate_password(length)`
- [ ] `check_password_policy(password, username)` —— 返回一句中文提示

前端也抽一个：强度检测器一个模块 + 一个组件，注册和改密两个表单复用。

## 后端错误信息

- [ ] 所有错误都返回 `{"detail": "中文句子"}`。
- [ ] 不要用 Pydantic 的 `Field(min_length=...)` 来报密码规则：422 的 detail 是数组，前端读不出字符串，会显示成「无法连接到服务器」（[src/api/http.ts](../src/api/http.ts)、[src/api/failure.ts](../src/api/failure.ts)）。
- [ ] 改密接口不要把请求体写进日志（`/api/chat` 那样写日志是反面例子）。

## role

- [ ] `account` 加 `role` 列，取值 `chat`（只能进聊天页）和 `admin`（只能进控制台）。没有第三种。
- [ ] 登录先验密码再判 role：密码不对一律回「用户名或密码不正确」；密码对了但 role 不对，回 403 说明这个账号不能进这一边。
- [ ] role 的判断放在 `_account_from_cookie` 那一层（[server/src/server/app.py](../server/src/server/app.py)）：聊天接口只认 `chat`，`/api/admin/*` 只认 `admin`。

## 控制台

- [ ] 独立入口：`/admin/` 独立页面、`admin_login` 独立 cookie、`/api/admin/*` 前缀。聊天页不留任何入口痕迹，地址只出现在内部文档里。
- [ ] 建号：「建议以 test 开头」只是提示，不强制。
- [ ] 禁用词规则只管聊天侧注册；控制台管理员账号由 init.py 建，不走注册。
- [ ] 重置密码弹窗：只显示一次，右侧有复制按钮，三行大字；点背景不能关掉（现有的 Modal 点背景会关，[src/components/shell/Modal.tsx](../src/components/shell/Modal.tsx)）；关闭后无法再查看。
- [ ] 重置密码同时做三件事：改哈希、吊销这个账号已有的 token、置 `must_change_password`。
- [ ] 控制台管理员账号：新建、随机密码打印一次、附一条重置命令。
- [ ] 待定：控制台管到哪一层（只管账号，还是也能看会话内容）；管理员账号叫什么、几个。

## 基础安全

- [ ] 登录失败限流：账号和 IP 两个维度，退避锁定，计数放 Redis（Redis 挂了放行并记一条警告）。
- [ ] 停用账号：`disabled` 列，登录时给明确提示，不跟「密码错」混成一句。
- [ ] 改密码后吊销该账号其它设备的 token。
- [ ] 审计表 `audit_log`：登录成功、登录失败、注册、改密码、停用启用、建账号、重置密码。里面绝不能出现密码。失败明细留 30 天。

## 会话状态通道

「改密码或被禁用之后，客户端要立刻知道并刷新状态，不能等用户输入、发送之后才发现。」
这是这块最核心的一条，做法是给客户端一条常驻的通道。

三层，各管一段：

| 层 | 干什么 | 延迟 |
|---|---|---|
| 推：`GET /api/events` | 服务器一有变化就推给客户端 | 毫秒级 |
| 轮询兜底：现有的 30 秒 `/api/status` | 推的通道断了时兜底（要改成带鉴权） | ≤30 秒 |
| 发送前预检 | 点发送先打一个轻量鉴权请求 | 0 |

前两层满足「即时知道」；第三层保证万一前两层都没赶上，那条消息也不会丢。

### 通道的协议

复用 SSE，不是 WebSocket：方向就是服务器 → 客户端，一单向，这个仓库已经在用 SSE 了。

**它传的是状态，不只是事件**：

```
连上 → 服务器立刻发一次当前状态：
 event: state
  data: {"valid": true, "account": "test01"}

之后有变化才推：
  event: state
  data: {"valid": false, "reason": "revoked",  "message": "会话已过期，请重新登录"}
  event: state
  data: {"valid": false, "reason": "disabled", "message": "账号已被停用，请联系管理员"}
```

**连上先发一次状态**这一条最要紧：客户端断线期间错过了推送，重连时立刻补齐。
这就是「刷新状态」——不是客户端去刷新服务器，是服务器把最新状态主动推过来。

### 三个触发点

- **改密码**（自己改或控制台重置）→ 吊销这个账号所有 token → 推 `revoked`
- **账号被禁用** → 推 `disabled`
- **退出登录** → 推 `revoked`（同一浏览器开多个标签页，在一个标签页退出，另一个现在要等下一次请求才发现掉线）

### 服务器这边

- [ ] 一个进程内的事件总线：`account_id → 一组订阅队列`。
  服务器本来就必须单进程跑（见 [CHAT_STREAM_KNOWN_ISSUES.md](CHAT_STREAM_KNOWN_ISSUES.md) 第 12 条），进程内总线够用，不用 Redis pub/sub。
- [ ] 新接口 `GET /api/events`：用 cookie 认证 → 拿到账号 → 注册一条队列 → 保持连接 → 有推送就写出去 → 断开就注销（用 `try/finally`，不然队列会越攒越多）。
- [ ] 每 15 秒发一个心跳注释帧（`: ping`），免得连接被中间的代理当空闲掐掉。
- [ ] 吊销令牌的地方统一走一个函数 `revoke_tokens(account_id, reason)`：删/标记令牌 + 推事件。
  现在吊销散在改密码、控制台重置、退出登录三处；统一之后以后加新的踢人方式不会漏掉推送。

浏览器自带的 `EventSource` 就够用：同一源请求会自动带 cookie，断线自动重连，不用自己写 SSE 解析。

### 客户端这边

- [ ] 多两个状态：`expired`（会话过期）和 `disabled`（账号被停用）。
  收到 `valid: false` → 聊天页**原地保留**，会话列表、正在打的那段字、页面状态全都不动；
  输入框上方挂一条常驻提示，输入框禁用。
- [ ] `expired` 给一个「重新登录」按钮 → 弹登录框（不是把整页换成登录页）→ 登录成功后 `openAccount` 那套照旧重新拉会话列表和用户信息，页面状态原样恢复。
- [ ] `disabled` **不给登录框**：登录了也没用，提示「账号已被停用，请联系管理员」。
- [ ] 事件通道的连接管理：App 起来就连，掉线靠 `EventSource` 自己重连；重连时自动收到一次当前状态，天然完成状态同步。

### 和下一节的关系

下一节讲「过期时别把用户的东西弄丢」，这一节讲「怎么让客户端立刻知道」。
两块要一起做：通道负责通知，丢东西的那些措施负责善后。

## 会话过期时别把用户的东西弄丢

- [ ] 页面加 `expired` 状态：聊天页原地保留，输入框上方提示「会话已过期，请重新登录」+ 一个「重新登录」按钮，登录框弹出来；不清会话列表、不清草稿。（现在的 `enterLogin` 是一把清空，[src/App.tsx](../src/App.tsx)）
- [ ] 发送前预检：点发送先打一个轻量鉴权请求，401 就不发，把草稿保住。
- [ ] 被踢时把输入框里的内容存进 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)），登录成功后放回输入框；主动退出登录要清掉这个缓存。
- [ ] `login_token` 加 `revoked_at`：撤销的时候标记而不是删行，服务器才分得清「令牌不认识 / 被撤销 / 账号被停用」，页面也能给出对应的一句话。
- [ ] 轮询遇到 401 要停下来并解锁输入框（现在只认 404，会每 500 毫秒空转一次，[src/session/poll.ts](../src/session/poll.ts)）。
- [ ] 「账号被停用」是终态：提示「账号已被停用，请联系管理员」，不给登录框（登录了也没用）。
  跟「会话过期」分开，不要混成一个状态。
- [ ] 通知客户端这件事本身走「会话状态通道」那一节；这一节只管善后。

## 数据库要加的

- [ ] `account`：`role`、`must_change_password`、`disabled`、`created_at`
- [ ] `login_token`：`revoked_at`
- [ ] 新表 `audit_log`

每加一列，[server/src/server/db/init.py](../server/src/server/db/init.py) 里补一条（照抄 `_ensure_avatar_column` 的写法），改完跑 `uv run python -m server.db.init`。

## 改名

- [ ] `UPDATE account SET username = 'test01' WHERE username = 'admin';` —— 手工执行一条就行，不用写迁移脚本；这是动真实数据，要先确认。
- [ ] [server/src/server/db/init.py](../server/src/server/db/init.py) 里的 `_INITIAL_USERNAME` / `_INITIAL_PASSWORD` 改成 `test01` / `test01`，否则新装的库还会造一个 `admin` 账号。
- [ ] [README.md](../README.md) 里「初始账号的用户名和密码写在 init.py」那句要改。

## 验收

后端按 [server/AGENTS.md](../server/AGENTS.md)：

```bash
cd server
uv run ruff check .
uv run ruff format --check .
```

前端按 [AGENTS.md](../AGENTS.md)：

```bash
pnpm check
pnpm build
```

浏览器里手点：注册 → 登录 → 改密码 → 用新密码重新登录 → 旧密码登不进去 → 别的设备被踢下线 → 会话过期时正在打的那段字没丢。

仓库里没有自动化测试，这条只能手点。
