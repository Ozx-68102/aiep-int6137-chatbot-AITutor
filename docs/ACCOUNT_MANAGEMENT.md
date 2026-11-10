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

- [ ] 比较时转小写，判断重复按小写来；**存的是用户输入的原样**（去掉首尾空格）。
- [ ] 用户名里含 `admin`（不分大小写）就拒绝：「您不能以该用户名创建账户」。
- [ ] 已被占用：「抱歉，该用户名已被使用，请换一个吧」。
- [ ] 检查顺序：先查禁用词，再查重复。
- [ ] 字符集限制 `[A-Za-z0-9_]{3,32}`。

数据库要跟上：现在的 `UNIQUE (username)` 比的是原样字符串，挡不住 `TEST01` 和 `test01`。两条路选一条：

- 函数唯一索引：`CREATE UNIQUE INDEX ... ON account (lower(username))`；
- 或者加一列 `username_key` 存小写值，unique 建在它上面。

登录时的查询也要改成按小写比（[server/src/server/app.py](../server/src/server/app.py) 里现在是 `Account.username == username`）。

现状的问题（实测 2026-11-02，本机 PostgreSQL；2026-11-03 从 FINDINGS.md 挪来）：

- **唯一约束只挡一模一样的字符串**：`account.username` 列是 `character varying(64)`、默认排序规则，`'admin' = 'ADMIN'`、`'admin' = 'admin '`（多一个空格）都是 false。也就是说 `admin`、`Admin`、`admin ` 在数据库里是三个不同的账号，`UNIQUE (username)` 挡不住。
- **前端归一化、后端没有**：登录时页面把用户名 `trim()` 了再发（`src/components/login/LoginScreen.tsx`），后端 `_login_account` 直接拿原样去比。真有账号叫 `admin ` 的话，页面永远登不进去：发过去的是 `admin`。以后加注册接口，两边必须用同一套归一化。
- **重名现在会变成 500，不是 409**：插入时违反唯一约束抛 IntegrityError，被 `app.py` 里那个通用异常处理器捕获，返回 `{"detail": "服务器错误"}`。应用层没有先查一遍重复，全靠数据库拦。（现在数据库里两个账号：`test01`/chat 和 `admin`/admin。）

## 注册

学生账号以学校统一发放 + 控制台管理员重置为主通道，自助注册优先级放低（2026-11-03 决定，依据见 [PARENT_PORTAL_PRIVACY.md](PARENT_PORTAL_PRIVACY.md)）。下面的 spec 保留备用。

- [ ] `POST /api/register`：用户名 + 密码 + 再输一次密码。
- [ ] 后端收 `password` 和 `password_confirm` 两个字段，自己比一次。
- [ ] 密码规则：长度按角色分——chat（学生）账号 6–128，admin 账号 8–128（后端 `min_length_for_role`）；不能包含空格（密码只能是连续字符）；只收英文键盘上的字符（不含空格的可打印 ASCII：设密码的输入框静默过滤，不报错，后端同一条门槛）；极弱口令拒绝（`passwords.py` 的静态名单，`123456`、`qwerty` 这类）；不能包含用户名。
- [ ] 系统预设的初始口令豁免这些规则（`admin`/`admin`、`test01`/`test01`，控制台 `generate_password` 生成的重置密码也算）。（2026-11-06 补充：豁免不变，但这些「别人知道/别人给」的密码从此都带「必须改密」标记——预设账号创建时打上标记、控制台重置给目标账号打上标记，下次登录只有改密路径放行，改完清除。机制见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「必须改密标记」节。）
- [ ] 注册成功直接签发登录 cookie，自动进聊天页。
- [ ] 界面：登录页加「注册」入口，前端实时校验两次密码一致 + 强度检测器。

强度检测器：用 zxcvbn-ts（Dropbox zxcvbn 的 TypeScript 移植）——像破解工具那样按字典加模式估猜测次数，不按长度分档（那样会把 8 位的好密码判成「弱」，逼人写更长的，记不住），score 0–4 映射到 4 档标签（太弱 / 弱 / 一般 / 强）。字典用 common（泄露密码榜 + 键盘图）+ en + zh；zh 包是带声调的拼音，匹配不上无声调连写，另补一份约 70 条的拼音常见词自定义字典（实测和依据见 [docs/FINDINGS.md](FINDINGS.md) 2026-11-03 那条）。字典懒加载，打开弹窗才拉，首屏包只多 9 kB。三条显示规则跟后端硬门槛对齐：不足 6 位（学生侧门槛）、含用户名、命中弱口令名单，直接「太弱」。只是建议，不拿它拦人。

