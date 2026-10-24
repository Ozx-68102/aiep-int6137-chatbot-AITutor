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
- 语言：TypeScript 7.0.2

## Git

提交说明由 `.githooks/commit-msg` 检查，格式是不带 scope 的 `type: subject`。

克隆本仓库后需要在仓库根目录执行一次：

```bash
bash scripts/setup-hooks.sh
```

该脚本会把本仓库的 `core.hooksPath` 设为 `.githooks`，并给钩子加上执行权限。
