# 聊天流协议与轮次生命周期

这一层是「助手回答怎么流出来、一轮问答怎么算结束、断了怎么接回来」。写于 2026-11-05，描述现状。

本文取代两份已退役的文档：原 CHAT_STREAM_KNOWN_ISSUES.md（问题追踪，条目已全部修复或迁出）和原 INTERRUPTED_REPLY.md（机制记录），仍然有效的内容都并进了这里，已修复的问题改写成了现状描述。上游 FastGPT 本身的接口与实测事实见 [FASTGPT_API.md](FASTGPT_API.md)；页面端的行为（滚动、轮询节奏、错误边界、会话过期原地态）见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)；气泡脚注上的重试/编辑/复制/点赞点踩界面见 [MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md)；日志与排查见 [TURN_LOGGING_AND_DIAGNOSTICS.md](TURN_LOGGING_AND_DIAGNOSTICS.md)。

## 流里的四种帧

`POST /api/chat` 回一条 SSE 流（`text/event-stream`）。流里只有四种帧，外加非 200 的响应：

| 页面收到 | 意思 |
|---|---|
| `data: {"choices":[{"delta":{"content":"…"}}]}` | 内容帧：一段答案正文，取 `choices[0].delta.content`（后端 `_chunk`，前端 `contentFromPayload`） |
| `event: progress` + `data: {"name","status"}` | 进度帧：上游工作流的节点状态，原样转发；不参与结局判定，不算回答正文 |
| `event: done` + `data: {turn_id, status, reason, bytes_sent}` | 结局帧：这一轮的结局随流明说，页面收到即以它为准 |
| `data: [DONE]` | 中继走完。正常写完的路径在结局帧之后发；失败/被停的路径没有这一帧 |
| 非 200 + `{"detail": "中文句子"}` | 后端没接下这个请求（请求本身失败），不是流 |

结局帧的载荷是 `TurnDoneEvent`（[server/src/server/types/api.py](../server/src/server/types/api.py)）：`status` 三选一（`completed` 写完了 / `aborted` 用户按了停止 / `failed` 失败）；`reason` 词汇固定（`stop` 用户按停 / `upstream` 上游失败 / `internal` 我们这边出错），正常写完为 null；`bytes_sent` 是这一轮发给页面的正文字节数。

进度帧的 `name`/`status` 是上游 `flowNodeStatus` 事件的两个字段，**原样转发、不做映射文案**（2026-11-05 维护者拍板：受众是香港本地小三学生，繁体节点名对他们本就合适；节点名好不好懂归工作流搭建方负责）。进度帧只进 SSE 队列，不进 Redis 半截文字、不算进 `bytes_sent`、不影响「发过内容没有」的失败语义（`_relay` 里对 `ProgressEvent` 的分支）。

## done 帧是即时判断，数据库是最终事实

2026-11-05 维护者拍板的分工：

- **页面的即时语义以 done 帧为准**：收到 `completed` 当写完了；`aborted` 当停了；`failed` 映射成前端的 `interrupted`（保留「可重试」语义），随后走恢复流程对账数据库。
- **刷新以后的语义以库为准**：`GET /api/sessions/{id}/messages` 的消息上带 `failed`/`aborted` 标志，脚注照标志渲染。
- **失败之后服务器还会对账**（`_write_round_end`）：等叫停上游落地，按轮次编号去上游核对——上游那份从我们收到的那段接着往下写（说明是我们的 `[DONE]` 丢了），就把库里的存档文本和状态改成写完了。这次对账只修库（归档核对），**done 帧不等待它、也不回改**：流可能已经说过 `failed`，库里事后变成 `completed`，两边不一致是设计内的事，排查时要知道。被按停止的一轮不对账：用户要的就是停在这一截。

兼容期规则（前端 `streamReply`）：没收到 done 帧但收到了 `[DONE]`，当写完了；两者都没收到，是真断流，去问服务器「还在写吗」（见「刷新续传与断流恢复」）。

