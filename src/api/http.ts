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

export async function requestEmpty(path: string, init?: { method?: string }): Promise<void> {
  const response = await request(path, init);
  if (response.status === 204) {
    return;
  }
  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response));
  }
}

export async function requestJson(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  const response = await request(path, init);
  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response));
  }

  try {
    return await response.json();
  } catch {
    throw new ApiError(0, null);
  }
}

async function request(path: string, init?: { method?: string; body?: string }): Promise<Response> {
  try {
    return await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: init?.body,
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
