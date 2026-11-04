# FastGPT v4.14.5：接口与行为实测

这个文件记上游 FastGPT 的**现状事实**：实测过或对着源码核过的接口、行为和怪癖。不按日期记流水账——事实变了就直接改对应条目，每条注明核实日期。

版本基线、「接口清单怎么查」（三层说明、curl 取单个源文件）见 [server/AGENTS.md](../server/AGENTS.md) 的「FastGPT 的版本基线」一节。聊天流、停止、重试、`message` 表这些「我们怎么做」在 [INTERRUPTED_REPLY.md](INTERRUPTED_REPLY.md)；这个文件只讲「上游是什么样」。

## 停止机制

`apiVersion` 决定工作流怎么知道自己该停（源码 `packages/service/core/workflow/dispatch/index.ts`）：

- **v2**：看 Redis 里的运行态标记 `agent_runtime_stopping:{appId}:{chatId}`（TTL 60 秒，调度器每 100 毫秒轮询一次），标记由 `POST {访问地址}/v2/chat/stop` 写入；**不看客户端连接断没断**。
- **v1**：只看客户端连接断没断（`res.closed || res.errored`）；那个标记没人读。

每轮**开始**时调度器会先删掉停止标记（源码注释 "Remove stopping sign"）：标记晚到的话，新开的那一轮会被自己人写的标记掐掉。所以主动叫停之后、开新一轮之前，要等叫停那一下落地。v1 没有这个问题（连接断开是持续状态，不是一次性标记）。

`POST {访问地址}/v2/chat/stop`（实测 2026-10-31，我们的部署认 API key）：

- body 是 `{appId, chatId}`，鉴权走 `authChatCrud`。
- 它做的事是写入上面那个标记，然后每 50 毫秒轮询、最多等 5 秒让工作流收尾（`waitForWorkflowComplete`，源码 `packages/service/core/workflow/dispatch/workflowStatus.ts`），标记没了就返回。
- 返回体是 FastGPT 自己的壳：`{"code":200,...,"data":{"success":true}}` —— 成功要看 `data.success`。
- 调用方不要等它的返回（它自己最多要等五秒），发出去就不管。

**光断连接停不住 v2 的上游。** 实测（2026-10-31，同一句「写一篇 800 字左右的短文」，第 2 秒按停止）：

|                            | FastGPT 那边存下来的这一轮                |
|----------------------------|-------------------------------------------|
| 带 `v2/chat/stop`          | 问 22 字，答 **1 字**（答案节点没跑起来） |
| 不带（对照，把那行注释掉） | 问 22 字，答 **684 字**（整篇跑完了）     |

不主动叫停，上游会把整篇写完——token 白花。一轮**失败**（读超时、连接断在中间）同理：v2 的工作流不看连接，上游那一轮还在跑，会把答案写完，那条记录还会晚到我们的历史里。

历史注：2026-10-31 之前我们走 v1，停止靠断开 httpx 连接；当时实测在回答进行到第 1 秒时调 `v2/chat/stop`，连做 4 次，每一轮都照跑完、都有完整回答和 `[DONE]`——v1 下那个标记没人读，停止接口的耗时（0.98 / 5.19 / 5.32 / 6.17 秒）只是跟着那一轮自己什么时候结束走（运行结束时会删掉标记）。改走 v2 之后，停止变成主动调 `v2/chat/stop`。停止请求和对话请求的时序问题、我们自己的停止标记，见 [INTERRUPTED_REPLY.md](INTERRUPTED_REPLY.md)。

**上游没有「这一轮还在不在跑」的查询接口**（核过 v4.14.5 的 chat 接口，2026-11-01）：运行态只在流里通过节点状态事件报，`waitForWorkflowComplete` 是停止接口内部用的。所以读超时（`FASTGPT_READ_TIMEOUT_SECONDS`，见 [TECH.md](TECH.md)）是我们唯一的本地手段。

