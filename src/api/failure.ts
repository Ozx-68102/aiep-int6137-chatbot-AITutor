import {translations, type Messages} from '../i18n/index.ts';
import type {Locale} from '../type/locale.ts';
import {ApiError, TransportError, UnexpectedResponseError} from './http.ts';

/**
 * HTTP 状态码 → errors 域文案键的映射表。只收跨端点语义稳定的状态码：
 *
 * - 401 不在表里：同一个 401 可能是「密码不对」（登录端点自己的 401 不带
 *   reason）也可能是「会话过期/账号被停用」（带 reason），只按状态码分流会
 *   把前者误报成后者。mapError 里按 reason 单独分流。
 * - 状态 0 也不在表里：那是「请求没到服务器」（TransportError），连接类失败
 *   的保底文案由调用方自己定（多数传 connectionError，个别传 actionFailed），
 *   映射表拦截反而改掉调用方的选择。408 是服务器/网关报的超时，映射到
 *   requestTimeout。
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
  if (error instanceof UnexpectedResponseError) {
    // 服务器答话了，但答的内容用不了：说「服务器返回了看不懂的内容」，
    // 不占用「连不上」这个说法——那会把人引去查网络。
    return translations[locale].responseUnexpected;
  }
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

/**
 * 这次失败算不算「连不上服务器」——调用方据此决定挂服务横幅还是弹行内提示。
 *
 * 只有真的够不着才算：请求没送到、没等到回应、超时。
 *
 * 「服务器答话了但内容用不了」分两种：2xx 却读不懂正文（响应形状不对，
 * 属于两边对不上版本），这不算连不上，如实说内容看不懂；非 2xx 却读不出
 * detail（网关 502 的 HTML 错误页就是这种），仍然算连不上——服务确实用
 * 不了，页面照旧挂「无法连接到服务器」的横幅。
 */
export function connectionFailure(error: unknown): boolean {
  if (error instanceof TransportError) {
    return true;
  }
  if (error instanceof UnexpectedResponseError) {
    return false;
  }
  if (error instanceof ApiError) {
    return error.status >= 500 && error.detail === null;
  }
  // 不是 ApiError 的异常来源不明（多半是代码自身的 bug）。维持旧行为按
  // 连接类处理，不在这条修复里改它的去向。
  return true;
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

/** 登录提交的三种结局，表单拿它决定按钮的下一步：'ok' 进应用；'failure' 是
 * 服务器明确拒绝（密码不对、人机验证被拒、限流等）——按钮锁住，直到用户
 * 改动用户名或密码；'connection' 是连不上服务器——与输入内容无关，按钮
 * 保持可点，再点一次就是一轮全新验证。 */
export type LoginOutcome = 'ok' | 'failure' | 'connection';
