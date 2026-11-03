# 账号管理

登录这块的待办：注册、修改密码、管理员后台。

这份文件只讲账号和登录两件事。

## 顺序

1. 先做「修改密码」。（已完成）
2. 再加 role 列，登录按 role 分流（聊天页和控制台两个登录接口、两个 cookie）。（已完成）
3. 再把旧的 `admin` 账号改名成 `test01`。（已完成，2026-11-03：用户名和密码都改成 `test01`，另建控制台账号 `admin`/`admin`，见「改名」一节）
4. 最后做控制台界面。（架子已完成，2026-11-03：登录、账号列表、重置密码、退出；定位与家长端远期见 [PARENT_PORTAL_PRIVACY.md](PARENT_PORTAL_PRIVACY.md)）

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

现状的坑（实测 2026-11-02，本机 PostgreSQL；2026-11-03 从 FINDINGS.md 挪来）：

- **唯一约束只挡一模一样的字符串**：`account.username` 列是 `character varying(64)`、默认排序规则，`'admin' = 'ADMIN'`、`'admin' = 'admin '`（多一个空格）都是 false。也就是说 `admin`、`Admin`、`admin ` 在库里是三个不同的账号，`UNIQUE (username)` 挡不住。
- **前端归一化、后端没有**：登录时页面把用户名 `trim()` 了再发（`src/components/login/LoginScreen.tsx`），后端 `_login_account` 直接拿原样去比。真有账号叫 `admin ` 的话，页面永远登不进去：发过去的是 `admin`。以后加注册接口，两边必须用同一套归一化。
- **撞名现在会变成 500，不是 409**：插入时违反唯一约束抛 IntegrityError，被 `app.py` 里那个通用异常处理器接住，返回 `{"detail": "服务器错误"}`。应用层没有先查一遍重复，全靠数据库拦。（现在库里两个账号：`test01`/chat 和 `admin`/admin。）

## 注册

学生账号以学校统一发放 + 控制台管理员重置为主通道，自助注册优先级放低（2026-11-03 决定，依据见 [PARENT_PORTAL_PRIVACY.md](PARENT_PORTAL_PRIVACY.md)）。下面的 spec 保留备用。

- [ ] `POST /api/register`：用户名 + 密码 + 再输一次密码。
- [ ] 后端收 `password` 和 `password_confirm` 两个字段，自己比一次。
- [ ] 密码规则：长度按角色分——chat（学生）账号 6–128，admin 账号 8–128（后端 `min_length_for_role`）；不能包含空格（密码只能是连续字符）；只收英文键盘上的字符（不含空格的可打印 ASCII：设密码的输入框静默过滤，不报错，后端同一条门槛）；极弱口令拒绝（`passwords.py` 的静态名单，`123456`、`qwerty` 这类）；不能包含用户名。
- [ ] 系统预设的初始口令豁免这些规则（`admin`/`admin`、`test01`/`test01`，控制台 `generate_password` 生成的重置密码也算）。
- [ ] 注册成功直接签发登录 cookie，自动进聊天页。
- [ ] 界面：登录页加「注册」入口，前端实时校验两次密码一致 + 强度检测器。

强度检测器：用 zxcvbn-ts（Dropbox zxcvbn 的 TypeScript 移植）——像破解工具那样按字典加模式估猜测次数，不按长度分档（那样会把 8 位的好密码判成「弱」，逼人写更长的，记不住），score 0–4 映射到 4 档标签（太弱 / 弱 / 一般 / 强）。字典用 common（泄露密码榜 + 键盘图）+ en + zh；zh 包是带声调的拼音，匹配不上无声调连写，另补一份约 70 条的拼音常见词自定义字典（实测和依据见 [docs/FINDINGS.md](FINDINGS.md) 2026-11-03 那条）。字典懒加载，打开弹窗才拉，首屏包只多 9 kB。三条显示规则跟后端硬门槛对齐：不足 6 位（学生侧门槛）、含用户名、命中弱口令名单，直接「太弱」。只是建议，不拿它拦人。

**分工**：前端是提示，后端是门槛。两边的硬门槛（按角色的长度、不能有空格、只收 ASCII、弱口令名单、不能包含用户名）必须一字不差；强度评分只是建议，不拿它拦人。

