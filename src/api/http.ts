/**
 * 会话类 401 的原因词表（docs/ACCOUNT_MANAGEMENT.md「会话状态通道」的最小
 * HTTP 版）：expired = 令牌不认识/已过期/被吊销；disabled = 账号被停用。
 * 后端现在只会发出 expired（停用列还没建），词表在两端先接好。
 */
export type AuthFailureReason = 'expired' | 'disabled';

/**
 * 403「必须修改密码」拦截的 code 值（契约见
 * docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「必须改密标记」）：被服务器打了
 * 标记的账号请求豁免清单之外的路径，会收到 403、响应体
 * {"detail":"请先修改密码，然后才能继续使用","code":"must_change_password"}。
 */
export const mustChangePasswordCode = 'must_change_password';

/**
 * 收到上面那种 403 时广播的自定义事件名（与 src/session/poll.ts 的
 * networkOkEvent 同款做法）：App.tsx 监听它进入强制修改密码的拦截。
 * 事件同步派发：监听器在错误往上抛之前就会执行。
 */
export const mustChangePasswordEvent = 'h2bot:must-change-password';

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;
  /** 只有 401 才可能有：会话失效的原因。其余状态、旧后端的 401 都是 null。 */
  readonly reason: AuthFailureReason | null;
  /** 响应体里的业务标记（比如 403 的 must_change_password）；没有就是 null。 */
  readonly code: string | null;

  constructor(
    status: number,
    detail: string | null,
    reason: AuthFailureReason | null = null,
    code: string | null = null,
  ) {
    super(detail ?? '');
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.reason = reason;
    this.code = code;
  }
}

/**
 * 请求根本没到服务器，或者没等到回应（网络异常、跨域失败、超时中止）。
 * 只有这一类才是「连不上服务器」——服务端返回了错误状态码、或者返回了
 * 读不懂的内容，都说明服务器可以连通，不该占用这个说法。
 */
export class TransportError extends ApiError {
  constructor() {
    super(0, null);
    this.name = 'TransportError';
  }
}

/**
 * 服务器答话了，但答的内容用不了：非 2xx 却读不出 detail，或者 2xx 的正文
 * 不是合法 JSON、形状对不上约定的字段。带上真实的 HTTP 状态码（读不懂正文
 * 时是 200），不再伪装成 0——0 留给「没到服务器」。
 */
export class UnexpectedResponseError extends ApiError {
  // 默认 200：调用方在校验响应形状时手上没有状态码，而能走到校验说明
  // 请求本身是成功的（requestJson 没抛错）。正文读不懂那种传真实状态码。
  constructor(status: number = 200) {
    super(status, null);
    this.name = 'UnexpectedResponseError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const connectionAttempts = 4;
const connectionRetryDelayMs = 300;
/** 普通请求的超时（毫秒）。 */
const requestTimeoutMs = 15000;
/** 上传（FormData，比如头像）的超时（毫秒）：大文件传得慢，放宽。 */
const uploadTimeoutMs = 60000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/**
 * 连接层面的重试：retry 打开时最多试 connectionAttempts 次，默认只跑一次。
 * 重发会不会做出两份副作用，这里判断不了，由调用方决定开不开。
 */
export async function withConnectionRetry<T>(
  run: () => Promise<T>,
  options?: {retry?: boolean},
): Promise<T> {
  const attempts = options?.retry === true ? connectionAttempts : 1;
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      const connectionish = shouldRetry(error);
      attempt += 1;
      // 只重试传输层的失败；连接错重试到次数用尽，最后一个也原样抛出去。
      // 用 for(;;) 是刻意的：循环体每条路径要么 return 要么 throw，不存在
      // 第三种出口，函数因此不需要循环后的保底 throw。旧版在这里有一句
      // 合成 `new ApiError(0, null)`——运行时永远执行不到，只为满足编译
      // 器的终端检查而存在，2026-11-05 外部代码审计判定为死代码后移除；
      // 顺带的好处是耗尽时抛出去的是真实错误对象，不是合成的空壳。
      if (!connectionish || attempt >= attempts) {
        throw error;
      }
      await wait(connectionRetryDelayMs);
    }
  }
}

