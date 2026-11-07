# 改进调研（improvement-research）

**定位（2026-11-05 起）**：本文件夹从此是「调研档案 + 未实现 backlog」。已实现的条目不再维护正文：只保留标题、编号和标题下的一条存根注记（一句现状摘要 + 指向 docs/ 根目录的现状文档），调研原文以 LayerFS 历史为准。没实现的条目原地不动——这里是它们唯一的追踪处。条目编号被全仓引用，永久保留，不要因为任何整理而重排。

功能现状描述在 docs/ 根目录：聊天流协议与轮次生命周期 [CHAT_STREAM_PROTOCOL.md](../CHAT_STREAM_PROTOCOL.md)、登录态令牌与限流 [LOGIN_SESSIONS_AND_RATE_LIMITING.md](../LOGIN_SESSIONS_AND_RATE_LIMITING.md)、轮次日志与排查 [TURN_LOGGING_AND_DIAGNOSTICS.md](../TURN_LOGGING_AND_DIAGNOSTICS.md)、聊天页面行为 [CHAT_PAGE_BEHAVIOR.md](../CHAT_PAGE_BEHAVIOR.md)、消息操作区 [MESSAGE_ACTIONS.md](../MESSAGE_ACTIONS.md)。

调研只读代码、不改代码；所有结论都以「建议」形式给出，由维护者决定是否采纳。第三方库一律只点名、不擅自安装（见根目录 AGENTS.md 的守则）。

## 目录

| 文件             | 范围                                                           | 条目数                                          | 大小   |
|------------------|----------------------------------------------------------------|-------------------------------------------------|--------|
| frontend-chat.md | 前端聊天主链路：流式收发、消息渲染、轮次引擎、会话缓存         | 25（新功能 10 / 优化 6 / 问题 9）               | ~50 KB |
| frontend-app.md  | 前端应用外壳：路由、侧栏、设置、登录、多语言、管理端、API 层   | 36（新功能 13 / 优化 11 / 问题 12）             | ~70 KB |
| backend-api.md   | 后端接口：FastAPI 路由、FastGPT 代理、流式转发、回复存储、限流 | 37（新功能 11 / 优化 11 / 问题 15）             | ~77 KB |
| backend-infra.md | 后端基建：配置、密码与会话安全、数据库、日志、部署与运维       | 28（安全 11 / 配置运维 10 / 可观测 4 / 部署 3） | ~52 KB |
| dx-tooling.md    | 工程化：构建、lint/格式化、类型检查、文档体系、依赖管理        | 28（构建 / 检查 / 依赖 / 文档 / 卫生五节）      | ~46 KB |

共 154 条编号发现。五份文档交叉引用了彼此的发现（例如登录端点无限流在前端外壳、后端接口、后端基建三份里从不同视角各有一条），实施时以对应领域的文档为主、其余为佐证。

> **2026-11-05 文档收编**：上表的「条目数 / 大小」是调研时的状态；已实现条目正文已迁出、只留存根，实际文件相应变薄。存根化清单——backend-api N1/N6/N9/O1/O2/O7/O8/O11/P1/P5 与 P2（部分实现：nginx 请求体保底限制留部署日）；backend-infra 第 1/13 条、第 4 条（部分实现：清扫定时化与索引已做，绝对上限经维护者决定否掉，Secure cookie 留部署日）、第 23 条（a 档已实现）；dx-tooling 第 8 条、第 12 条（部分实现：只加了 ASYNC）；frontend-chat N1/N2/N4/N5/N6/N7/N8/O3/O4/O5/O6/P1/P2/P3/P5/P6 与 P9（已随 done 事件批演化）；frontend-app P2、N1（部分实现：最小 HTTP 版已做，推送通道未做）、P9。没实现的条目一律保留原样；frontend-chat O1/O2（渲染合并批次）为搁置条目，已加决定注记。**2026-11-05 第二批补记**：以下条目经当前代码与 LayerFS main 逐条核实后加注——dx-tooling 第 5、26 条（已完成）与第 19 条（部分完成：清理已完成，AGENTS.md 规则成文未做）、frontend-app N8、P1（已完成）、frontend-chat P4（已完成）。**2026-11-05 第三批补记**：后端结构整理（主模块拆子包）结束工作后逐条重验加注——backend-api O6、P15（2026-11-06 更正为如实：进程级历史缓存已退出页面历史主路径但代码保留，无上限字典问题只是触发面缩小、未根除；历史合并主路径按轮次编号对号，「表里没有这一轮」的补提问分支仍按文本比对防重——两处均经维护者决定保留，详见各条注记）、backend-infra 第 15 条（已完成：与 backend-api O1 同事，整理后复验健在）、第 18 条（已完成：单进程前提已成文，server/AGENTS.md 同批补上单 worker 规矩）。第 19、21 条重验后确认原样未变，仍在待办。**2026-11-05 决定记录（维护者逐条批复后成文）**：backend-api P13 退出不幂等——决定不改（前端已接住）；backend-infra 第 22 条日志归档——不自动删，保留归运维，程序只在超阈值时写警告；会话规模化（backend-api N2/N3/O10、frontend-app N2/N3）——暂缓，触发条件已注记各条；backend-api N10 建会话幂等——暂缓；backend-infra 第 24/25 条错误上报与指标——多用户部署后再看。已决定待开始干的后端批次（开始干时随实现记录细节）：异步 Redis、连接池存活检查、崩溃窗口清理、归档阈值警告、上游错误语义、数据库不可用回 503、删会话顺序改「先本地后上游」、失败后 7 秒等待挪进流内、单轮占用改原子抢占、初始口令强制首登改密（管理员重置路径同样打标记）、删除聊天请求里已无用的语言字段、头像 304、应用侧安全头、推送通道、检查自动化工具链。**2026-11-06 前端批次补记**：前端四批（构建与 i18n、对话核心、账号鉴权、管理侧栏、外壳、TS 严格度）完成后逐条加注——frontend-chat N3/N9/N10/P1/P2/P8（已完成）与 P7（关闭）；frontend-app N5/N6/N9/N10/N11/N12/O2/O7/O8/O9/O11/P6/P10/P11/P12（已完成）、P7（部分完成）、N7/N13（决定不做）；dx-tooling 第 1/2/3/27/28 条（已完成）与第 15 条（部分完成：engines 未加）。frontend-chat O1/O2 补记里的「播放待开始干」同步更新为已完成、继续不做。**2026-11-06 第四批补记（后端三批开始干并完成）**：backend-api O3、O4、P3、P4、P6、P7、P8、P12、P16（已完成）与 N5（部分完成：/api/events 后端完成、前端未接）；backend-infra 第 5、14 条（已完成）、第 9 条（部分完成：应用侧三头已发，CSP/HSTS/nginx 侧留部署日）、第 7、22 条（按决定两半都完成）；dx-tooling 第 9、10、11 条（已完成，CI 等首次 push 后实际运行）。现状内容已展开进 docs/ 根目录：CHAT_STREAM_PROTOCOL（守卫/停止/心跳/崩溃窗口/降级/单进程前提诸节）、LOGIN_SESSIONS_AND_RATE_LIMITING（新增「必须改密标记」「推送通道」两节）、ACCOUNT_MANAGEMENT（会话状态通道注记）、TURN_LOGGING_AND_DIAGNOSTICS（归档决定与口径注记）、TECH.md（检查三层与后端结构）、AGENTS.md（沙箱说明更新）、FINDINGS（2026-11-06 Redis ACL 条目）。

