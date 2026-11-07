import {ApiError, isRecord, requestEmpty, requestJson} from './http.ts';

/** 账号的角色：学生用 chat，管理员用 admin。 */
export type AdminRole = 'chat' | 'admin';

export type AdminAccount = {
  username: string;
  role: AdminRole;
};

export type AdminSession = {
  username: string;
};

/** 一次性的新密码：服务器只在这一次回显，之后再也问不到。 */
export type ResetPasswordResult = {
  username: string;
  password: string;
};

export async function adminLogin(
  username: string,
  password: string,
  turnstileToken: string,
): Promise<AdminSession> {
  const value = await requestJson('/api/admin/login', {
    method: 'POST',
    // cf-turnstile-response 是 Cloudflare 的约定字段名：后端 LoginRequest 用 alias 接。
    body: JSON.stringify({username, password, 'cf-turnstile-response': turnstileToken}),
  });
  if (!isRecord(value) || typeof value.username !== 'string') {
    throw new ApiError(0, null);
  }
  return {username: value.username};
}

export async function fetchAdminAccounts(): Promise<AdminAccount[]> {
  const value = await requestJson('/api/admin/accounts');
  if (!isRecord(value) || !Array.isArray(value.accounts)) {
    throw new ApiError(0, null);
  }
  const accounts: AdminAccount[] = [];
  for (const item of value.accounts) {
    if (
      !isRecord(item) ||
      typeof item.username !== 'string' ||
      (item.role !== 'chat' && item.role !== 'admin')
    ) {
      throw new ApiError(0, null);
    }
    accounts.push({username: item.username, role: item.role});
  }
  return accounts;
}

/** 重置一个账号的密码。这个账号所有设备的登录都会被强制下线。 */
export async function adminResetPassword(username: string): Promise<ResetPasswordResult> {
  const value = await requestJson('/api/admin/accounts/reset-password', {
    method: 'POST',
    body: JSON.stringify({username}),
  });
  if (
    !isRecord(value) ||
    typeof value.username !== 'string' ||
    typeof value.password !== 'string'
  ) {
    throw new ApiError(0, null);
  }
  return {username: value.username, password: value.password};
}

export async function adminLogout(): Promise<void> {
  await requestEmpty('/api/admin/logout', {method: 'POST'});
}
