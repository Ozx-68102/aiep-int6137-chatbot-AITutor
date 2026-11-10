import {ApiError, isRecord, readFailure} from './http.ts';
import {probePartial} from './partial.ts';

/**
 * 流式回答的空闲超时（毫秒）：读取循环连续这么久没收到任何字节就中止。
 * 判定放在 reader.read() 返回的原始层面——任何分块都算连接还活着，包括
 * 服务器的 ": ping" 心跳注释帧，不等解析出内容帧。中止之后走既有的中断
 * 恢复语义（aborted/interrupted 分支），不新造状态。
 */
const streamIdleTimeoutMs = 60000;

export type ReplyOutcome =
  /** done 帧说 completed，或（旧后端兼容期）收到了 [DONE]：这一轮写完了。 */
  | 'completed'
  /**
   * 真断流（结局帧和 [DONE] 都没收到），或 done 帧说 failed。页面走恢复
   * 流程问「还在写吗」并按数据库核对并修正：失败脚注和重试按钮由消息上的标志驱动。
   */
  | 'interrupted'
  /** 请求没有生效，服务器那边根本没有这一轮，可以安全重发。 */
  | 'not-started'
  /** 用户按了停止，这一轮就此打住。 */
  | 'aborted'
  /** 这场会话已经有一轮在写，这一次没发出去。 */
  | 'busy';

export async function streamReply(
  chatId: string,
  message: string,
  turnId: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOf?: string,
  onProgress?: (name: string, status: string) => void,
): Promise<ReplyOutcome> {
  const outcome = await deliverReply(chatId, message, turnId, onDelta, signal, retryOf, onProgress);
  if (outcome !== 'not-started') {
    return outcome;
  }
  // 服务器说没有这一轮，说明请求没有生效，重发一次不会生成两遍。
  return deliverReply(chatId, message, turnId, onDelta, signal, retryOf, onProgress);
}

async function deliverReply(
  chatId: string,
  message: string,
  turnId: string,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOf?: string,
  onProgress?: (name: string, status: string) => void,
): Promise<ReplyOutcome> {
  // 空闲超时要有自己的中止控制器。不用 AbortSignal.any 把外部信号和超时
  // 合成一个：它需要 Chrome 116+/Safari 17.4+，超出 Vite 默认支持基线，
  // 而打包器垫不平浏览器原生接口。外部信号原样转发到这个控制器上，行为
  // 完全不变：两种来源都能中止请求和读取循环。
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort();
  };
  if (signal !== undefined) {
    if (signal.aborted) {
      controller.abort();
    } else {
      signal.addEventListener('abort', forwardAbort);
    }
  }
  try {
    let response: Response;
    try {
      response = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: {'Content-Type': 'application/json'},
        // 请求体不带 locale：后端的 ChatRequest 已经删掉这个字段，
        // 报错文案的三语化由前端按状态码映射负责（src/api/failure.ts）。
        body: JSON.stringify({message, chatId, turnId, retryOf}),
        signal: controller.signal,
      });
    } catch {
      if (signal?.aborted) {
        return 'aborted';
      }
      return await outcomeAfterFailure(chatId);
    }

    if (response.status === 409) {
      // 同一场会话已经有一轮在写。这一次没发出去，页面把问题放回输入框。
      return 'busy';
    }
    if (!response.ok) {
      // 会话类 401 把 reason 一起带上：一路透传到 sendQuestion 的统一出口。
      const failure = await readFailure(response);
      throw new ApiError(response.status, failure.detail, failure.reason, failure.code);
    }

    let delivered = false;
    try {
      const result = await readStream(
        response,
        (text) => {
          delivered = true;
          onDelta(text);
        },
        onProgress,
        controller,
      );
      if (result.turnDone !== null) {
        // 收到 done 帧：这一轮的结局随流明说，以它为准（authoritative）。
        // done 帧是即时判断，服务器的数据库是最终事实：失败后服务器与上游核对并修正，
        // 可能把存档改成 completed，页面不等待也不回改；刷新以后以数据库为准
        // （/messages 消息上的标志）。
        return outcomeFromTurnDone(result.turnDone);
      }
      if (result.streamEnd) {
        // 没收到 done 帧但收到了 [DONE]（旧后端兼容期）：照旧当写完了。
        return 'completed';
      }
      // 流断掉且 done、[DONE] 都没收到：真断流，交给恢复流程去问服务器。
      return 'interrupted';
    } catch {
      if (signal?.aborted) {
        return 'aborted';
      }
      // 空闲超时中止的进入下面两条既有分支：收到过内容算断流（interrupted），
      // 一点内容都没有就去问服务器这一轮的下落，不新造状态。
      if (delivered) {
        return 'interrupted';
      }
      return await outcomeAfterFailure(chatId);
    }
  } finally {
    // 清掉外部信号上的转发监听，别让它跨请求泄漏。
    if (signal !== undefined) {
      signal.removeEventListener('abort', forwardAbort);
    }
  }
}