## v1 与 v2 对话接口

`projects/app/src/pages/api/{v1,v2}/chat/completions.ts` 几乎是同一个文件：逐行 diff 下来，实质差异只有两处——传给调度器的 `apiVersion`（决定停止机制，见上节），以及节点级数据是运行中就写还是结束时一次写。请求体、消息解析、历史合并（最后一条当提问，其余和库里的历史拼接）、`responseChatItemId`→`dataId`、SSE 帧格式，全都一样。两个接口也都要求 app 发布为 version v2（`app.version !== 'v2'` 就拒绝："您的工作流版本过低"）。

- `detail: false` 时 v1、v2 的帧一模一样（换行、整块答案、换行、收尾、`[DONE]`，共 5 帧），我们前端的解析一行都不用改（实测 2026-10-31）。
- `detail: true` 时 v2 会多出一整套结构化事件：`flowNodeStatus`（节点名，比如「準備動畫和動手活動」）、`flowNodeResponse`（每个节点的输出和耗时）、`updateVariables`、`workflowDuration`、`fastAnswer`。**我们的部署已经开着运行状态**（实测 2026-10-31，这些事件现在就在发）。以后做「图片/视频生成要等几分钟」的进度显示用得上——后端挑着转给页面就行，不用 WebSocket。
- v2 把节点输出一起存进历史记录：记录变胖，`getPaginationRecords` 的返回里会带 `responseData`（见下节）。

我们现在走 v2（2026-10-31 起）。切 v1/v2 时前端解析不用动，但停止必须跟着换机制，否则静默失效。

## 历史与上下文

**模型读多少轮是上游定的，不是我们定的**（源码 + 实测，2026-11-01）：

| 想要的东西             | 由谁说了算                             | 我们能改吗                        |
|------------------------|----------------------------------------|-----------------------------------|
| 模型读多少轮           | 上游 AI 对话节点的 `history`（默认 6） | 不能，只能找 FastGPT 那边改工作流 |
| 窗口里放哪几轮、怎么排 | 我们（前提是我们自己发 messages）      | 能，但代价大                      |
| 用户看到什么           | 我们想存就存                           | 能，跟上下文归属权没关系          |

源码依据（v4.14.5）：

- `v2/chat/completions.ts`：`getChatItems({chatId})` 按 chatId 查上游自己的记录（**chatId 为空就返回空**），`concatHistories(histories, chatMessages)` 把上游记录和我们发的 messages 拼在一起。
- chatId 传非空时，FastGPT 只把 messages 数组**最后一条**当用户问题，其余全部忽略；chatId 不传时，它不用自己的上下文，完全靠我们传入的 messages 构造上下文（文档站和 v4.14.5 源码一致，早前也实测过）。
- 但**不传 chatId 自己拼上下文走不通**：上游会自己造一个新的 chatId（`saveChatId = chatId || getNanoid(24)`），一场会话在上游那边会碎成一堆一轮一轮的小对话；停止接口（要 `{appId, chatId}`，还要过 `authChatCrud` 验这个 chat 属于这个 app）也没有稳定的 chatId 可用。
- `packages/service/core/workflow/dispatch/ai/chat.ts:83`：节点参数 `history = 6`；`packages/service/core/workflow/dispatch/utils.ts:97`：`getHistories` 保留所有 System 消息，其余只留最后 `history * 2` 条记录。

**取多少和读多少是两个数**（实测确认 2026-11-01）：`getMaxHistoryLimitFromNodes` 算出来的 `limit`（默认 `max(10, 节点配的数) × 2`）只是「从库里取多少条记录」的余量（默认最多取 20 条即 10 轮，取最近的，`getChatItems` 里 `offset: 0, limit`）；模型读到的是 `history × 2` 条（12 条即 6 轮），System 消息全留。多取的那几条是余量，模型不看。节点的 `history` 配成 N，两个数一起变——找 FastGPT 那边改配置是一处配置管两个数。**所以我们发 7 到 10 轮，模型也只看到最后 6 轮**；截断跟历史从哪来没关系，从库里取的和我们发的是同一锅粥，一起被砍。

