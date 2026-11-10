#!/usr/bin/env bash
# 上传前端产物和后端源码到服务器。
#
# 服务器地址不写在这个文件里：换机器、换 IP 时通过参数或环境变量给出，不用改代码提交。
# 用法：pnpm run deploy <用户@主机>
#       DEPLOY_REMOTE=<用户@主机> pnpm run deploy
# 目标目录默认 /var/www/h2bot，可用 DEPLOY_TARGET 覆盖。
set -euo pipefail

# 命令行参数优先，没有才看环境变量。有的包管理器会把 -- 原样传进来，
# 跳过它再取地址。
if [[ $# -gt 0 && "$1" == "--" ]]; then
  shift
fi
remote="${1:-${DEPLOY_REMOTE:-}}"

target="${DEPLOY_TARGET:-/var/www/h2bot}"

if [[ -z "$remote" ]]; then
  echo "deploy-upload: 没给服务器地址" >&2
  echo "deploy-upload: 用法 pnpm run deploy <用户@主机>，或设环境变量 DEPLOY_REMOTE" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# 前端。*.map 是调试用的源码映射，.DS_Store 是 macOS 的目录属性文件，
# 两个都跟页面无关，生产环境用不上。
echo "deploy-upload: 上传 dist/"
rsync -av \
  --exclude='*.map' \
  --exclude='.DS_Store' \
  dist/ "${remote}:${target}/dist/"

# 后端。只传运行需要的源码、依赖声明和迁移：
#   __pycache__、*.pyc   Python 导入时生成的字节码缓存
#   .venv                本机虚拟环境
#   .ruff_cache 等       代码检查工具的缓存
#   .DS_Store            macOS 的目录属性文件
#   AGENTS.md            写给开发者的说明，运行用不到
# 这些都会在服务器上重新生成或根本不需要，其余全部上传。
echo "deploy-upload: 上传 server/"
rsync -av \
  --exclude='__pycache__/' \
  --exclude='*.pyc' \
  --exclude='.venv/' \
  --exclude='.ruff_cache/' \
  --exclude='.pytest_cache/' \
  --exclude='.mypy_cache/' \
  --exclude='.DS_Store' \
  --exclude='AGENTS.md' \
  server/ "${remote}:${target}/server/"

echo "deploy-upload: 上传完成"
