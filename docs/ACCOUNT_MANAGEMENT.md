# 账号管理

登录这块的待办：注册、修改密码、管理员后台。

## 注册

- [ ] 后端加 `POST /api/register`：用户名 + 密码 + 确认密码。
- [ ] 建账号时同时建 language_setting，缺了的话 `_profile` 和 `_login_account` 会抛 500。
- [ ] 注册成功直接签发登录 cookie，用户直接进页面，不用再登一次。
- [ ] 用户名先归一化再存、再比：去首尾空格 + 转小写。前端登录时已经 `trim()` 了
  （[src/components/login/LoginScreen.tsx](../src/components/login/LoginScreen.tsx)），后端不归一化的话，
  两边对「用户名是什么」的说法就不一样。
- [ ] 唯一约束只挡完全一样的字符串：库里是 `UNIQUE (username)`，默认区分大小写，
  所以 `admin`、`Admin`、`admin `（多一个空格）是三个不同的账号。归一化之后它们才算撞名，
  撞名回 409 或 400，别让它变成 500。
- [ ] 现在库里只有一个账号：用户名 `admin`、密码 `admin`，写在
  [server/src/server/db/init.py](../server/src/server/db/init.py) 里，也写在 README 上。
  改密码的接口做出来之前，这一对凭据谁都能用。
- [ ] 登录页加「注册」入口：[src/components/login/LoginScreen.tsx](../src/components/login/LoginScreen.tsx) 现在只有登录表单。
- [ ] 新文案在 [src/i18n.ts](../src/i18n.ts) 里三种语言各写一遍。

## 修改密码

- [ ] 后端加 `POST /api/password`：旧密码 + 新密码。
- [ ] 校验旧密码用 `_password_matches`，[server/src/server/app.py](../server/src/server/app.py) 里已经有了。
- [ ] 写新 hash 用同一个 `PasswordHasher`（Argon2id）。
- [ ] 改完撤掉这个账号其它设备的登录 token（删 `login_token` 里这个账号的行，当前这台保留）。
- [ ] 设置弹窗里加「修改密码」：[src/components/settings/SettingsModal.tsx](../src/components/settings/SettingsModal.tsx) 现在是头像、语言、退出登录。
- [ ] 新文案同样三种语言各写一遍。

## 管理员后台

账号管理这一块：列账号、重置别人的密码、停用账号。

- [ ] `account` 表加角色列，或者 `is_admin` 布尔列。
- [ ] [server/src/server/db/init.py](../server/src/server/db/init.py) 照抄 `_ensure_avatar_column` 的写法补这一列，
  初始账号标成管理员。改完跑 `uv run python -m server.db.init`。
- [ ] 管理员接口：列账号、重置别人的密码、停用账号。
- [ ] 管理员界面。项目里没有路由库（`package.json` 里没有 react-router），换页靠 `App.tsx` 里的 `view` 状态。
- [ ] 每个业务接口的权限判定怎么加，先说清楚再动。

## 要注意的

- [ ] 注册接口没有登录态，会被刷号。加个限制，比如同一个 IP 一分钟只能建几个账号。
- [ ] 登录没有失败锁定，密码可以硬试。
- [ ] 后端错误信息是中文，前端按 `lang="zh-Hans"` 显示，照
  [src/components/login/LoginScreen.tsx](../src/components/login/LoginScreen.tsx) 现在的写法。
- [ ] 账号表结构变了要改 [server/src/server/db/init.py](../server/src/server/db/init.py)（它只补缺的列，不改已有数据）。

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

浏览器里点一遍：注册 → 登录 → 改密码 → 用新密码重新登录 → 旧密码登不进去 →
别的设备的登录 token 被撤掉。仓库里没有自动化测试，这条只能手点。
