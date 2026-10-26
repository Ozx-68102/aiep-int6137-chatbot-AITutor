import {ApiError} from './http.ts';

export function explain(error: unknown, connection: string): string {
  if (error instanceof ApiError && error.detail) {
    return error.detail;
  }
  return connection;
}

export function connectionFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || error.detail === null;
}
