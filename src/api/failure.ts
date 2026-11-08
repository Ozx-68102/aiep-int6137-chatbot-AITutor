import {translations, type Messages} from '../i18n/index.ts';
import type {Locale} from '../type/locale.ts';
import {ApiError} from './http.ts';

/**
 * HTTP 状态码 → errors 域文案键的映射表。只收跨端点语义稳定的状态码：
 *
 * - 401 不在表里：同一个 401 可能是「密码不对」（登录端点自己的 401 不带
 *   reason）也可能是「会话过期/账号被停用」（带 reason），只按状态码分流会
 *   把前者误报成后者。mapError 里按 reason 单独分流。
 * - 状态 0 也不在表里：http.ts 把「连不上」和「客户端超时」都折叠成
 *   ApiError(0, null)，两种形态区分不了；而且连接类失败的保底文案由调用方
 *   自己定（多数传 connectionError，个别传 actionFailed），映射表拦截反而
 *   改掉调用方的选择。408 是服务器/网关报的超时，映射到 requestTimeout。
 */
const statusCopy: Partial<Record<number, keyof Messages>> = {
  403: 'forbidden',
  404: 'notFound',
  408: 'requestTimeout',
  422: 'validationFailed',
  429: 'rateLimited',
  500: 'serverError',
  502: 'upstreamError',
  503: 'serviceUnavailable',
};

/** 按映射表取本地化的错误文案；映射不到返回 null，由 explain 退回 detail 或保底文案。 */
function mapError(error: ApiError, locale: Locale): string | null {
  if (error.status === 401) {
    if (error.reason === 'expired') {
      return translations[locale].sessionExpired;
    }
    if (error.reason === 'disabled') {
      return translations[locale].accountDisabled;
    }
    // 不带 reason 的 401（比如登录密码不对）：不映射，退回后端 detail 原文。
    return null;
  }
  const key = statusCopy[error.status];
  return key === undefined ? null : translations[locale][key];
}

/**
 * 把抓到的错误改标成一句能显示在界面上的话。
 *
 * 裁决规则（维护者决定，词条在 src/i18n/errors.ts）：
 * - 简中界面：后端的 detail 存在就优先原样显示（「前端提示必须与后端逐字
 *   一致」）；没有 detail 再查状态码映射，还没有就退回调用方给的保底文案。
 * - 英文/繁中界面：先查状态码映射取本地化文案；映射不到退回 detail，
 *   再退回调用方给的保底文案。
 */
export function explain(error: unknown, locale: Locale, connection: string): string {
  if (locale === 'zh-CN' && error instanceof ApiError && error.detail) {
    return error.detail;
  }
  if (error instanceof ApiError) {
    const mapped = mapError(error, locale);
    if (mapped !== null) {
      return mapped;
    }
    if (error.detail) {
      return error.detail;
    }
  }
  return connection;
}

export function connectionFailure(error: unknown): boolean {
  return !(error instanceof ApiError) || error.detail === null;
}

/**
 * 会话类 401 的统一提示（2026-11 维护者决定）：后端 401 的 detail（如
 * 「未登录」）是内部口径，不对用户显示——凭证被注销一律「会话已过期，
 * 请重新登录」；disabled 是终态，保留「账号已被停用」。改密页与各动作的
 * 401 出口（onEnterLogin）都传这里的结果，登录屏读到的就是这句。
 */
export function sessionExpiredText(error: unknown, locale: Locale): string {
  if (error instanceof ApiError && error.reason === 'disabled') {
    return translations[locale].accountDisabled;
  }
  return translations[locale].sessionExpired;
}
