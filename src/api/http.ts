export class ApiError extends Error {
  readonly status: number;
  readonly detail: string | null;

  constructor(status: number, detail: string | null) {
    super(detail ?? '');
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
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
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const connectionish = !(error instanceof ApiError) || error.detail === null;
      const shouldRetry = connectionish && attempt < attempts - 1;
      if (!shouldRetry) {
        throw error;
      }
      await wait(connectionRetryDelayMs);
    }
  }
  throw new ApiError(0, null);
}

/**
 * 只有 GET 默认自动重试：创建、登录、停止、重命名、置顶这些都是非幂等
 * 请求，连接断了再盲发一次可能做出两份。调用方明确知道能重发时，
 * 传 retry: true 打开。
 */
function autoRetry(init?: {method?: string; retry?: boolean}): boolean {
  return init?.retry ?? (init?.method ?? 'GET') === 'GET';
}

export async function requestEmpty(
  path: string,
  init?: {method?: string; body?: string | FormData; retry?: boolean},
): Promise<void> {
  await withConnectionRetry(
    async () => {
      const response = await request(path, init);
      if (response.status === 204) {
        return;
      }
      if (!response.ok) {
        throw new ApiError(response.status, await readDetail(response));
      }
    },
    {retry: autoRetry(init)},
  );
}

export async function requestJson(
  path: string,
  init?: {method?: string; body?: string | FormData; retry?: boolean},
): Promise<unknown> {
  return withConnectionRetry(
    async () => {
      const response = await request(path, init);
      if (!response.ok) {
        throw new ApiError(response.status, await readDetail(response));
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
  init?: {method?: string; body?: string | FormData; retry?: boolean},
): Promise<Response> {
  try {
    return await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      // FormData 的 Content-Type 由浏览器自己带（里面要带 boundary），
      // 这里再写死成 json 就坏了。
      headers:
        init?.body === undefined || init.body instanceof FormData
          ? undefined
          : {'Content-Type': 'application/json'},
      body: init?.body,
      // 超时到点就中止。中止抛的错在下面统一包成 ApiError(0, null)，
      // 落进 connectionFailure 的判定，表现成网络类失败。
      signal: AbortSignal.timeout(
        init?.body instanceof FormData ? uploadTimeoutMs : requestTimeoutMs,
      ),
    });
  } catch {
    throw new ApiError(0, null);
  }
}

export async function readDetail(response: Response): Promise<string | null> {
  try {
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.detail !== 'string') {
      return null;
    }
    return body.detail;
  } catch {
    return null;
  }
}