**分工**：前端是提示，后端是门槛。两边的硬门槛（按角色的长度、不能有空格、只收 ASCII、弱口令名单、不能包含用户名）必须一字不差；强度评分只是建议，不拿它拦人。

为什么只收连续字符（维护者定的，2026-11-03；从 FINDINGS.md 挪来）：中文密码在桌面的 `type=password` 框里本来就打不出来（输入法不做组合），手机上贴进去、换台电脑就登不进来——等于把自己锁在外面（控制台重置密码 2026-11-03 已经建好）。空格不收之后，NIST 推荐的 passphrase（`correct horse` 那种形态）不可用了；连写形式照样能拿高分（实测 `dinosaurbirthday` → 一般、`bananahorse42` → 强），但全常用词连写会掉档（`correct horse` 强 → `correcthorse` 弱：少了空格分隔，两个高频词的猜测数低）。长而好记的密码从此主要靠生僻选词和长度。zh 强度字典仍然有用——用户实际会输入的「中文密码」本来就是拼音（zxcvbn-ts 拼音字典的实测见 [docs/FINDINGS.md](FINDINGS.md) 2026-11-03 那条）。

## 修改密码（第一个做的）

- [x] 后端加 `POST /api/password`：旧密码 + 新密码 + 确认新密码。
- [x] 校验旧密码（`_password_matches` 已经有了；已收进 `passwords.verify_password`）。
- [x] 写新 hash。
- [x] 吊销这个账号其它设备的登录 token；当前设备也强制下线，重新登录。
- [x] 改密码这条路径也限流。
- [x] 设置弹窗里加「修改密码」入口：[src/components/settings/SettingsModal.tsx](../src/components/settings/SettingsModal.tsx)。
- [x] 表单本身是独立页面，不是弹窗：弹窗点一下背景就关，密码输一半全丢（密码框不进草稿缓存）。页面地址 2026-11-04 起是真实路径，2026-11-08 与强制改密拆开：自助改密走 `/change-pwd`（旧 `/password` 自动重定向过去），强制改密走 `/force-change-pwd`。能刷新、能用浏览器后退；「取消」就是后退、回到进入前的会话，直接贴地址打开时没有可退的历史，直接把路径换掉回聊天。2026-11-03 维护者定的。
- [x] 管理员改自己的密码也走这个端点（认 `admin_login` cookie，门槛按角色取 8 位；控制台里的界面入口是后续批次）。2026-11-03。
- [x] 学生门槛放宽到 6 位：`check_password_policy` 加 `min_length` 关键字参数，`min_length_for_role` 按角色取值；极弱口令静态拒绝名单前后端各一份（改一处必须改两处）。客户端提交前硬门槛与后端消息逐字一致。2026-11-03。

## 强制改密码

- [x] `account` 加 `must_change_password` 列（后端已实施：迁移 `0002_account_must_change_password`——原文记录的「init.py 里补」写法已被「表结构变更一律写迁移文件」的规矩取代，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「令牌表与定时清扫」）。`ProfileResponse` 已返回该字段，登录校验链路（`renew_login_token`）顺带把它带出来。
- [x] 登录时为真就跳改密码页。（2026-11-06 前端已实现：登录响应或资料响应里标记为真就进入强制拦截——只渲染强制改密页，路径守卫把地址按在 `/force-change-pwd`；任何请求收到 403 且 code 为 `must_change_password` 也会经全局保底事件进入同一拦截。改密成功后服务器吊销全部令牌并清 cookie：页面先就地亮「密码已修改，请用新密码重新登录」，随后回「记下的来路」（只记 `/chat/:id`，没有就根路径）就地渲染登录屏，用新密码重新登录——标记已清，拦截解除。2026-11-07 补上：强制页有「放弃本次登录」——放弃这次登录（被标记的登录不算成功，服务器发的只是能到豁免路径的受限会话），尽力作废该会话、回登录页，标记不清除、下次登录仍被拦。2026-11-08 拆分：强制改密与自助改密是两条 URL、两副面孔——标题、说明横幅、退出按钮文案都不同。）
- [x] 后端强制：被标记账号请求豁免清单之外的 `/api/` 路径回 403「请先修改密码」（code `must_change_password`）。实际豁免清单比原设计宽：登录、改密、退出、资料、状态、头像、推送七条（见 `middleware.py`）。聊天侧已强制；控制台一侧（`/api/admin/*`）不强制——维护者永久决定（2026-11-06，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「必须改密标记」的「永久决定」段）。

