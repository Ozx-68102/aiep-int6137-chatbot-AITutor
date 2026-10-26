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

export async function requestJson(path: string, init?: { method?: string; body?: string }): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: init?.method ?? 'GET',
      credentials: 'include',
      headers: init?.body === undefined ? undefined : {'Content-Type': 'application/json'},
      body: init?.body,
    });
  } catch {
    throw new ApiError(0, null);
  }

  if (!response.ok) {
    throw new ApiError(response.status, await readDetail(response));
  }

  try {
    return await response.json();
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