## 约定

- 每条发现都写明：位置、现状/问题、影响、可行方案（含代码草图）、涉及的第三方库、风险与工作量估计。
- 工作量估计：S（半天内）、M（1~3 天）、L（更大，需要拆分）。
- 本调研基于 main 分支 `1eadc4e8c042` 的代码状态，文中的行号以该快照为准。

> **2026-11-04 进展**：[MESSAGE_ACTIONS.md](../MESSAGE_ACTIONS.md) 第一至三期已实现——第一期（气泡脚注 MessageActions、`FailedReply` 与 `role:'error'` 合成消息退役、横幅移入聊天区、UI_WARNINGS.md 修订）、第二期（服务端悬空提问比对修复，backend-api N9 方案①）、第三期（编辑重发，frontend-chat N5）与多行输入（frontend-chat N2）。frontend-chat P1/P2/O4 与 frontend-app P9 已相应加注；`EDIT_MESSAGE.md` 已删除并入 MESSAGE_ACTIONS.md，五份文档里的引用已重指。
>
> **行号已变动提醒**：main 已随上述实现前进（快照 `426f221cc9d8`），各文档中标注基线 `1eadc4e8c042` 的行号只作历史参考，引用时以符号名定位。

## 第三方库结论汇总

全部 154 条里，真正建议引入的新依赖只有两个，且都由维护者决定：

- **alembic**（后端数据库迁移，backend-infra 第 13 条）：现状是 create_all + 手写补加数据列，只进不退无版本。
- **react-syntax-highlighter 或 lowlight**（前端代码高亮，frontend-chat N4，二选一，需动态 import 控制体积）。

> **2026-11-05 两个都已由维护者安装**：alembic 1.20.1（server/uv.lock）；高亮选了 react-syntax-highlighter 16.1.2（pnpm-lock.yaml）。勘误：alembic 对应 backend-infra 第 13 条（此前误写第 6 条）。注意 react-syntax-highlighter 不带类型声明，还需 `@types/react-syntax-highlighter`（已于 2026-11-05 装为开发依赖，tsconfig 的 `types` 显式加载其环境声明；见 frontend-chat N4 注）。

其余点名的库要么不需要（slowapi、husky、lint-staged、pnpm catalog），要么绑定前提条件（structlog、sentry-sdk、prometheus-client、@ariakit/react、pg_trgm 扩展、cachetools），要么已在依赖里只是用法要改（redis.asyncio）。

## 建议实施顺序（跨文档汇总）

> **2026-11-05 注**：下面各批已大部分实现或搁置，实施状态以各条目的存根注记为准；本节保留作调研档案。

1. **第一批（全部 S 级、互相独立、不动接口契约）**：聊天区滚动跟随（frontend-chat N1）、流式 rAF 合并批次（O1）、弱网重试三个漏洞（P1/P2/P4）、fetch 超时（frontend-app P2）、POST 不盲目重试（三份文档共同指出）、登录端点接现成限流（backend-api P1 / backend-infra 第 1 条）、输入 max_length、avatar 字段 deferred、日志收窄、ruff 加 ASYNC 组、check 并入 tsc。
2. **第二批（安全与部署加固）**：cookie Secure/__Host- + TLS、nginx 完善（client_max_body_size、安全头）、systemd 守护、优雅停机、连接池 pre_ping、绝对会话上限。
3. **第三批（动契约、前后端同批）**：流加 `event: done` 结局事件、GET /api/events 会话状态通道、错误码 + 三语映射、消息分页与搜索。
4. **第四批（产品功能与工程化大件）**：编辑重发、多行输入、侧栏搜索/日期分组、alembic、CI、chunk 拆分、LayerFS main 树卫生清理（敏感文件优先，需维护者动手）。