为什么只收连续字符（维护者定的，2026-11-03；从 FINDINGS.md 挪来）：中文密码在桌面的 `type=password` 框里本来就打不出来（输入法不做组合），手机上贴进去、换台电脑就登不进来——等于把自己锁在外面（控制台重置密码 2026-11-03 已经建好）。空格不收之后，NIST 推荐的 passphrase（`correct horse` 那种形态）不可用了；连写形式照样能拿高分（实测 `dinosaurbirthday` → 一般、`bananahorse42` → 强），但全常用词连写会掉档（`correct horse` 强 → `correcthorse` 弱：少了空格分隔，两个高频词的猜测数低）。长而好记的密码从此主要靠生僻选词和长度。zh 强度字典仍然有用——用户实际会输入的「中文密码」本来就是拼音（zxcvbn-ts 拼音字典的实测见 [docs/FINDINGS.md](FINDINGS.md) 2026-11-03 那条）。

## 修改密码（第一个做的）

- [x] 后端加 `POST /api/password`：旧密码 + 新密码 + 确认新密码。
- [x] 校验旧密码（`_password_matches` 已经有了；已收进 `passwords.verify_password`）。
- [x] 写新 hash。
- [x] 吊销这个账号其它设备的登录 token；当前设备也踢掉，重新登录。
- [x] 改密码这条路径也限流。
- [x] 设置弹窗里加「修改密码」入口：[src/components/settings/SettingsModal.tsx](../src/components/settings/SettingsModal.tsx)。
- [x] 表单本身是独立页面，不是弹窗：弹窗点一下背景就关，密码输一半全丢（密码框不进草稿缓存）。页面地址带 `?page=password`（原有的 `session` 参数保留），能刷新、能用浏览器后退；「取消」就是后退，直接贴地址打开时没有可退的历史，就地换掉参数回聊天。2026-11-03 维护者定的。
- [x] 管理员改自己的密码也走这个端点（认 `admin_login` cookie，门槛按角色取 8 位；控制台里的界面入口是后续批次）。2026-11-03。
- [x] 学生门槛放宽到 6 位：`check_password_policy` 加 `min_length` 关键字参数，`min_length_for_role` 按角色取值；极弱口令静态拒绝名单前后端各一份（改一处必须改两处）。客户端提交前硬门槛与后端消息逐字一致。2026-11-03。

## 强制改密码

- [ ] `account` 加 `must_change_password` 列（init.py 里补，跟 `_ensure_avatar_column` 一个写法）。
- [ ] 登录时为真就跳改密码页。
- [ ] 后端兜底：除 `/api/profile` 和改密接口外，其余聊天接口返回 403「请先修改密码」。

## 忘记密码

- [ ] 现阶段不做自助重置：没有邮箱、短信这类验证通道，证明不了「是本人」，开重置入口等于把账号送给猜得出的人（2026-11-03 维护者确认）。
- [x] 正路是控制台的管理员重置（见「控制台」一节）：学生找管理员，管理员重置后给一次性初始密码。（重置接口和界面 2026-11-03 已建）
- [ ] `must_change_password` 逼首次登录就改（列还没加，见「强制改密码」一节）；在那之前，一次性密码靠人工督促修改。
- [ ] 登录页可以先放一句静态提示（「忘记密码请联系管理员」），不依赖验证通道；加不加、什么时候加，跟控制台一起定。

## 共用的密码方法

后端抽一个 `server/src/server/passwords.py`：

- [x] `hash_password(password)`
- [x] `verify_password(stored_hash, password)`
- [x] `needs_rehash(stored_hash)`
- [x] `generate_password(length)`
- [x] `check_password_policy(password, username)` —— 返回一句中文提示

前端也抽一个：强度检测器一个模块 + 一个组件，注册和改密两个表单复用。（改密表单已经在用：`src/components/settings/password-strength.ts` + `PasswordStrength.tsx`，注册做好直接复用。）

## 后端错误信息

- [x] 所有错误都返回 `{"detail": "中文句子"}`。（422 也统一成一句中文了，见 [server/src/server/app.py](../server/src/server/app.py) 的 `_validation_error`。）
- [x] 不要用 Pydantic 的 `Field(min_length=...)` 来报密码规则：422 的 detail 是数组，前端读不出字符串，会显示成「无法连接到服务器」（[src/api/http.ts](../src/api/http.ts)、[src/api/failure.ts](../src/api/failure.ts)）。
- [x] 改密接口不要把请求体写进日志（`/api/chat` 那样写日志是反面例子）。

## role