注记（2026-11-06 更新）：「首次登录强制改密」流程已全链路实施——后端列与中间件 403（上面两条已勾）、前端读取标记并强制拦截（[src/App.tsx](../src/App.tsx) 的拦截分支与 [use-auth-flow.ts](../src/hooks/use-auth-flow.ts) 的路径守卫）、403 保底事件（[src/api/http.ts](../src/api/http.ts)）、修改密码页强制模式（[ChangePasswordPage.tsx](../src/components/settings/ChangePasswordPage.tsx) 的 `forced`）。控制台「修改我的密码」入口同日补上（[ChangeMyPasswordDialog.tsx](../src/components/admin/ChangeMyPasswordDialog.tsx)）：纯自助、不与强制联动（永久决定见上）；修改成功后该账号所有设备下线，回控制台登录界面用新密码重新登录。强制页的「取消」（放弃这次登录、作废受限会话回登录页，标记不清除）2026-11-07 补上（[use-auth-flow.ts](../src/hooks/use-auth-flow.ts) 的 `cancelGatedLogin`）。

## 忘记密码

- [ ] 现阶段不做自助重置：没有邮箱、短信这类验证通道，证明不了「是本人」，开重置入口等于把账号送给猜得出的人（2026-11-03 维护者确认）。
- [x] 正路是控制台的管理员重置（见「控制台」一节）：学生找管理员，管理员重置后给一次性初始密码。（重置接口和界面 2026-11-03 已建）
- [x] `must_change_password` 逼首次登录就改（全链路已实施，见「强制改密码」一节：后端 403 拦截＋前端强制改密页；被标记的登录不算成功，不改完密码不放行，强制页的「取消」放弃这次登录回登录页、标记不清除）。一次性密码不再靠人工督促修改。
- [x] 登录页可以先放一句静态提示（「忘记密码请联系管理员」），不依赖验证通道；加不加、什么时候加，跟控制台一起定。（2026-11-06 已实施：`forgotPasswordHint` 三语「忘记密码？请联系管理员」；同批登录页用户名输入框加 `autoFocus`，学生登录按钮提交中 `aria-busy` ＋ loading spinner，管理员登录按钮同款——[LoginScreen.tsx](../src/components/login/LoginScreen.tsx)、[AdminLoginForm.tsx](../src/components/admin/AdminLoginForm.tsx)）

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
- [x] role 的判断放在 `_account_from_cookie` 那一层（[server/src/server/app.py](../server/src/server/app.py)）：聊天接口只认 `chat`，`/api/admin/*` 只认 `admin`。聊天侧已经全部覆盖；`/api/admin/*` 目前只有 `POST /api/admin/login`（发 `admin_login` cookie），控制台其余接口和界面是顺序第 4 步。

## 控制台

定位（2026-11-03 维护者定）：「家长端 + 超级管理员」结合的平台；当前作业重心在聊天侧，控制台只搭架子。私隐依据与家长端远期清单见 [PARENT_PORTAL_PRIVACY.md](PARENT_PORTAL_PRIVACY.md)。原「待定」两项已决：只管账号层、不看会话内容；管理员账号沿用 `admin`/`admin`，就 1 个（「新建 + 随机密码打印一次」的方案作废，由 init.py 幂等创建）。

架子（2026-11-03 已完成，接口经进程内测试全部通过；界面没浏览器工具，未手动点过）：

