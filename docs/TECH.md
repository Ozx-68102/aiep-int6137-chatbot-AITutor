# TECH

该文档用于记录本项目所使用的技术栈。

## 运行时

| 工具    | 版本    | 说明                             |
|---------|---------|----------------------------------|
| nvm     | 0.40.7  | 多Node版本管理器                 |
| Node.js | 22.23.2 | nvm 的 `default`，别名 `lts/jod` |
| npm     | 12.0.2  | Node 自带包管理器                |
| pnpm    | 12.4.1  | 包管理器，安装方式见下一节       |

注意：Node 22 的维护期到 2027 年 4 月。

## 包管理

本项目建议优先使用 pnpm。安装命令如下：

```bash
npm install -g pnpm
```


## 前端

- 构建：Vite 8.3.5，插件 @vitejs/plugin-react 6.1.2
- UI：React 19.3.1、react-dom 19.3.1
- 图标：lucide-react 1.61.0
- 样式：Tailwind CSS 4.3.3，插件 @tailwindcss/vite 4.3.3
- 动画：tw-animate-css 1.4.0
- 语言：TypeScript 7.0.2

## 后端

命令在 `server/` 里用 `uv run`，不要直接用 `python` 或 `pip`。各库目前装上的版本：

- 语言：Python 3.13。包管理：uv 0.12.13
- Web：FastAPI 0.162.0，进程用 uvicorn 0.54.0 拉起，只听本机 3001。访问 FastGPT 只用 httpx2 2.16.0 的异步客户端
- 数据库：PostgreSQL 18.6（Homebrew）。驱动 psycopg 3.3.6，ORM SQLAlchemy 2.1.6
- 配置：Pydantic 2.14.1，pydantic-settings 2.16.1
- 密码：argon2-cffi 25.1.0（Argon2id）
- 半截回答：Redis 服务器 8.10.2（Homebrew）。Python 库 redis 8.1.0
- 检查：ruff 0.17.2

页面怎么调用见 [前端对接.md](./前端对接.md)。

## 环境变量

FastGPT 的访问地址、API 密钥和应用 ID，PostgreSQL 和 Redis 的连接信息，以及 `DEBUG`，写在仓库根目录的 `.env`。这个文件已被忽略，不会提交。`.env.example` 只说明每一项该填什么。

变量名不要以 `VITE_` 开头。Vite 会把 `VITE_` 开头的变量放进浏览器能下载到的页面里，密钥就会暴露。这些项只给服务端读取，页面代码不要读。服务端在 `server/src/server/settings.py` 读取仓库根目录的 `.env`。

## Git

提交说明由 `.githooks/commit-msg` 检查，格式是不带 scope 的 `type: subject`。

克隆本仓库后需要在仓库根目录执行一次：

```bash
bash scripts/setup-hooks.sh
```

该脚本会把本仓库的 `core.hooksPath` 设为 `.githooks`，并给钩子加上执行权限。