`responseChatItemId`：传了它，FastGPT 就把这个值当作本次回答的 ID 存进它的数据库（同一 chatId 下要唯一）。实测（2026-10-30）：传 `responseChatItemId=turn-test-0001`，用 `getPaginationRecords` 读回来，那条 AI 记录的 `dataId` 就是它；**提问那条记录的 `dataId` 是 FastGPT 自己的**（一串二十几个字符）。我们的轮次编号因此能跟着回答回到历史里。

`core/chat/record/getPaginationRecords`：返回字段是写死的，没有 `field` 参数可挑，v2 记录变胖后返回里会带 `responseData`——我们只解析 `value[].text.content`，用不上但要传。这是给页面显示用的完整历史，分页取的是全部记录（「打个招呼」那场 22 条整条都在），跟模型读到的上下文是两回事。

结论（2026-11-01 定，不改）：**上下文归 FastGPT**。模型看到什么是上游节点的事，我们改不了；用户看到什么由我们自己存进 `message` 表（见 [INTERRUPTED_REPLY.md](INTERRUPTED_REPLY.md) 的「页面上的历史从哪儿来」）。

## 删除记录

- `DELETE {访问地址}/core/chat/history/delHistory?chatId={会话id}&appId={应用id}`：源码注释 "delete single chat history (soft delete)"，把**整场会话**标记成删除，也就是清空整场上下文，没有「删一轮」这个选项。**用不存在的会话 id 调它也返回 200**（正文 `{"code":200,...,"data":null}`，实测 2026-10-26）——「这场会话在 FastGPT 里不存在」和「删除成功」看起来一样。
- `POST {访问地址}/core/chat/item/delete`：删**单条**记录，body 是 `{appId, chatId, contentId}`。官方文档没有列它（源码 `projects/app/src/pages/api/core/chat/item/delete.ts`），鉴权走 `authChatCrud`（`authApiKey: true`）。实现是给那条记录写 `deleteTime`（软删），按 `dataId` 匹配；删完 `getPaginationRecords` 里就没有了。**删一个不存在的 `contentId` 也返回 200**（`{"code":200,...,"data":null}`），不报错。（实测 2026-10-31。早先文档里写的 `core/chat/record/delete` 和 `sourceType`/`sourceId`/`contentIds` 那套参数属于更新版本，v4.14.5 没有那个文件。）

回答那条记录的 `dataId` 就是我们的 `responseChatItemId`，提问那条的是 FastGPT 自己的，所以重发一轮时两条都能删；具体删法和「找不到就不删」的规矩见 [INTERRUPTED_REPLY.md](INTERRUPTED_REPLY.md) 的「重试按钮」一节。

## 点赞与点踩

`POST {访问地址}/core/chat/feedback/updateUserFeedback`（对着 v4.14.5 源码核过，2026-11-04；实现 `projects/app/src/pages/api/core/chat/feedback/updateUserFeedback.ts`，参数定义 `packages/global/openapi/core/chat/feedback/api.ts`。**尚未实际请求过**，第一次实测放在消息操作第四期实现时）：

- 鉴权走 `authChatCrud`，`authApiKey: true`——和删单条记录同一套，我们后端的 API key 就能调。
- body：`{appId, chatId, dataId, userGoodFeedback?, userBadFeedback?}`。`dataId` 是那条 AI 回答的记录 ID，**就是我们的轮次编号**（`responseChatItemId` 那条的结论，见「历史与上下文」）。两个反馈字段是自由文本（可空可省），语义是**传什么设什么、不传就删什么**：源码里字段出现就 `$set`、没出现（undefined）就 `$unset`。所以点赞 = 只传 `userGoodFeedback`（顺带清掉点踩），点踩 = 只传 `userBadFeedback`，取消 = 两个都不传。
- 响应是 FastGPT 惯常的壳 `{code:200,...,data:{}}`，`data` 是空对象；成功看 `code`。
- 副作用都在上游侧：更新这场会话的反馈计数和应用日志表的好差评计数，对我们无影响。
- 注意：**v2 目录下没有这个接口**——`v2/chat/` 只有 completions 和 stop；点赞点踩在 `core/chat/feedback/` 路径下。同目录还有 adminUpdate（管理员代改反馈）、getFeedbackRecordIds（按好差评筛记录）、updateFeedbackReadStatus（标已读）等运营接口，第四期用不到，留档备查。

