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
  /** 只有 401 才可能有：会话失效的原因。其余状态、老后端的 401 都是 null。 */
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
      const connectionish = !(error instanceof ApiError) || error.detail === null;
      attempt += 1;
      // 非连接错直接抛；连接错重试到次数用尽，最后一个也原样抛出去。
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
        throw new ApiError(response.status, failure.detail, failure.reason, failure.code);
      }

      try {
        return await response.json();
      } catch {
        throw new ApiError(0, null);
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
      // 这里再硬编码成 json 就坏了。空对象占位与不传一样：浏览器照样自己带
      // multipart 头；exactOptionalPropertyTypes 下这里不能写显式 undefined。
      headers:
        init?.body === undefined || init.body instanceof FormData
          ? {}
          : {'Content-Type': 'application/json'},
      // body 可以缺省：fetch 对 null 和 undefined 一视同仁（都不带请求体）
      body: init?.body ?? null,
      // 超时到点就中止。中止抛的错在下面统一包装成 ApiError(0, null)，
      // 归入 connectionFailure 的判定，表现成网络类失败。
      signal: AbortSignal.timeout(
        init?.body instanceof FormData ? uploadTimeoutMs : requestTimeoutMs,
      ),
    });
  } catch {
    throw new ApiError(0, null);
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
