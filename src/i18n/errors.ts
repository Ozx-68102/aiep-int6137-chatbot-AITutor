import type {Locale} from '../type/locale.ts';

/**
 * 错误与降级提示词条：连接保底文案、服务状态降级，以及按 HTTP 状态码映射的
 * 错误文案。
 *
 * 裁决规则（维护者决定；映射逻辑在 src/api/failure.ts 的 explain）：
 * - 简中界面：后端返回的 detail 存在就优先原样显示——自家规矩「前端提示
 *   必须与后端逐字一致」；没有 detail 才用这里的文案。
 * - 英文/繁中界面：优先用这里的映射文案；映射不到再退回 detail（后端只写
 *   简体中文，有也比没有强），最后退回调用方给的连接保底文案。
 */
const zhCN = {
  connectionError: '无法连接到服务器',
  connectionRetry: '无法连接到服务器，请稍后重试',
  serviceUnavailable: '服务暂时不可用，请稍后重试',
  replyStoreUnavailable: '半截回答功能不可用，刷新后接不上上一轮',
  requestTimeout: '请求超时了，请稍后重试',
  forbidden: '没有权限做这个操作',
  notFound: '找不到这个内容',
  validationFailed: '提交的内容没通过校验，请检查后再试',
  rateLimited: '操作太频繁了，请稍后重试',
  serverError: '服务器出错了，请稍后重试',
  upstreamError: '上游服务出了故障，请稍后重试',
  responseUnexpected: '服务器返回了看不懂的内容，请稍后重试或刷新页面',
};

export type ErrorsCopy = typeof zhCN;

const zhTW: ErrorsCopy = {
  connectionError: '無法連接到伺服器',
  connectionRetry: '無法連接到伺服器，請稍後重試',
  serviceUnavailable: '服務暫時不可用，請稍後重試',
  replyStoreUnavailable: '半截回答功能不可用，重新整理後接不上一輪',
  requestTimeout: '請求逾時了，請稍後重試',
  forbidden: '沒有權限做這個操作',
  notFound: '找不到這個內容',
  validationFailed: '提交的內容沒通過校驗，請檢查後再試',
  rateLimited: '操作太頻繁了，請稍後重試',
  serverError: '伺服器出錯了，請稍後重試',
  upstreamError: '上游服務出了故障，請稍後重試',
  responseUnexpected: '伺服器回傳了看不懂的內容，請稍後重試或重新整理頁面',
};

const en: ErrorsCopy = {
  connectionError: 'Unable to connect to the server',
  connectionRetry: 'Unable to connect to the server. Please try again later.',
  serviceUnavailable: 'The service is temporarily unavailable, please try again later',
  replyStoreUnavailable: 'Resuming an interrupted reply is unavailable right now',
  requestTimeout: 'The request timed out. Please try again later.',
  forbidden: 'You do not have permission to do this',
  notFound: 'This item was not found',
  validationFailed: 'The submitted details did not pass validation. Please check and try again.',
  rateLimited: 'Too many requests. Please try again later.',
  serverError: 'The server ran into a problem. Please try again later.',
  upstreamError: 'The upstream service failed. Please try again later.',
  responseUnexpected:
    'The server returned something we could not read. Please try again or reload the page.',
};

export const errors: Record<Locale, ErrorsCopy> = {'zh-CN': zhCN, 'zh-TW': zhTW, en};
