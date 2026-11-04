# 改进调研（improvement-research）

本文件夹集中存放对本项目前后端的改进调研：可以增加的新功能、可优化的点、未完善的点、潜在问题，以及对应的可行代码方案和所需第三方库。

调研只读代码、不改代码；所有结论都以「建议」形式给出，由维护者决定是否采纳。第三方库一律只点名、不擅自安装（见根目录 AGENTS.md 的守则）。

## 目录

| 文件 | 范围 | 条目数 | 大小 |
| --- | --- | --- | --- |
| frontend-chat.md | 前端聊天主链路：流式收发、消息渲染、回合引擎、会话缓存 | 25（新功能 10 / 优化 6 / 问题 9） | ~50 KB |
| frontend-app.md | 前端应用外壳：路由、侧栏、设置、登录、多语言、管理端、API 层 | 36（新功能 13 / 优化 11 / 问题 12） | ~70 KB |
| backend-api.md | 后端接口：FastAPI 路由、FastGPT 代理、流式转发、回复存储、限流 | 37（新功能 11 / 优化 11 / 问题 15） | ~77 KB |
| backend-infra.md | 后端基建：配置、密码与会话安全、数据库、日志、部署与运维 | 28（安全 11 / 配置运维 10 / 可观测 4 / 部署 3） | ~52 KB |
| dx-tooling.md | 工程化：构建、lint/格式化、类型检查、文档体系、依赖管理 | 28（构建 / 检查 / 依赖 / 文档 / 卫生五节） | ~46 KB |

共 154 条编号发现。五份文档交叉引用了彼此的发现（例如登录端点无限流在前端外壳、后端接口、后端基建三份里从不同视角各有一条），落地时以对应领域的文档为主、其余为佐证。

## 约定

- 每条发现都写明：位置、现状/问题、影响、可行方案（含代码草图）、涉及的第三方库、风险与工作量估计。
- 工作量估计：S（半天内）、M（1~3 天）、L（更大，需要拆分）。
- 本调研基于 main 分支 `1eadc4e8c042` 的代码状态，文中的行号以该快照为准。

> **2026-11-04 进展**：编辑重发（frontend-chat N5）、多行输入（frontend-chat N2）、服务端悬空提问比对修复（backend-api N9，取方案①）已随 [MESSAGE_ACTIONS.md](../MESSAGE_ACTIONS.md) 第一至三期实现，「建议落地顺序」第四批中的这两项由此完成。相关条目保留作调研记录，现状以各条目标题下的备注和 MESSAGE_ACTIONS.md 为准。

## 第三方库结论汇总

全部 154 条里，真正建议引入的新依赖只有两个，且都由维护者决定：

- **alembic**（后端数据库迁移，backend-infra 第 6 条）：现状是 create_all + 手写补列，只进不退无版本。
- **react-syntax-highlighter 或 lowlight**（前端代码高亮，frontend-chat N4，二选一，需动态 import 控制体积）。

其余点名的库要么不需要（slowapi、husky、lint-staged、pnpm catalog），要么绑定前提条件（structlog、sentry-sdk、prometheus-client、@ariakit/react、pg_trgm 扩展、cachetools），要么已在依赖里只是用法要改（redis.asyncio）。

## 建议落地顺序（跨文档汇总）

1. **第一批（全部 S 级、互相独立、不动接口契约）**：聊天区滚动跟随（frontend-chat N1）、流式 rAF 合批（O1）、弱网重试三个洞（P1/P2/P4）、fetch 超时（frontend-app P2）、POST 不盲目重试（三份文档共同指出）、登录端点接现成限流（backend-api P1 / backend-infra 第 1 条）、输入 max_length、avatar 字段 deferred、日志收窄、ruff 加 ASYNC 组、check 并入 tsc。
2. **第二批（安全与部署加固）**：cookie Secure/__Host- + TLS、nginx 完善（client_max_body_size、安全头）、systemd 守护、优雅停机、连接池 pre_ping、绝对会话上限。
3. **第三批（动契约、前后端同批）**：流加 `event: done` 结局事件、GET /api/events 会话状态通道、错误码 + 三语映射、消息分页与搜索。
4. **第四批（产品功能与工程化大件）**：编辑重发、多行输入、侧栏搜索/日期分组、alembic、CI、chunk 拆分、LayerFS main 树卫生清理（敏感文件优先，需维护者动手）。