## 心跳与响应头

- **心跳**：流上 15 秒没有动静就发一帧 SSE 注释帧 `: ping`（`_HEARTBEAT_SECONDS`，`_sse` 里 `asyncio.wait_for` 超时的分支）。前端解析器只认 `data:`/`event:` 行，注释帧天然被忽略；作用是让中间代理和页面知道流还活着。
- **响应头**：SSE 响应带 `Cache-Control: no-store`（任何一层都别缓存这条流）和 `X-Accel-Buffering: no`（叫 nginx 这类反向代理别攒响应正文——攒住的话帧要等缓冲满才发得出去，静默期里页面连心跳都收不到）。两处统一走 `_SSE_HEADERS`。
- **响应头立刻回**：`/api/chat` 先登记这一轮、起后台任务，马上把响应头发回去（实测 0.013 秒），不等上游第一个字节。上游的失败一律表现为「流提前结束」。

## 上游整块返回答案

**上游的答案不是逐字流出来的，是整块蹦出来的**：换行符小帧很快到（0.3~2 秒），然后彻底静默 0.3~12.8 秒（实测 152 轮），上游把答案写完一次到达；最极端的一轮等了约 23 秒。`detail: true` 时答案同样整块到达，区别只是静默期里持续有节点事件。完整的量化记录、对照实验和事件载荷说明见 [FASTGPT_API.md](FASTGPT_API.md)「流式行为」。

**2026-11-05 维护者拍板**：「能不能逐字」的问题搁置，不向 FastGPT 那边提出；这一层的一切按「上游永远整块返回」推进，针对逐字上屏的前端渲染优化（调研里的渲染合批两条）随之搁置。

我们发给上游的请求带 `detail: true`（[server/src/server/fastgpt.py](../server/src/server/fastgpt.py) 的 `events`），为的就是拿 `flowNodeStatus` 转成进度帧。**学生数据的红线**：上游的 `flowNodeResponse`（节点输出明细，含对话历史预览）和 `updateVariables`（工作流变量全量，实测带 academy_lesson_id、academy_progress、cls 等学生数据键）两类事件，任何级别（包括 debug）都不整行落日志——只记事件名和字节数（`_SENSITIVE_EVENTS`），也绝不转发给页面。

## 轮次编号：一个编号三个地方

页面每次发问生成一个 UUID 当这一轮的编号，两处都用它：请求体里带 `turnId`，Redis 里也存着（`h2botapp-chat:{会话id}:turn` 键，连着提问原文一起存）。发给上游时它是请求体里的 `responseChatItemId`——FastGPT 把这个值当作本次回答记录的 `dataId` 存进它的数据库。所以一个编号同时出现在三个地方：页面的消息上、Redis 里、上游的历史里。不管刷新多少次，都能按编号认出「哪一条是当前这一轮」，不靠文字猜。

Redis 里这一轮相关的键（[server/src/server/reply_store.py](../server/src/server/reply_store.py)）：

| 键 | 内容 |
|---|---|
| `h2botapp-chat:{会话id}:status` | 状态（线上值见「状态词表」一节） |
| `h2botapp-chat:{会话id}:text` | 已经写出来的半截文字 |
| `h2botapp-chat:{会话id}:turn` | 这一轮的编号和用户问的话 |
| `h2botapp-chat:{会话id}:stop` | 停止标记（值是轮次编号，60 秒过期） |

**幂等**：`POST /api/chat` 拿请求里的编号对一下 Redis 记着的当前轮次——对得上且还在写，回 409「这一场会话还有一轮在写」；对得上且已落定，回一个空流（页面读库对账）。同一个编号不会开第二轮：重复点击、页面重发都不会让上游生成两遍。

## 同一场会话同时只跑一轮

