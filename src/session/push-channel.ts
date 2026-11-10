import {ApiError, isRecord} from '../api/http.ts';
import {readProfile} from '../api/profile.ts';

/**
 * 推送通道 /api/events：服务器把「你的登录态没了」主动推给这个账号所有
 * 开着的页面，页面不再等下一次请求收到 401 才知道。契约见
 * docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「推送通道」：
 *
 * - 登录成功后 new EventSource("/api/events")：同源请求自动带 cookie，
 *   不需要也不能另设请求头；每个标签页各挂一条。
 * - 命名事件 'state'。连上第一帧必达 {"valid":true,"account":用户名}；
 *   断线重连成功后也先收到它——状态天然补齐，不用另写补状态逻辑。
 * - 登录态失效时推 {"valid":false,"reason":"expired|password_changed|admin_reset",
 *   "message":文案}，随后服务器主动结束这条流；不认识的 reason 也按失效处理。
 * - 心跳是 15 秒一帧的 ": ping" 注释帧，EventSource 自动忽略。
 * - 连接被彻底关掉（readyState 变成 CLOSED）时不直接放弃：先探一次
 *   /api/profile 分辨「登录态真的没了」和「只是服务暂时不通」。前者照旧
 *   不再重连（那是契约里的预期结局），后者按指数退避重新建一条——临时
 *   故障不该让推送能力一直失灵到用户重新登录。
 */

/** 断线重连的退避：从 1 秒起、每次翻倍、封顶 30 秒。 */
const reconnectStartMs = 1000;
const reconnectMaxMs = 30000;

export type PushChannel = {
  /** 关掉这条连接：登出、回到登录界面、页面卸载时调用。 */
  close(): void;
};

/**
 * 建一条推送通道连接。onInvalid 收失效帧里的 reason 原词和服务器建议文案
 *（reason 可能是词表之外的词，调用方一律按登录态失效处理；message 可能缺失）。
 */
export function openPushChannel(
  onInvalid: (reason: string, message: string | null) => void,
): PushChannel {
  let stopped = false;
  // 世代编号：关掉通道时加一，在途的探测和排队中的重连回来后发现编号
  // 对不上就退出，不会在关掉之后又建出新连接。
  let generation = 0;
  let source: EventSource | null = null;
  let timer = 0;
  let attempt = 0;

  function stop(): void {
    stopped = true;
    generation += 1;
    window.clearTimeout(timer);
    if (source !== null) {
      source.close();
      source = null;
    }
  }

  function later(gen: number, run: () => void, delayMs: number): void {
    if (stopped || gen !== generation) {
      return;
    }
    timer = window.setTimeout(() => {
      if (stopped || gen !== generation) {
        return;
      }
      run();
    }, delayMs);
  }

  /**
   * 问一次「登录态还在吗」。401 是服务器明确说没了；其余（网络错、
   * 5xx、响应读不懂）都算「这一趟问不出来」，退避后再问。
   */
  async function sessionAlive(gen: number): Promise<boolean> {
    try {
      await readProfile();
      return !stopped && gen === generation;
    } catch (error) {
      if (stopped || gen !== generation) {
        return false;
      }
      if (error instanceof ApiError && error.status === 401) {
        // 登录态真的没了：与收到失效帧同一套处理，不再重连。
        stop();
        onInvalid('expired', null);
        return false;
      }
      const delay = Math.min(reconnectStartMs * 2 ** attempt, reconnectMaxMs);
      attempt += 1;
      later(gen, () => void recover(gen), delay);
      return false;
    }
  }

  async function recover(gen: number): Promise<void> {
    if (stopped || gen !== generation) {
      return;
    }
    if (await sessionAlive(gen)) {
      attempt = 0;
      connect(gen);
      return;
    }
    // 问不出来：本趟的重连已经排在退避里，或者已经被判定为失效、不再重连。
  }

  function connect(gen: number): void {
    if (stopped || gen !== generation) {
      return;
    }
    const next = new EventSource('/api/events');
    source = next;
    next.addEventListener('state', (event) => {
      const data = (event as MessageEvent).data;
      let payload: unknown;
      try {
        payload = typeof data === 'string' ? JSON.parse(data) : null;
      } catch {
        // 坏帧丢掉，不影响后面的帧。
        return;
      }
      if (!isRecord(payload) || payload.valid !== false) {
        // {"valid":true}（连上、重连补齐状态）和解析不出来的帧都不用动作。
        return;
      }
      const reason = typeof payload.reason === 'string' ? payload.reason : '';
      const message = typeof payload.message === 'string' ? payload.message : null;
      onInvalid(reason, message);
    });
    next.onerror = () => {
      if (stopped || gen !== generation) {
        return;
      }
      if (next.readyState !== EventSource.CLOSED) {
        // CONNECTING：浏览器自己在重连（断网、服务重启），交给它，不干预。
        return;
      }
      // CLOSED：这条连接被彻底关掉了。EventSource 不告诉我们原因——
      // 服务返回 502 这种临时故障也是 CLOSED，与「登录态失效后重连吃
      // 401」长得一模一样，所以不能一律当成预期结局，探一次再决定。
      next.close();
      if (source === next) {
        source = null;
      }
      void recover(gen);
    };
  }

  connect(generation);

  return {
    close: () => {
      stop();
    },
  };
}