- [x] 独立入口：地址 `/admin`（同源单页应用里由 react-router 路由的真实路径）；`admin_login` 独立 cookie；接口 `/api/admin/*` 前缀。聊天页不留任何入口痕迹。
- [x] `GET /api/admin/accounts`：账号列表（username + role，按 username 排序）。
- [x] `POST /api/admin/accounts/reset-password`：`generate_password(10)` 随机密码只回显一次；同一事务里改哈希 + 吊销该账号全部 token；对任何账号可用，含管理员自己。
- [x] `POST /api/admin/logout`。
- [x] 界面（三语）：登录表单、账号表、重置确认、一次性密码面板、退出确认；`/admin` 路径下聊天侧引导流程完全不挂载。

2026-11-06 补充（前端第一批・管理侧栏，[AdminConsole.tsx](../src/components/admin/AdminConsole.tsx)、[NewPasswordPanel.tsx](../src/components/admin/NewPasswordPanel.tsx)）：

- [x] 账号表空态行（`noAccounts` 三语，跨三列居中）。
- [x] 表头手动刷新按钮（`refreshAccounts` 键，lucide `RotateCw`，busy 时 `aria-busy` ＋转圈）：401 带服务器说法回登录表单；其余错误在表格上方一行 `role=alert` 警示。
- [x] 30 秒静默轮询：仅列表视图打开（即已登录）时跑；`document.hidden`、任何对话框/面板开着（退出确认、重置确认、新密码面板，跳过状态在效果里镜像进 `pollSkipRef`）、手动刷新进行中，都跳过这个周期；成功静默整表替换，失败（含 401）静默——登录态真过期了，由管理员下一次显式操作处理。分页未做，代码注释记「账号数上百再考虑后端分页」。
- [x] 重置密码面板精修（原列在「后续批次」）：密码行右侧复制按钮（clipboard 失败静默，面板 `select-all` 仍可手动选中；「已复制」2 秒复位，`copy`/`copied` 键复用）；点背景、按 Esc 都不关——给 Modal 传 no-op `onClose` 占位，面板的显式关闭按钮直接调用真 `onClose`（Modal 自身的「点背景关」没改，其余弹窗不受影响）。

后续批次（未排期）：

- [ ] 创建账号界面：「建议以 test 开头」只是提示，不强制。（本轮决定创建账号维持现状——init.py 预设 + 数据操作，界面等有需要再做）
- [ ] 禁用词规则只管聊天侧注册；控制台管理员账号由 init.py 建，不走注册。
- [x] 重置密码弹窗精修：三行大字、右侧复制按钮、点背景不能关（现有的 Modal 点背景会关，[src/components/shell/Modal.tsx](../src/components/shell/Modal.tsx)）；关闭后无法再查看。架子是简版面板。（2026-11-06：复制按钮与「点背景/Esc 不关」已实施，做法见上文补充）
- [x] 重置密码时置 `must_change_password`（2026-11-06 已实施：控制台重置在同一事务里给目标账号打标记；前端消费也已实施，见「强制改密码」一节）。
- [x] 管理员在控制台改自己密码的界面入口（2026-11-06 已实施：控制台「修改我的密码」对话框 [ChangeMyPasswordDialog.tsx](../src/components/admin/ChangeMyPasswordDialog.tsx)，纯自助、不与强制改密联动；后端 `/api/password` 已认 `admin_login`）。

## 头像

（前端行为与 wire 修复记录，2026-11-06 完成；上传端点 `POST /api/avatar` 与 `account.avatar` 列的存储结构此前已有，本节不重复。）