/**
 * 值不值得再发一次：只有「请求没到服务器」这一类值得。
 *
 * 服务器已经答话的错误不重试，包括 502/503/504——那是服务端或网关在报
 * 故障，重发只会让故障期间的请求量翻几倍，还拖慢错误提示的出现。响应读
 * 不懂（UnexpectedResponseError）同样不重试：重发一次还是同样的正文。
 * 其他非 ApiError 的异常来源不明，也交给调用方，不在这里盲目重发。
 */
function shouldRetry(error: unknown): boolean {
  return error instanceof TransportError;
}

/**
 * 只有 GET 默认自动重试：创建、登录、停止、重命名、置顶这些都是非幂等
 * 请求，连接断了再盲目重发一次可能做出两份。调用方明确知道能重发时，
 * 传 retry: true 打开。
 */
function autoRetry(init?: {method?: string; retry?: boolean}): boolean {
  return init?.retry ?? (init?.method ?? 'GET') === 'GET';
}

export async function requestEmpty(
  path: string,
  init?: {method?: string; body?: string | FormData | undefined; retry?: boolean},
): Promise<void> {
  await withConnectionRetry(
    async () => {
      const response = await request(path, init);
      if (response.status === 204) {
        return;
      }
      if (!response.ok) {
        const failure = await readFailure(response);
        // 状态码保留：这是服务器给的答复，即使正文读不出 detail。
        throw new ApiError(response.status, failure.detail, failure.reason, failure.code);
      }
    },
    {retry: autoRetry(init)},
  );
}

export async function requestJson(
  path: string,
  init?: {method?: string; body?: string | FormData | undefined; retry?: boolean},
): Promise<unknown> {
  return withConnectionRetry(
    async () => {
      const response = await request(path, init);
      if (!response.ok) {
        const failure = await readFailure(response);
        // 状态码保留：这是服务器给的答复，即使正文读不出 detail。
        throw new ApiError(response.status, failure.detail, failure.reason, failure.code);
      }

      try {
        return await response.json();
      } catch {
        // 状态码是成功的，正文却读不懂：服务器可以连通，是内容用不了。
        throw new UnexpectedResponseError(response.status);
      }
    },
    {retry: autoRetry(init)},
  );
}

async function request(
  path: string,
  init?: {method?: string; body?: string | FormData | undefined; retry?: boolean},
): Promise<Response> {
  try {
    return await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      // FormData 的 Content-Type 由浏览器自己带（里面要带 boundary），
      // 这里再固定写成 json 就会出错。空对象占位与不传一样：浏览器照样自己带
      // multipart 头；exactOptionalPropertyTypes 下这里不能写显式 undefined。
      headers:
        init?.body === undefined || init.body instanceof FormData
          ? {}
          : {'Content-Type': 'application/json'},
      // body 可以缺省：fetch 对 null 和 undefined 一视同仁（都不带请求体）
      body: init?.body ?? null,
      // 超时到点就中止。中止抛的错在下面统一包装成 TransportError，
      // 表现成网络类失败。
      signal: AbortSignal.timeout(
        init?.body instanceof FormData ? uploadTimeoutMs : requestTimeoutMs,
      ),
    });
  } catch {
    // fetch 自己抛错：请求没送出去、没等到回应，或者被超时中止。
    throw new TransportError();
  }
}

/**
 * 非 2xx 响应体里的完整失败信息：中文的 detail 句子 + 401 的 reason 词 +
 * 业务标记 code（比如 403 的 must_change_password）。
 */
export type ApiFailure = {
  detail: string | null;
  reason: AuthFailureReason | null;
  code: string | null;
};

export async function readFailure(response: Response): Promise<ApiFailure> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.detail !== 'string') {
      return {detail: null, reason: null, code: null};
    }
    const code = typeof body.code === 'string' ? body.code : null;
    if (response.status === 403 && code === mustChangePasswordCode) {
      // 全局保底：任何请求被「必须修改密码」的 403 拦下，都在这里广播一次
      // 事件，App.tsx 监听后进入强制修改密码的拦截，不用每个调用方各自处理。
      window.dispatchEvent(new Event(mustChangePasswordEvent));
    }
    return {detail: body.detail, reason: readReason(response.status, body), code};
  } catch {
    return {detail: null, reason: null, code: null};
  }
}

/** reason 只认 401，且只收词表里的 expired/disabled 两个值；其余一律当没有。 */
function readReason(status: number, body: Record<string, unknown>): AuthFailureReason | null {
  if (status !== 401) {
    return null;
  }
  return body.reason === 'expired' || body.reason === 'disabled' ? body.reason : null;
}