/**
 * 连接断了的时候问服务器：这一轮还在写吗。
 * 明确说没在写（404）→ 请求没有生效，或这一轮已经有了最终结果：带同一个 turn_id
 * 重发一次是安全的——服务器按编号幂等（已有最终结果的轮次返回空流），不会生成
 * 两遍；还在写 / 问不到服务器 → 不知道或没写完，一律不重发，免得生成
 * 两遍，结局交给恢复流程按数据库核对并修正；会话死了（401）→ 抛出，
 * 走发送流程既有的 401 出口（见下面函数体里的注释）。
 */
async function outcomeAfterFailure(chatId: string): Promise<ReplyOutcome> {
  const probe = await probePartial(chatId);
  if (probe.kind === 'unauthorized') {
    // 401 是服务器明确说会话死了，不是「问不到服务器」的网络问题。原样抛出，
    // 沿 streamReply 传回 use-turn-engine 的 sendQuestion 的 catch——那里已有
    // 完整的 401 处理（把这句提问存起来 + 统一出口 onAuthError）。在这里忽略
    // 归成 interrupted，会话过期就会被错报成连接问题，走连接横幅。
    throw probe.error;
  }
  return probe.kind === 'idle' ? 'not-started' : 'interrupted';
}

type StreamResult = {
  /** 收到过 data: [DONE]（中继走完）。 */
  streamEnd: boolean;
  /** 收到过 event: done 帧的结局（authoritative）；没收到就是 null。 */
  turnDone: TurnDone | null;
};

async function readStream(
  response: Response,
  onDelta: (text: string) => void,
  onProgress: ((name: string, status: string) => void) | undefined,
  controller: AbortController,
): Promise<StreamResult> {
  const body = response.body;
  if (!body) {
    return {streamEnd: false, turnDone: null};
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamEnd = false;
  let turnDone: TurnDone | null = null;
  // 空闲超时：到点还没收到任何字节就中止这条流，读取循环随之抛出、进入
  // 调用方既有的中断恢复分支。定时器在 finally 里清掉，防泄漏。
  let idleTimer = window.setTimeout(() => {
    controller.abort();
  }, streamIdleTimeoutMs);
  try {
    for (;;) {
      const {done, value} = await reader.read();
      // 读到任何数据（内容分块、心跳注释帧、流结束）都算连接还活着：
      // 重置空闲定时器。
      window.clearTimeout(idleTimer);
      idleTimer = window.setTimeout(() => {
        controller.abort();
      }, streamIdleTimeoutMs);
      buffer += decoder.decode(value, {stream: !done});
      // 事件边界同时认 \n\n 和 \r\n\r\n。
      const parts = buffer.split(/\r?\n\r?\n/);
      if (done) {
        buffer = '';
      } else {
        buffer = parts.pop() ?? '';
      }
      for (const part of parts) {
        for (const piece of piecesFromEvent(part)) {
          if (piece.kind === 'stream-end') {
            streamEnd = true;
          }
          if (piece.kind === 'done') {
            // done 帧不参与 delivered/内容：它只说结局。一条流至多一帧，
            // 万一多帧（防御）以最后一帧为准。
            turnDone = piece.turn;
          }
          if (piece.kind === 'text') {
            onDelta(piece.text);
          }
          if (piece.kind === 'progress') {
            // 进度帧不算 delivered，不参与结局判定。
            onProgress?.(piece.name, piece.status);
          }
        }
      }
      if (done) {
        return {streamEnd, turnDone};
      }
    }
  } finally {
    window.clearTimeout(idleTimer);
    reader.releaseLock();
  }
}

type StreamPiece =
  | {kind: 'text'; text: string}
  | {kind: 'progress'; name: string; status: string}
  /** data: [DONE]：中继走完。 */
  | {kind: 'stream-end'}
  /** event: done 命名事件：这一轮的结局随流明说。 */
  | {kind: 'done'; turn: TurnDone};

/**
 * event: done 帧的 data：这一轮的结局随流明说（authoritative）。
 * reason 词汇固定：stop（用户按停）、upstream（上游失败）、
 * internal（服务器这边出错）；正常写完为 null。
 */
export type TurnDone = {
  turnId: string;
  status: 'completed' | 'aborted' | 'failed';
  reason: string | null;
  bytesSent: number;
};

/**
 * done 帧 → 页面结局：completed 是写完了；aborted 是用户按了停止；
 * failed 映射成 interrupted，保留页面的「可重试」语义——恢复流程随后
 * 按数据库核对并修正，失败脚注和重试按钮由消息上的标志驱动。
 */
function outcomeFromTurnDone(turn: TurnDone): ReplyOutcome {
  if (turn.status === 'completed') {
    return 'completed';
  }
  if (turn.status === 'aborted') {
    return 'aborted';
  }
  return 'interrupted';
}

/**
 * 把一个事件拆成片段列表。先扫 `event:` 行取事件名：progress 命名事件把
 * data 解析成节点名和状态词；done 命名事件把 data 解析成这一轮的结局
 * （TurnDone）；其他非空事件名的 data 整个忽略（给将来别的命名事件留位）；
 * 没有 event: 行时按无名事件认 data。
 *
 * 按 SSE 规范，同一事件里多条 data 行先用 \n 连成一帧再解析；连起来解析
 * 不出来时退回逐行认：坏的行丢掉，其余的行（可能有 [DONE]）照常处理——
 * 一帧坏 JSON 只拖累它自己。
 */
function piecesFromEvent(event: string): StreamPiece[] {
  const dataLines: string[] = [];
  let eventName = '';
  for (const rawLine of event.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('event:')) {
      // SSE 规范里后出现的 event: 行覆盖事件名缓冲区：认最后一条。
      eventName = line.slice('event:'.length).trim();
      continue;
    }
    if (!line.startsWith('data:')) {
      continue;
    }
    dataLines.push(line.slice('data:'.length).trim());
  }
  if (eventName !== '') {
    if (eventName === 'progress') {
      const piece = progressFromData(dataLines.join('\n'));
      return piece === null ? [] : [piece];
    }
    if (eventName === 'done') {
      const piece = turnDoneFromData(dataLines.join('\n'));
      return piece === null ? [] : [piece];
    }
    // 未知的命名事件：data 整帧忽略。
    return [];
  }
  if (dataLines.length === 0) {
    return [];
  }
  if (dataLines.length === 1) {
    // 上面刚判过 dataLines.length === 1，首元素必然存在
    const piece = pieceFromData(dataLines[0]!);
    return piece === null ? [] : [piece];
  }
  const joined = pieceFromData(dataLines.join('\n'));
  if (joined !== null) {
    return [joined];
  }
  const pieces: StreamPiece[] = [];
  for (const data of dataLines) {
    const piece = pieceFromData(data);
    if (piece !== null) {
      pieces.push(piece);
    }
  }
  return pieces;
}

