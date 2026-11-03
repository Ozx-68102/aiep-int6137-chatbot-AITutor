import {useEffect, useRef, useState} from 'react';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError} from '../api/http.ts';
import {updateProfile, uploadAvatar} from '../api/profile.ts';
import {translations} from '../i18n.ts';
import {saveCachedProfile} from '../session/profile-cache.ts';
import type {Locale} from '../type/locale.ts';

type ProfileActionsDeps = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  setUsername: (username: string) => void;
  setAvatarUrl: (url: string | null) => void;
  onEnterLogin: (detail: string | null) => void;
  onConnectionWarning: () => void;
};

/**
 * 设置里改资料的两个动作：换语言、换头像，连带各自的 busy 状态。
 * 错误共用一份 profileError——设置弹窗和退出确认弹窗显示的是同一个位置。
 */
export function useProfileActions(deps: ProfileActionsDeps) {
  const [savingLocale, setSavingLocale] = useState(false);
  const [savingAvatar, setSavingAvatar] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  // 异步流程可能跨渲染：依赖放进 ref，镜像在效果里做（渲染期间写 ref 被禁止）。
  const depsRef = useRef(deps);
  useEffect(() => {
    depsRef.current = deps;
  });

  async function changeLocale(next: Locale) {
    const current = depsRef.current;
    if (next === current.locale || savingLocale) {
      return;
    }
    setSavingLocale(true);
    setProfileError(null);
    try {
      const profile = await updateProfile(next);
      current.setUsername(profile.username);
      current.setLocale(profile.locale);
      current.setAvatarUrl(profile.avatarUrl);
      saveCachedProfile({username: profile.username, locale: profile.locale});
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        current.onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        current.onConnectionWarning();
        return;
      }
      setProfileError(explain(error, translations[current.locale].connectionError));
    } finally {
      setSavingLocale(false);
    }
  }

  async function pickAvatar(file: File) {
    if (savingAvatar) {
      return;
    }
    const current = depsRef.current;
    setSavingAvatar(true);
    setProfileError(null);
    try {
      const profile = await uploadAvatar(file);
      current.setAvatarUrl(profile.avatarUrl);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        current.onEnterLogin(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        current.onConnectionWarning();
        return;
      }
      setProfileError(explain(error, translations[current.locale].connectionError));
    } finally {
      setSavingAvatar(false);
    }
  }

  return {profileError, setProfileError, savingLocale, savingAvatar, changeLocale, pickAvatar};
}