## 流式行为

传 `stream: true`、响应头也是 `text/event-stream`，但**上游一整块返回，不是逐字**（实测 2026-10-29，连续三次对话同一节奏）：先来一个只含换行符的事件，隔 2 到 5 秒整段答案一次性到达，再来一个换行符事件，最后是 `finish_reason` 和 `[DONE]`。第一个事件 0.3 秒左右就到，所以不是反向代理把响应攒住才发，是 FastGPT 那边（maas.eduhk.hk）自己把答案写完才写成一条事件。要改成逐字输出是那边的事。

**2026-11-04 复测（detail:false 与 detail:true 各两轮短问题，curl 直连）**：detail:false 的模式和 2026-10-29 的记录一致——换行帧、静默 2~4 秒、整段答案一帧到齐（90 字全文一帧）、换行帧、finish_reason、`[DONE]`；答案正文偶尔分成两帧（正文后隔约 0.4 秒补一帧尾巴）；响应头到达时间不稳（一次 0.3 秒、一次 3.8 秒）。**detail:true 时答案同样整块到达**（134 字全文在 fastAnswer 事件下一帧到齐，+2.3 秒）——开了 detail 也不会逐字输出；区别是响应头约 0.19 秒就到，且整个运行期间持续发命名事件：`event: flowNodeStatus`（载荷 `{name, status}`，几十字节一条，一轮 10~14 条）、`event: flowNodeResponse`（节点输出明细，单条最大 11.7 KB，含 historyPreview 和 codeLog）、`event: fastAnswer`（答案内容帧）、`event: updateVariables`（工作流变量全量，实测键名有 academy_lesson_id、academy_progress、cls 等学生数据键）、`event: workflowDuration`（总耗时）、`event: answer`（finish_reason 和 `[DONE]` 挂在这个事件名下）。一轮短问题合计 30~50 条事件、最多约 55 KB。答案文本按节点整块写出，答案出口的节点能不能改成逐字，要那边对着 v4.14.5 源码查。我们这层怎么用这些事件（转节点状态、不转变量和明细）见 [CHAT_STREAM_KNOWN_ISSUES.md](CHAT_STREAM_KNOWN_ISSUES.md) 的「上游的真实节奏」一节。

## 杂项

- **没有「分享某一场会话」的接口**（对着文档和 v4.14.5 源码核过，2026-10-26 / 10-31）：和某一场 `chatId` 有关的操作就是列会话、改标题、改置顶、删除这场会话、取基本信息、取消息、取运行详情、删一条消息、点赞或点踩。文档里的「分享」指应用的免登录窗口：控制台发布渠道里创建的带 `shareId` 的链接，打开的是整个应用，不是我们某一场会话。决定：不把免登录窗口当成我们的分享；以后要分享某一场会话，做法是读出这场已完成的消息、把问答写成 Markdown 再下载（现在没有这个需求，先不做）。置顶只存在我们自己的数据库里，不调用 FastGPT 的置顶接口（生成回答用不到它）。
- 工作流里已经有「有沒有上載題目圖／檔案？」和「Append validated visual after teacher reply」这类节点（2026-10-31 顺带看见）：上传和出图的工作流基础上游可能已经有了，缺的更可能在我们这边（上传入口、把答案里的 markdown 变成真的图片）。