`POST /api/chat` 检查这场会话是不是已经有一轮在写（`round_in_flight`），是的话回 409，不开新一轮。以前可以同时开两轮：上游多出一轮对话，Redis 里的半截文字被清掉重来，两轮的片段交错着写在一起。页面收到 409 的处理（问题放回输入框、提示、重读线程）见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)。

重发时 Redis 里那半截旧文字的清理不用另外做：`begin_reply` 本来就会把文本键删掉重来。

## 停止

等回答的时候，发送按钮换成停止按钮。

**页面这边**：每次发问都带一个 `AbortController`，按停止先 `abort()`（正在读的流当场断开），同时调 `POST /api/sessions/{会话id}/abort`，请求体带这一轮的编号（没带编号时服务器自己认当前这一轮）。页面不自己宣布停了——收尾只问服务器「还在写吗」一个问题，以库和 done 帧为准（流程细节见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）。

**服务器这边**（`abort_session_reply`）：

1. 先写停止标记（Redis `:stop` 键，值是轮次编号，60 秒过期），再取消正在跑的任务。写标记在前，是为了让「停止请求先到」也生效。
2. 同时调上游 `POST {访问地址}/v2/chat/stop` 主动叫停，不等它返回（它自己最多等五秒让工作流收尾）。
3. 取消任务后等这一轮真的收尾（最多两秒），页面随后读到的就是最终状态。任务被取消时 `_relay` 把状态记成 `aborted`、done 帧带 `reason: stop`，已经写出来的半截文字留在 Redis 里。

**为什么要有停止标记**：停止请求和对话请求是两条 HTTP 请求，按到达顺序处理。停止请求先到时，那一轮还没登记、没有任务可取消——光靠「取消任务」停止就白按了。实测过这种次序（对话请求走新连接、停止请求走空闲连接时，十次里有十次停不掉）。有了标记就不管谁先到：停止请求把编号记下来，后到的对话请求看到编号对得上，自己就不开这一轮（`stop_requested`）。标记按编号认，只对那一轮有效，下一轮照常。

**开轮前被停**的路径也有明确结局：对话请求到达时发现停止标记对得上，这一轮不开，但提问照样登记（刷新以后还能看到「问了什么、这一轮被停了」），库里记成 `aborted`，空流里带一个 done 帧（`status: aborted, reason: stop, bytes_sent: 0`）。

**页面断开不算停止**：刷新页面、关掉标签页也会断开这条流，服务器不取消那一轮，照旧写完、写进 Redis，页面回来还能接上。「停止」必须由页面明确说一声。

**v2 的停止机制**：我们现在走上游 v2 接口，v2 的工作流只看 Redis 里的运行态停止标记、不看连接断没断——光断连接停不住上游（实测：不叫停，问 22 字答 684 字；叫停后答 1 字）。停止标记在每轮开始时会被上游调度器先删掉，所以主动叫停之后、开新一轮之前要等叫停那一下落地（`_wait_for_stop`，最多 7 秒）——标记晚到的话，新开的那一轮会被自己人写的标记掐掉。机制、源码依据和完整实测见 [FASTGPT_API.md](FASTGPT_API.md)「停止机制」。

**失败以后也去叫上游收手**（`_relay` 的 finally，`wait=True`）：一轮失败后上游照旧会把答案写完——token 白花，那条记录还会晚到历史里。叫停放在结束流之后发：页面不用等这一下。

## 重试与编辑重发（协议面）

重试和编辑重发是同一条路：`POST /api/chat` 带一个可选的 `retryOf`（要重发的那一轮的编号）。服务器收到以后先删旧轮，再用新的轮次编号开一轮。这条路对失败轮和被停轮同样有效（服务器不检查旧轮的状态）。界面上的重试按钮、编辑框、发送失败回滚全部归 [MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md)。

**删旧轮**（`_clear_failed_turn`）删两边：我们 `message` 表的两行，加上上游留下的记录。上游那边的删法：

