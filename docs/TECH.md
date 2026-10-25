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

## 环境变量

FastGPT 的访问地址、API 密钥和应用 ID，以及 PostgreSQL 的连接信息，写在仓库根目录的 `.env`。这个文件已被忽略，不会提交。`.env.example` 只说明每一项该填什么。

变量名不要以 `VITE_` 开头。Vite 会把 `VITE_` 开头的变量放进浏览器能下载到的页面里，密钥就会暴露。这些项只给服务端读取，页面代码不要读。

薄代理如何读取上述变量并做流式转发，见 [FASTGPT-PROXY-PROPOSAL.md](./FASTGPT-PROXY-PROPOSAL.md)（提议，代码尚未落地）。

## Git

提交说明由 `.githooks/commit-msg` 检查，格式是不带 scope 的 `type: subject`。

克隆本仓库后需要在仓库根目录执行一次：

```bash
bash scripts/setup-hooks.sh
```

该脚本会把本仓库的 `core.hooksPath` 设为 `.githooks`，并给钩子加上执行权限。
