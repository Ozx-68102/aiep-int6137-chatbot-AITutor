import {memo} from 'react';
import type {Components} from 'react-markdown';
import Markdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// 组件表：链接在新窗口打开；图片不真加载，只留一个链接；表格外面套一层可以横着滚。
const components: Components = {
  a({href, children}) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  },
  // TODO：图片暂时不加载，只渲染成一个链接。
  // 图片和视频生成那部分还没开放，现在不能动。等那边放开，
  // 这里改回渲染 <img>，再定图片地址放在哪儿、怎么留住。
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
 *
 * 公式用 remark-math 认出 `$...$` 和 `$$...$$`，再由 rehype-katex 排出来。
 * 公式写错时 KaTeX 会把原文显示出来，出错颜色跟正文一样，不另外标红。
 */
export const MarkdownText = memo(function MarkdownText({text}: {text: string}) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, {errorColor: 'currentColor'}]]}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