- 回答记录的 `dataId` 就是我们的编号，按编号精确删；再删它前面那条提问（提问的编号是 FastGPT 自己的）。
- 工作流没跑完时上游只留下提问那条记录（「悬空提问」）：只有当它就是最后一条记录时才删。指认它拿**我们自己 `message` 表里读出的这一轮提问原文**去比对（`chat_log.read_question`）——编辑重发时请求体里带的是新文字，拿请求体比对永远比不中（MESSAGE_ACTIONS.md 的方案①）。
- 找不到就不删：宁可让历史里多一遍问答，也不要删掉别人那一轮。找记录要删的时候不能读缓存（缓存里可能是这一轮之前的那份）。

**连接断了要不要重发**（前端 `streamReply` 的规则）：只有服务器明确说「没在写」（`/partial` 回 404，含「没有这一轮」）才带同一个编号重发一次——重发是安全的，服务器按编号幂等，落定过的轮回空流；还在写（200）或问不到服务器（网络错）一律不重发，免得生成两遍，结局交给恢复流程对账数据库。`not-started`（请求没落地）由 `streamReply` 自动重发一次。

**上下文拼接归 FastGPT，不归我们**：请求体里只有当前这一句（`messages` 只带这条用户消息）加 `chatId`，上游自己取这场会话的历史、把最后一条当用户问题。模型能读多少轮由上游 AI 对话节点的 `history` 决定（默认 6 轮），我们这边改不了。依据和源码出处见 [FASTGPT_API.md](FASTGPT_API.md)「历史与上下文」。

## 刷新续传与断流恢复

**服务器这边**：进行中的文字住在 Redis 里（`:text` 键，每转发一块就追加），页面断开不影响服务器写完这一轮。`GET /api/sessions/{id}/messages` 返回整场会话的线程：我们自己 `message` 表的历史，加上 Redis 里当前这一轮（`_merge_current_turn` 按编号拼接——历史里已经有这个编号的回答就不再补；提问历史里已经有了也不重复添；表里没有这一轮时按老办法把 Redis 这轮接在后面，提问 + 一个「正在写」的回答）。

**`/partial` 只回答一个问题——这一轮还在写吗**（`read_session_partial`）：

- Redis 里状态是 streaming：回 200，`{"status":"streaming","text","turn_id","question"}`，带半截文字和轮次编号。
- 其余一切情况（写完了/失败/被停/键不存在）：一律 404「这一轮已经不在写了」，页面去读库。结局语义不再由这个接口承担：即时结局随流的 done 帧走，永久结局在库的 `message.status` 上。
- Redis 读不通：照旧抛错（500）。那是「问不到服务器」，不是「没在写」，客户端靠状态码区分这两种。

**前端**把「问服务器」收敛成一个函数 `probePartial`（[src/api/partial.ts](../src/api/partial.ts)），三种结果：`streaming`（还在写，带 partial）、`idle`（404，服务器明确说没在写）、`unreachable`（网络错等，什么都不知道）。断流后的恢复（`recoverReply`）：问不到服务器 → 保留现场、不删已收到的文字，归连接警示横幅，不替服务器下结论；还在写（编号对得上，或 Redis 里没编号）→ 补上半截文字、接着 500 毫秒轮询；idle → `refreshThread` 以库为准对账。轮询节奏、后台标签暂停、断线补查这些页面端细节见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)。

前端解读 `partial.status` 的地方从历史上的 17 处收敛到 0 处：这个接口现在只有一个状态值，结局一律由 done 帧和库说。

## 这一轮的历史从哪儿来

我们自己存了一份：`message` 表（[server/src/server/db/models.py](../server/src/server/db/models.py) 的 `ChatMessage`），一行一条消息（提问、回答、轮次编号、状态、顺序号）。