- **客户端预检**（[AvatarPicker.tsx](../src/components/settings/AvatarPicker.tsx)）：选文件当场拦下明显不合格的，省一次白费的上传——大小 ≤ 5MB；类型 PNG/JPG/JPEG/HEIC/HEIF，MIME 认全族（单图 `image/heic`、`image/heif` 与多帧 `image/heic-sequence`、`image/heif-sequence`；部分浏览器对 `.heic` 报空 `file.type`，退回按扩展名 png/jpg/jpeg/heic/heif 判）。不合格当场 `role=alert` 提示（`avatarTooLarge` / `avatarWrongType`，三语齐）、不发请求。服务端校验仍是权威——预检是提示不是门槛（与本文件「分工」原则一致）。
- **头像数据缓存**（[profile-cache.ts](../src/session/profile-cache.ts)）：独立键 `h2bot-avatar` 存 `{url, dataUrl}`——`parseProfile` 拿到非默认头像 URL 即 fire-and-forget 抓取转 dataURL 写入（>5MB 跳过；离线、抓取失败、配额超限都静默降级，界面退回默认头像，不弹提示）。App 的 `avatarUrl` 惰性初始化读缓存，离线启动侧栏和设置弹窗显示本人头像、不闪默认图；退出登录随 `h2bot-profile` 一起清（`clearCachedProfile`）。键与 `h2bot-profile` 分开：dataURL 可能几 MB，混存会因超配额连用户名带语言一起写不进去。
- **wire 字段修复**（2026-11-06）：后端 `ProfileResponse` 发的是 `avatar_url`（snake_case，不像 `ChatRequest` 那批请求模型带 camelCase 别名），前端 `parseProfile` 自 2026-11-02 引入起误读 `value.avatarUrl`——真头像永远退回默认图，离线头像缓存也从未生效；已改为读 `value.avatar_url`（[profile.ts](../src/api/profile.ts)，代码注释记录了原委）。全前端其余解析器（session/partial/messages/status）与请求/响应体核对过，没有第二处字段错位。
- **服务器端的缓存协商**（`routes/profile.py` 的 `GET /api/avatar`）：响应带 ETag（图片字节 sha256 的前 16 位）和 `Cache-Control: private, max-age=86400`。浏览器带 `If-None-Match` 请求头再来问时，`_etag_matches` 做比对——去掉弱校验前缀 `W/` 和引号后逐值比（逗号分隔的多个值逐个看，`*` 按 HTTP 语义匹配任何当前表示），图没变就回 304、不重发图片。资料响应里的 `avatar_url` 也带 `?v=` 同一个哈希值，换图即换地址，和浏览器缓存两层互补。

## 基础安全

- [x] 登录失败限流：账号和 IP 两个维度，达到阈值锁定（15 分钟窗口），计数放 Redis（Redis 不通时放行并记一条警告）。（已实施：登录与改密两条路径都接上了，共用同一个 IP 桶；参数与计数语义详见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)。）
- [ ] 停用账号：`disabled` 列，登录时给明确提示，不跟「密码错」混成一句。
- [x] 改密码后吊销该账号其它设备的 token。
- [ ] 审计表 `audit_log`：登录成功、登录失败、注册、改密码、停用启用、建账号、重置密码。里面绝不能出现密码。失败明细留 30 天。

## 会话状态通道

「改密码或被禁用之后，客户端要立刻知道并刷新状态，不能等用户输入、发送之后才发现。」这是这块最核心的一条，做法是给客户端一条常驻的通道。

> **2026-11-05：最小 HTTP 版已实现**（本节的推送通道仍未做）：会话类 401 的响应体在 `detail` 之外多带一个 `reason` 字段，词表 `expired`（带了 cookie 但令牌不认识/已过期/被吊销，无法也无需细分）/ `disabled`（账号被停用——`account.disabled` 列还没建，后端暂时发不出这个值，前端已按词表接好）。没带 cookie 的匿名请求不算会话类，401 维持现状（不带 reason）。前端收到带 reason 的 401 时聊天页在原页面保留：会话、消息、草稿、profile 缓存都不动，输入区禁用、输入区上方挂常驻警示条；`expired` 给「重新登录」按钮，在原页面弹出 Modal 里的 LoginScreen，成功后走 `openAccount` 在原页面恢复；`disabled` 不给登录按钮。没有 reason 的 401（旧后端）回退旧的整页登录路径。下面的轮询保底处理和发送前预检仍未做。