- [x] `account` 加 `role` 列，取值 `chat`（只能进聊天页）和 `admin`（只能进控制台）。没有第三种。数据库加了 `account_role_check` 约束，已有行一律填 `chat`（`init.py` 的 `_ensure_role_column`）。
- [x] 登录先验密码再判 role：密码不对一律回「用户名或密码不正确」；密码对了但 role 不对，回 403 说明这个账号不能进这一边。
- [x] role 的判断放在 `_account_from_cookie` 那一层（[server/src/server/app.py](../server/src/server/app.py)）：聊天接口只认 `chat`，`/api/admin/*` 只认 `admin`。聊天侧已经盖全；`/api/admin/*` 目前只有 `POST /api/admin/login`（发 `admin_login` cookie），控制台其余接口和界面是顺序第 4 步。

## 控制台

定位（2026-11-03 维护者定）：「家长端 + 超级管理员」结合的平台；当前作业重心在聊天侧，控制台只搭架子。私隐依据与家长端远期清单见 [PARENT_PORTAL_PRIVACY.md](PARENT_PORTAL_PRIVACY.md)。原「待定」两项已决：只管账号层、不看会话内容；管理员账号沿用 `admin`/`admin`，就 1 个（「新建 + 随机密码打印一次」的方案作废，由 init.py 幂等创建）。

架子（2026-11-03 已落地，接口经进程内测试全绿；界面没浏览器工具，未手点）：

- [x] 独立入口：地址 `?page=admin`（同源单页应用里的路由，没做 `/admin/` 独立入口）；`admin_login` 独立 cookie；接口 `/api/admin/*` 前缀。聊天页不留任何入口痕迹。
- [x] `GET /api/admin/accounts`：账号列表（username + role，按 username 排序）。
- [x] `POST /api/admin/accounts/reset-password`：`generate_password(10)` 随机密码只回显一次；同一事务里改哈希 + 吊销该账号全部 token；对任何账号可用，含管理员自己。
- [x] `POST /api/admin/logout`。
- [x] 界面（三语）：登录表单、账号表、重置确认、一次性密码面板、退出确认；`page=admin` 时聊天侧引导流程完全不挂载。

后续批次（未排期）：

- [ ] 建号界面：「建议以 test 开头」只是提示，不强制。（本轮决定建号维持现状——init.py 预设 + 数据操作，界面等有需要再做）
- [ ] 禁用词规则只管聊天侧注册；控制台管理员账号由 init.py 建，不走注册。
- [ ] 重置密码弹窗精修：三行大字、右侧复制按钮、点背景不能关（现有的 Modal 点背景会关，[src/components/shell/Modal.tsx](../src/components/shell/Modal.tsx)）；关闭后无法再查看。架子是简版面板。
- [ ] 重置密码时置 `must_change_password`（列还没加，见「强制改密码」一节）。
- [ ] 管理员在控制台改自己密码的界面入口（后端 `/api/password` 已认 `admin_login`）。

## 基础安全

- [ ] 登录失败限流：账号和 IP 两个维度，退避锁定，计数放 Redis（Redis 挂了放行并记一条警告）。（`ratelimit.py` 已经在了，改密这条路径已接；登录路径还没接。）
- [ ] 停用账号：`disabled` 列，登录时给明确提示，不跟「密码错」混成一句。
- [x] 改密码后吊销该账号其它设备的 token。
- [ ] 审计表 `audit_log`：登录成功、登录失败、注册、改密码、停用启用、建账号、重置密码。里面绝不能出现密码。失败明细留 30 天。

## 会话状态通道

「改密码或被禁用之后，客户端要立刻知道并刷新状态，不能等用户输入、发送之后才发现。」这是这块最核心的一条，做法是给客户端一条常驻的通道。

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

**连上先发一次状态**这一条最要紧：客户端断线期间错过了推送，重连时立刻补齐。这就是「刷新状态」——不是客户端去刷新服务器，是服务器把最新状态主动推过来。

### 三个触发点

- **改密码**（自己改或控制台重置）→ 吊销这个账号所有 token → 推 `revoked`
- **账号被禁用** → 推 `disabled`
- **退出登录** → 推 `revoked`（同一浏览器开多个标签页，在一个标签页退出，另一个现在要等下一次请求才发现掉线）

### 服务器这边

- [ ] 一个进程内的事件总线：`account_id → 一组订阅队列`。服务器本来就必须单进程跑（见 [CHAT_STREAM_KNOWN_ISSUES.md](CHAT_STREAM_KNOWN_ISSUES.md) 第 12 条），进程内总线够用，不用 Redis pub/sub。
- [ ] 新接口 `GET /api/events`：用 cookie 认证 → 拿到账号 → 注册一条队列 → 保持连接 → 有推送就写出去 → 断开就注销（用 `try/finally`，不然队列会越攒越多）。
- [ ] 每 15 秒发一个心跳注释帧（`: ping`），免得连接被中间的代理当空闲掐掉。
- [ ] 吊销令牌的地方统一走一个函数 `revoke_tokens(account_id, reason)`：删/标记令牌 + 推事件。现在吊销散在改密码、控制台重置、退出登录三处；统一之后以后加新的踢人方式不会漏掉推送。