- 模型看到的上下文还是 FastGPT 拼的（我们传 chatId，最近 6 轮由上游节点设置决定）；页面显示的历史从我们这张表来。FastGPT 清库、上游挂掉，页面照样看得见。
- 写库不在流里面：进行中的文字住 Redis，一轮落定以后才写表（`_settle_round` 起单独任务——这一轮的任务可能正被取消，在它里面写库会写不成）。时机和量：一轮开始写两行（提问、回答的位置，`begin_round`，状态 streaming），一个事务；落定改这两行（文字和状态，`finish_round`），一个事务。本机 PostgreSQL 实测一次查询中位 0.30 毫秒。
- 老会话第一次读到的时候，把上游那一份抄一份过来（`_backfill_session`），之后以我们这份为准。想把没人再打开过的老会话一次搬完：在 `server/` 里执行 `uv run python -m server.db.backfill`。回填的老消息没有轮次编号（上游记录映射不到），页面对此有兜底（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md) 的「轮询与断线补查」和 [MESSAGE_ACTIONS.md](MESSAGE_ACTIONS.md) 的点赞点踩边界）。

## 卡死行对账

进程死在半路时，表里会留下状态是 streaming 的行（`begin_round` 的设计意图就是「进程中途死了，表里留着这一轮的提问」），Redis 键过期后没人再来落定它。两层对账：

- **读时兜底**（`_merge_current_turn`）：表里 streaming 的行，Redis 的 partial 为空或编号对不上，说明这一轮其实已经不在写了——展示层降级为 failed（不写库），页面因此出现「消息生成失败 + 重试」而不是永远的等待气泡。编号对得上的行不降级：Redis 里那份状态更新，照实合并。
- **启动对账**（lifespan 里的 `chat_log.fail_stuck_rounds`）：单进程前提下，进程重启时不可能有「还在写」的轮次，表里所有 streaming 行必是死轮，一条 UPDATE 全标成 failed。

### 轮次键 TTL 与崩溃窗口

- `:status` / `:turn` / `:text` 三个轮次键的 TTL 是 `REDIS_KEY_TTL_SECONDS`（env 注入，现网 600 秒）：内容块到达（`append_chunk`）和轮次落定（`mark_finished`）会刷新；**进度帧不碰 Redis**（进度不算正文）。停止标记 `:stop` 是另一个 60 秒的短 TTL。
- 理论边界：一轮直到 TTL 都没有任何内容块（只有进度帧或纯静默超过 600 秒），键会提前过期——单轮 409 守卫和同轮次编号幂等失效，同编号重发会走 `begin_round` 的删旧行路径重生成。实测上游最长静默约 23 秒（FastGPT 整块输出），600 秒远大于任何实测值；记录为结构边界，不是现网 bug。
- 崩溃窗口：启动对账只清数据库、不清 Redis——崩溃后最长 600 秒内 `/partial` 仍答 200（streaming），页面会对着一轮死轮继续轮询，TTL 到期后走 404 → 读时兜底自然收敛。backlog：启动对账时顺带清 Redis 轮次键（improvement-research backend-api P16）。

## 状态词表：一个模块拥有四个词

[server/src/server/turn_status.py](../server/src/server/turn_status.py) 独家拥有 `streaming` / `completed` / `failed` / `aborted` 四个词：数据库 `message.status`、Redis 的 `:status` 键、`turn_summary` 日志行的 outcome 和 done_status、流里 done 帧的 status，说的都是这四个词，一律从这里读。早先 reply_store（写完用 `finished`）和 chat_log（写完用 `completed`）各有一套、app.py 里两套并排 import 的日子结束了。

唯一例外是 Redis 的线上值：「写完了」历来写的是 `"finished"`，滚动部署时新旧进程会交错读写，线上值保持不变——reply_store 在自己的边界上做一次映射（写出去 `finished`、读进来映射成 `completed`），`"finished"` 这个词不出 reply_store。

状态由此收敛成四份、各管一段：**流（done 帧）说结局、库存档、Redis 只管「正在写」、页面由流和库喂**。