> **2026-11-06：后端推送通道已实现**（`GET /api/events`；进程内总线 `pushbus.py` ＋ 三个触发点：定时清扫扫掉过期令牌→`expired`、改密吊销→`password_changed`、控制台重置吊销→`admin_reset`）。协议按本节设计稿：`state` 命名事件、`{valid, reason, message}` 信封、连上先发一次状态、断线重连自然补齐。与设计稿的出入：reason 由单一 `revoked` 细化成上面三个词（`expired` 与会话类 401 的 reason 同词，前端可当一套词表用）；`disabled` 仍发不出（列没建，缺口同前）；**退出登录改为不推送**（用户自己的动作；跨标签退出感知已由前端 localStorage 标记承担，见 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「已知限制」）；推完 `valid:false` 服务器主动关流，客户端重新登录后新建连接而不依赖自动重连。前端已于同日接上（`src/session/push-channel.ts`：登录后建连，失效帧进入与带 reason 的 401 同一套「留在原页面的过期状态」，重新登录后新建连接、不做手动重连；接线在 `src/hooks/use-auth-flow.ts`）；完整对接契约在 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](LOGIN_SESSIONS_AND_RATE_LIMITING.md)「推送通道 `/api/events`」一节。

三层，各管一段：

| 层                                   | 干什么                             | 延迟   |
|--------------------------------------|------------------------------------|--------|
| 推：`GET /api/events`                | 服务器一有变化就推给客户端         | 毫秒级 |
| 轮询保底处理：现有的 30 秒 `/api/status` | 推的通道断了时保底处理（要改成带鉴权） | ≤30 秒 |
| 发送前预检                           | 点发送先发一个轻量鉴权请求         | 0      |

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

- [x] 一个进程内的事件总线：`account_id → 一组订阅队列`。服务器本来就必须单进程跑（见 [CHAT_STREAM_PROTOCOL.md](CHAT_STREAM_PROTOCOL.md)「单进程前提」一节），进程内总线够用，不用 Redis pub/sub。（2026-11-06 后端已实现：`server/src/server/pushbus.py`，订阅队列有界 32、关停哨兵一定送达）
- [x] 新接口 `GET /api/events`：用 cookie 认证 → 拿到账号 → 注册一条队列 → 保持连接 → 有推送就写出去 → 断开就注销（用 `try/finally`，不然队列会越积越多）。（2026-11-06 后端已实现：`server/src/server/routes/events.py`；2026-11-06 前端已接：`src/session/push-channel.ts`）
- [x] 每 15 秒发一个心跳注释帧（`: ping`），免得连接被中间的代理当空闲切断。（2026-11-06 后端已实现：`routes/events.py` 的 `_HEARTBEAT_SECONDS = 15.0`，15 秒没有动静就发一帧）
- [ ] 吊销令牌的地方统一走一个函数 `revoke_tokens(account_id, reason)`：删/标记令牌 + 推事件。现在吊销散在改密码、控制台重置、退出登录三处；统一之后以后加新的强制下线方式不会漏掉推送。

浏览器自带的 `EventSource` 就够用：同一源请求会自动带 cookie，断线自动重连，不用自己写 SSE 解析。

### 客户端这边

- [x] 多两个状态：`expired`（会话过期）和 `disabled`（账号被停用）。收到 `valid: false` → 聊天页**在原页面保留**，会话列表、正在打的那段字、页面状态全都不动；输入框上方挂一条常驻提示，输入框禁用。（2026-11-05 的最小 HTTP 版已实现这个状态（带 reason 的 401 触发）；2026-11-06 推送通道接上，`valid:false` 帧实时进入同一状态。reason 词表扩为 `expired`/`password_changed`/`admin_reset`，不认识的词保守按失效处理、横幅文案直接用帧里的 `message`。）
- [x] `expired` 给一个「重新登录」按钮 → 弹登录框（不是把整页换成登录页）→ 登录成功后 `openAccount` 那套照旧重新拉会话列表和用户信息，页面状态原样恢复。（已实现：`logInAgain` 按钮与在原页面重新登录的弹窗俱在；`password_changed`/`admin_reset` 的失效帧走同一按钮同一流程。）
- [x] `disabled` **不给登录框**：登录了也没用，提示「账号已被停用，请联系管理员」。（红色终态提示已实现；这个 reason 本身后端暂时还发不出——`account.disabled` 列没建，前端已按词表接好。）
- [x] 事件通道的连接管理：App 起来就连，掉线靠 `EventSource` 自己重连；重连时自动收到一次当前状态，天然完成状态同步。（2026-11-06 已实现，与设计稿有两处小出入：连接在登录后建立而非 App 起来就连（未登录连上去也是 401）；失效帧后服务器关流，重连吃 401 彻底停止属预期，不做手动重连、重新登录后新建一条。断线重连成功时首帧 `valid:true` 天然补齐状态，与设计一致。）

