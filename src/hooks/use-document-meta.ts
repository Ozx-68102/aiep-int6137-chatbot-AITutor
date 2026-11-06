import {useEffect} from 'react';
import {htmlLang, type Locale} from '../type/locale.ts';

const appTitle = 'H^2 Bot';
// 会话标题是学生随手输入的，可能很长：标签页标题截短，别把标签撑爆。
const maxPageTitleLength = 30;

/**
 * 文档元信息的统一入口（O8）：<html> 的 lang 属性和标签页标题两件事，
 * 原先在 ChatApp 和 AdminConsole 里各有一份同款效果，收拢到这一个钩子。
 *
 * 标题规则（N11）：pageTitle 有值就是「{pageTitle} - H^2 Bot」（过长的
 * 标题先截断）；不传或为空就只是「H^2 Bot」。document.title 是纯文本
 * 赋值，会话标题再离谱也没有注入风险。
 */
export function useDocumentMeta(locale: Locale, pageTitle?: string | null): void {
  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    const name = pageTitle?.trim() ?? '';
    if (name === '') {
      document.title = appTitle;
      return;
    }
    const short = name.length > maxPageTitleLength ? `${name.slice(0, maxPageTitleLength)}…` : name;
    document.title = `${short} - ${appTitle}`;
  }, [locale, pageTitle]);
}