/**
 * 认一帧 progress 的 data：JSON 里的 name 和 status 都必须是字符串，
 * 否则（包括解析失败）整个忽略这一帧。
 */
function progressFromData(data: string): StreamPiece | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (
      isRecord(payload) &&
      typeof payload.name === 'string' &&
      typeof payload.status === 'string'
    ) {
      return {kind: 'progress', name: payload.name, status: payload.status};
    }
  } catch {
    // 这一帧的 JSON 是坏的，整个忽略。
  }
  return null;
}

/**
 * 认一帧 done 的 data：turn_id 必须是字符串，status 必须是三个结局词之一，
 * bytes_sent 必须是数字，reason 必须是 null 或字符串（缺失按 null）；
 * 任何一个字段不合就把这一帧整个忽略——坏帧宁可丢掉，也不能解出一个
 * 错误的结局。
 */
function turnDoneFromData(data: string): StreamPiece | null {
  try {
    const payload: unknown = JSON.parse(data);
    if (!isRecord(payload)) {
      return null;
    }
    const turnId = payload.turn_id;
    const status = payload.status;
    const reason = payload.reason;
    const bytesSent = payload.bytes_sent;
    if (typeof turnId !== 'string' || typeof bytesSent !== 'number') {
      return null;
    }
    if (status !== 'completed' && status !== 'aborted' && status !== 'failed') {
      return null;
    }
    if (reason !== null && reason !== undefined && typeof reason !== 'string') {
      return null;
    }
    return {kind: 'done', turn: {turnId, status, reason: reason ?? null, bytesSent}};
  } catch {
    // 这一帧的 JSON 是坏的，整个忽略。
    return null;
  }
}

/** 认一帧 data：[DONE] 是收尾，JSON 是一段增量；解析失败就丢掉这一帧。 */
function pieceFromData(data: string): StreamPiece | null {
  if (data === '[DONE]') {
    return {kind: 'stream-end'};
  }
  try {
    const content = contentFromPayload(JSON.parse(data));
    if (content) {
      return {kind: 'text', text: content};
    }
  } catch {
    // 这一帧的 JSON 是坏的，丢掉。
  }
  return null;
}

function contentFromPayload(payload: unknown): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.choices) || payload.choices.length === 0) {
    return null;
  }
  const first: unknown = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.delta)) {
    return null;
  }
  const content = first.delta.content;
  if (typeof content !== 'string' || content === '') {
    return null;
  }
  return content;
}
