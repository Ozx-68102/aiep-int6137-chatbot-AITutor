#!/usr/bin/env bash
# 一键跑完全部检查：前端（oxlint + oxfmt --check + tsc --noEmit）加后端（ruff check + ruff format --check）。
# 用法：在仓库里执行 bash scripts/check-all.sh
# 这是 CI（.github/workflows/ci.yml）的本地等价物：CI 里跑的就是这几项，只另加一次前端构建。
# 提交前想全量自查，或者 CI 失败了想在本地复现，都跑这个。
# 所有步骤都只查不改：不会动你的文件，跑完什么样子进来还是什么样子出去。
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

# 工具不在就明说去哪儿装，不硬跑。
if ! command -v pnpm >/dev/null 2>&1; then
  echo "check-all: 没找到 pnpm，装法见 docs/TECH.md 的「包管理」一节" >&2
  exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
  echo "check-all: 没找到 uv，装法见 docs/TECH.md 的「后端」一节" >&2
  exit 1
fi

# 哪一步失败了就说清楚是哪一步，并告诉人怎么修完之后复验。
fail() {
  {
    echo ""
    echo "check-all: 失败在「$1」，上面的输出就是具体原因。"
    echo "check-all: 修完后重新跑 bash scripts/check-all.sh，全部通过为止。"
  } >&2
  exit 1
}

echo "check-all: [1/4] 前端代码规范（pnpm lint，即 oxlint）"
pnpm lint || fail "前端代码规范（pnpm lint）"

echo "check-all: [2/4] 前端格式（pnpm fmt:check，即 oxfmt --check，只查不改）"
pnpm fmt:check || fail "前端格式（pnpm fmt:check）"

echo "check-all: [3/4] 前端类型检查（pnpm exec tsc --noEmit）"
pnpm exec tsc --noEmit || fail "前端类型检查（pnpm exec tsc --noEmit）"

echo "check-all: [4/4] 后端检查（scripts/check-server.sh，即 ruff check + ruff format --check + basedpyright 类型检查）"
bash scripts/check-server.sh || fail "后端检查（scripts/check-server.sh）"

echo "check-all: 全部通过"
