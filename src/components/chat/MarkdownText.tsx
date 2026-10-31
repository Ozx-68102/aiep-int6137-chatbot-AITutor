import {memo} from 'react';
import type {Components} from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// 组件表：链接在新窗口打开；图片不真加载，只留一个链接；表格外面套一层可以横着滚。
const components: Components = {
  a({href, children}) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  img({src, alt}) {
    const address = src ?? '';
    if (address === '') {
      return <span>{alt ?? ''}</span>;
    }
    return (
      <a href={address} target="_blank" rel="noopener noreferrer">
        {alt === undefined || alt === '' ? address : alt}
      </a>
    );
  },
  table({children}) {
    return (
      <div className="markdown-table-wrap">
        <table>{children}</table>
      </div>
    );
  },
};

/**
 * 助手回答里的 Markdown。
 *
 * 库默认不解析原始 HTML（HTML 会当文字显示），链接和图片的地址也只放行
 * http、https、mailto 这些协议，所以不用额外做转义。
 */
export const MarkdownText = memo(function MarkdownText({text}: {text: string}) {
  return (
    <div className="markdown">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  );
});