浏览器自带的 `EventSource` 就够用：同一源请求会自动带 cookie，断线自动重连，不用自己写 SSE 解析。

### 客户端这边

- [ ] 多两个状态：`expired`（会话过期）和 `disabled`（账号被停用）。收到 `valid: false` → 聊天页**原地保留**，会话列表、正在打的那段字、页面状态全都不动；输入框上方挂一条常驻提示，输入框禁用。
- [ ] `expired` 给一个「重新登录」按钮 → 弹登录框（不是把整页换成登录页）→ 登录成功后 `openAccount` 那套照旧重新拉会话列表和用户信息，页面状态原样恢复。
- [ ] `disabled` **不给登录框**：登录了也没用，提示「账号已被停用，请联系管理员」。
- [ ] 事件通道的连接管理：App 起来就连，掉线靠 `EventSource` 自己重连；重连时自动收到一次当前状态，天然完成状态同步。

### 和下一节的关系

下一节讲「过期时别把用户的东西弄丢」，这一节讲「怎么让客户端立刻知道」。两块要一起做：通道负责通知，丢东西的那些措施负责善后。

## 会话过期时别把用户的东西弄丢

- [ ] 页面加 `expired` 状态：聊天页原地保留，输入框上方提示「会话已过期，请重新登录」+ 一个「重新登录」按钮，登录框弹出来；不清会话列表、不清草稿。（现在的 `enterLogin` 是一把清空，[src/App.tsx](../src/App.tsx)）
- [ ] 发送前预检：点发送先打一个轻量鉴权请求，401 就不发，把草稿保住。
- [x] 被踢时把输入框里的内容存进 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)），登录成功后放回输入框；主动退出登录要清掉这个缓存。（commit 6da0b34）
- [ ] `login_token` 加 `revoked_at`：撤销的时候标记而不是删行，服务器才分得清「令牌不认识 / 被撤销 / 账号被停用」，页面也能给出对应的一句话。
- [x] 轮询遇到 401 要停下来并解锁输入框（原来只认 404，会每 500 毫秒空转一次，[src/session/poll.ts](../src/session/poll.ts)）。（commit 04984de）
- [ ] 「账号被停用」是终态：提示「账号已被停用，请联系管理员」，不给登录框（登录了也没用）。跟「会话过期」分开，不要混成一个状态。
- [ ] 通知客户端这件事本身走「会话状态通道」那一节；这一节只管善后。

## 数据库要加的

- [ ] `account`：`role`（已加，2026-11-03）、`must_change_password`、`disabled`、`created_at`
- [ ] `login_token`：`revoked_at`
- [ ] 新表 `audit_log`

每加一列，[server/src/server/db/init.py](../server/src/server/db/init.py) 里补一条（照抄 `_ensure_avatar_column` 的写法），改完跑 `uv run python -m server.db.init`。

## 改名

- [x] `UPDATE account SET username = 'test01' WHERE username = 'admin';` —— 2026-11-03 执行（维护者确认过）：密码同时重设为 `test01`；账号 id 不变，历史会话原样跟着走；另插入控制台账号 `admin`/`admin`（role=admin，带 zh-CN 语言设置）。
- [x] [server/src/server/db/init.py](../server/src/server/db/init.py) 里的 `_INITIAL_USERNAME` / `_INITIAL_PASSWORD` 改成 `test01` / `test01`；另加 `_ensure_console_admin`：库里没有任何 admin 角色账号时幂等创建 `admin`/`admin`。
- [x] [README.md](../README.md) 里「初始账号」那句改成两个预设账号的说明。

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

浏览器里手点：注册 → 登录 → 改密码 → 用新密码重新登录 → 旧密码登不进去 → 别的设备被踢下线 → 会话过期时正在打的那段字没丢。控制台：开 `?page=admin` → `admin`/`admin` 登录 → 账号列表 → 重置某账号密码 → 一次性密码面板 → 旧密码失效新密码生效 → 退出登录；以及聊天页和 `?page=admin` 之间前进后退。（2026-11-03 这批没有浏览器工具，控制台界面和路由未手点，接口已用进程内测试验过。）

仓库里没有自动化测试，这条只能手点。
