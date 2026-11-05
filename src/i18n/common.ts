import type {Locale} from '../type/locale.ts';

/**
 * 通用词条：跨页面共用的动作词、导航词和页面级提示。
 * 每个域文件都是这个结构：简中对象是形状基准，类型从它推导（typeof），
 * 繁中和英文显式标注成同一个类型——任何一种语言缺一个键、拼错一个键，
 * 都是 tsc 编译错误，不会留到运行时渲染成空白。
 */
const zhCN = {
  language: '语言',
  profile: '系统设置',
  close: '关闭',
  cancel: '取消',
  actionFailed: '操作没成功，请再试一次',
  pageError: '页面出了点问题',
  refreshPage: '刷新页面',
};

export type CommonCopy = typeof zhCN;

const zhTW: CommonCopy = {
  language: '語言',
  profile: '系統設定',
  close: '關閉',
  cancel: '取消',
  actionFailed: '操作沒成功，請再試一次',
  pageError: '頁面出了點問題',
  refreshPage: '重新整理頁面',
};

const en: CommonCopy = {
  language: 'Language',
  profile: 'System settings',
  close: 'Close',
  cancel: 'Cancel',
  actionFailed: "That didn't work. Please try again.",
  pageError: 'Something went wrong',
  refreshPage: 'Reload page',
};

export const common: Record<Locale, CommonCopy> = {'zh-CN': zhCN, 'zh-TW': zhTW, en};