## 降级与超时

- **Redis 不通时降级**：半截回复是可选的，Redis 写失败只记警告，聊天照常走（`_tolerate`）；页面上会出现一条常驻横幅「半截回答功能不可用」。Redis 客户端连接不通要马上知道（2 秒超时、不重试——默认的连接重试会让一次失败的写入等 3.7 秒，把整个服务卡住）。
- **状态接口**：`GET /api/status` 报 `{"database": "ok"|"unavailable", "reply_store": "ok"|"unavailable"}`。不需要登录，只带 cookie 也不刷新登录有效期（它是心跳）。页面每 30 秒查一次、标签页重新可见时补查（见 [CHAT_PAGE_BEHAVIOR.md](CHAT_PAGE_BEHAVIOR.md)）。
- **上游记录的 5 秒缓存**（`_records_cache`）：刷新多少次，上游就只被问一次。以前每刷新一次就问一次上游要整段历史，连着刷新十来次能把上游打到连不上（[FINDINGS.md](FINDINGS.md) 2026-10-30 那条）。
- **对上游的三个超时**（[server/src/server/fastgpt.py](../server/src/server/fastgpt.py)）：连接 10 秒；读 30 秒（等第一个字节、两块字之间都是它，`.env` 里 `FASTGPT_READ_TIMEOUT_SECONDS` 可调）。原来 `read=None` 无限等，上游接了连接一直不吭声时这一轮会永远挂着。上游没有「这一轮还在不在跑」的查询接口，读超时是我们唯一的本地手段。

## 单进程前提

`_running`、`_stop_tasks`、`_settle_tasks`、`_pending_stops`、`_records_cache` 都在模块全局。多 worker 的话，对话请求和停止请求可能落在不同进程，「停止」就找不到那个任务；启动对账和令牌清扫的定时任务也按单进程设计（不需要分布式锁）。这是前提不是 bug——别以后有人顺手加 `--workers 4`。

## 设计原则

这一层有几处做对了，改的时候不要推翻：

- **轮次编号幂等**：同一个编号不会开第二轮，挡住重复点击、页面重发导致上游生成两遍。
- **停止标记按轮次编号认**：停止请求和对话请求谁先到都对。
- **失败以后也去叫上游收手**：不叫停的话 token 白花，那条记录还会晚到历史里。
- **我们自己存了一份历史**：FastGPT 清库、上游挂掉，页面照样看得见。
- **上游记录 5 秒缓存**：保护上游不被刷新打垮。
- **页面断开时服务器继续写完**：写进 Redis，刷新能接上。
- **结局随流明说**：done 帧让页面不靠「流怎么断的」反推结局；四份状态各管一段，不再互相猜。
- **坏帧只丢自己**：前端解析器对每一帧独立解析，一帧坏 JSON 不拖累同事件里的其他行，done 帧字段不合就整帧忽略——宁可没收到结局，不能解出一个错误的结局。

## 已知限制

- **被停轮的悬空提问**：上游会把这一轮的「用户提问」记进它自己的历史，即使这一轮被掐掉了。刷新之后线程里可能看得到一条没有回答的提问（我们自己的表记得更全：半截回答和被停标志都留着）。被停轮之后用户又问了别的，悬空提问不再是上游最后一条记录，重试也不会删它——它会留在上游的上下文里。
- **done 帧与库可能不一致**：失败后归档核对可能把库改成 completed，done 帧已经说过的 failed 不回改。页面的即时显示（失败 + 重试）和刷新后的显示（完整答案）因此可能不同，这是拍板过的分工，不是缺陷。
- **逐字输出搁置**：上游永远整块返回（2026-11-05 拍板），针对逐字上屏的渲染优化跟着搁置；调研原文见 [improvement-research/frontend-chat.md](improvement-research/frontend-chat.md) O1/O2 的注记。
