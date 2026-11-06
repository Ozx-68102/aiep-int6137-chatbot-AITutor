import {cacheAvatarData} from '../session/profile-cache.ts';
import {isLocale, type Locale} from '../type/locale.ts';
import {ApiError, isRecord, requestEmpty, requestJson} from './http.ts';

/** 默认头像在前端的静态资源里。接口服务给不出头像时就用这张。 */
export const defaultAvatarUrl = '/avatar-default.svg';

export type Profile = {
  id: string;
  username: string;
  locale: Locale;
  /** 头像的地址。换头像以后地址会变（后面带内容哈希）。 */
  avatarUrl: string;
};

export async function readProfile(): Promise<Profile> {
  return parseProfile(await requestJson('/api/profile'));
}

export async function updateProfile(locale: Locale): Promise<Profile> {
  return parseProfile(
    await requestJson('/api/profile', {
      method: 'PATCH',
      body: JSON.stringify({locale}),
    }),
  );
}

export async function uploadAvatar(file: File): Promise<Profile> {
  const body = new FormData();
  body.append('file', file);
  return parseProfile(await requestJson('/api/avatar', {method: 'POST', body}));
}

export async function logout(): Promise<void> {
  await requestEmpty('/api/logout', {method: 'POST'});
}

/** 修改密码。成功之后服务端会吊销这个账号所有设备的登录，当前设备也会被强制退回登录页。 */
export async function changePassword(
  oldPassword: string,
  newPassword: string,
  confirmPassword: string,
): Promise<void> {
  await requestEmpty('/api/password', {
    method: 'POST',
    body: JSON.stringify({
      old_password: oldPassword,
      new_password: newPassword,
      new_password_confirm: confirmPassword,
    }),
  });
}

function parseProfile(value: unknown): Profile {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.locale !== 'string' ||
    !isLocale(value.locale)
  ) {
    throw new ApiError(0, null);
  }
  // 生产环境字段是 snake_case：ProfileResponse 不像 ChatRequest 那几个请求模型
  // 带 camelCase 别名，后端发的是 avatar_url。此前这里误读 value.avatarUrl，
  // 真头像自 2026-11-02 引入起就一直退回默认图（离线头像缓存也因此从未
  // 生效），2026-11-06 修正。
  const avatarUrl =
    typeof value.avatar_url === 'string' && value.avatar_url !== ''
      ? value.avatar_url
      : defaultAvatarUrl;
  // 拿到真头像地址就顺手把图片数据缓存一份到本地，离线启动时不闪现默认图。
  // 默认头像是前端静态资源，离线也拿得到，不用缓存。缓存失败无所谓：
  // cacheAvatarData 内部静默降级，不挡住资料返回。
  if (avatarUrl !== defaultAvatarUrl) {
    void cacheAvatarData(avatarUrl);
  }
  return {
    id: value.id,
    username: value.username,
    locale: value.locale,
    avatarUrl,
  };
}
