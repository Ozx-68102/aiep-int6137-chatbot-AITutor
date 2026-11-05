import type {Locale} from '../type/locale.ts';

/** 错误与降级提示词条：连接兜底和服务状态降级提示。 */
const zhCN = {
  connectionError: '无法连接到服务器',
  connectionRetry: '无法连接到服务器，请稍后重试',
  serviceUnavailable: '服务暂时不可用，请稍后重试',
  replyStoreUnavailable: '半截回答功能不可用，刷新后接不上上一轮',
};

export type ErrorsCopy = typeof zhCN;

const zhTW: ErrorsCopy = {
  connectionError: '無法連接到伺服器',
  connectionRetry: '無法連接到伺服器，請稍後重試',
  serviceUnavailable: '服務暫時不可用，請稍後重試',
  replyStoreUnavailable: '半截回答功能不可用，重新整理後接不上一輪',
};

const en: ErrorsCopy = {
  connectionError: 'Unable to connect to the server',
  connectionRetry: 'Unable to connect to the server. Please try again later.',
  serviceUnavailable: 'The service is temporarily unavailable, please try again later',
  replyStoreUnavailable: 'Resuming an interrupted reply is unavailable right now',
};

export const errors: Record<Locale, ErrorsCopy> = {'zh-CN': zhCN, 'zh-TW': zhTW, en};
