import {isRecord} from '../api/http.ts';

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
 * - 失效之后 EventSource 自动重连会收到 401（cookie 已失效）并彻底停止
 *   重试——这是预期行为，这里不做任何手动重连；重新登录成功后新建一条
 *   连接，不复用旧的。
 */

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
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
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
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      // 彻底放弃：失效后重连吃 401 停止是预期行为（契约见模块注释），
      // 不做手动重连；重新登录成功后会新建一条连接。close 是幂等的，
      // 顺手把这条已经死掉的连接收干净。
      source.close();
      return;
    }
    // 其余情况（CONNECTING）是浏览器在自动重连（断网、服务器重启），
    // 交给它，不干预。
  };
  return {
    close: () => {
      source.close();
    },
  };
}