### 和下一节的关系

下一节讲「过期时别把用户的数据丢失」，这一节讲「怎么让客户端立刻知道」。两块要一起做：通道负责通知，防丢失的那些措施负责善后。

## 会话过期时别把用户的数据丢失

- [x] 页面加 `expired` 状态：聊天页在原页面保留，输入框上方提示「会话已过期，请重新登录」+ 一个「重新登录」按钮，登录框弹出来；不清会话列表、不清草稿。（现在的 `enterLogin` 是一次性清空，[src/hooks/use-auth-flow.ts](../src/hooks/use-auth-flow.ts)）（2026-11-05 已实现最小 HTTP 版：401 带 `reason` 进入留在原页面的过期状态；2026-11-06 推送通道接上后，服务器侧失效也实时进入同一状态；`enterLogin` 保留给主动退出和不带 reason 的 401 保底处理。见「会话状态通道」一节的注记）
- [ ] 发送前预检：点发送先发一个轻量鉴权请求，401 就不发，把草稿保住。
- [x] 被强制下线时把输入框里的内容存进 `h2bot-unsent`（[src/session/unsent.ts](../src/session/unsent.ts)），登录成功后放回输入框；主动退出登录要清掉这个缓存。（commit 6da0b34）
- [ ] `login_token` 加 `revoked_at`：撤销的时候标记而不是删行，服务器才分得清「令牌不认识 / 被撤销 / 账号被停用」，页面也能给出对应的一句话。
- [x] 轮询遇到 401 要停下来并解锁输入框（原来只认 404，会每 500 毫秒空转一次，[src/session/poll.ts](../src/session/poll.ts)）。（commit 04984de）
- [ ] 「账号被停用」是终态：提示「账号已被停用，请联系管理员」，不给登录框（登录了也没用）。跟「会话过期」分开，不要混成一个状态。（2026-11-05：前端这半已按此实现并进了 `reason` 词表；`disabled` 列没建，后端暂时发不出这个 reason，整条等「数据库要加的」完成）
- [ ] 通知客户端这件事本身走「会话状态通道」那一节；这一节只管善后。

## 数据库要加的

- [ ] `account`：`role`（已加，2026-11-03）、`must_change_password`（已加，迁移 0002，2026-11-06 核实）、`disabled`、`created_at`
- [ ] `login_token`：`revoked_at`
- [ ] 新表 `audit_log`

表结构变更（加列、加索引、改约束）一律写成迁移文件，不再往 `db/init.py` 里加 `_ensure_*_column` 那种手写字段补丁；规矩和命令见 [server/AGENTS.md](../server/AGENTS.md)「迁移」一节。（`uv run python -m server.db.init` 继续负责新数据库的建表和初始账号，不给已有的表补新列。）

## 改名

- [x] `UPDATE account SET username = 'test01' WHERE username = 'admin';` —— 2026-11-03 执行（维护者确认过）：密码同时重设为 `test01`；账号 id 不变，历史会话原样跟着走；另插入控制台账号 `admin`/`admin`（role=admin，带 zh-CN 语言设置）。
- [x] [server/src/server/db/init.py](../server/src/server/db/init.py) 里的 `_INITIAL_USERNAME` / `_INITIAL_PASSWORD` 改成 `test01` / `test01`；另加 `_ensure_console_admin`：数据库里没有任何 admin 角色账号时幂等创建 `admin`/`admin`。（2026-11-06 起两个预设账号创建时都带「必须改密」标记，首次登录强制换密；已存在的账号不追溯。）
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

浏览器里手动点一遍：注册 → 登录 → 改密码 → 用新密码重新登录 → 旧密码登不进去 → 别的设备被强制下线 → 会话过期时正在打的那段字没丢。控制台：开 `/admin` → `admin`/`admin` 登录 → 账号列表 → 重置某账号密码 → 一次性密码面板 → 旧密码失效新密码生效 → 退出登录；以及聊天页和 `/admin` 之间前进后退。（2026-11-03 这批没有浏览器工具，控制台界面和路由未手动点过，接口已用进程内测试验过。）

仓库里没有自动化测试，这条只能手动点一遍。
