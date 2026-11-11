import {Check, Copy} from 'lucide-react';
import {isValidElement, memo, type ReactNode, useEffect, useMemo, useRef, useState} from 'react';
import type {Components} from 'react-markdown';
import Markdown, {defaultUrlTransform} from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type {PluggableList} from 'unified';
import {type MessageImage, rehypeMessageImages} from './image-marks.ts';

type HighlighterModule = typeof import('./highlighter.ts');

// 模块级单例 promise：高亮 chunk 最多加载一次，第一个命中已注册语言的
// 代码块渲染时才触发（独立 chunk，不进主包）。加载失败把单例放回 null，
// 下一个代码块再试；失败的代码块保持纯文本样子。
let highlighterPromise: Promise<HighlighterModule> | null = null;

function loadHighlighter(): Promise<HighlighterModule> {
  if (highlighterPromise === null) {
    highlighterPromise = import('./highlighter.ts').catch((error: unknown) => {
      highlighterPromise = null;
      throw error;
    });
  }
  return highlighterPromise;
}

// 已注册的语言，跟 highlighter.ts 的注册清单保持一致（那份在动态 chunk
// 里，决定「要不要加载它」的这份必须静态可达）。className="language-xxx"
// 没命中的一律原样 <pre> 纯文本渲染。
const HIGHLIGHT_LANGUAGES = new Set(['python', 'javascript', 'typescript', 'java']);

// 高亮输出的深色底跟现状一致：对齐 markdown.css 的 .markdown pre
// （stone-900 底、同样的圆角、内边距和字号），token 颜色由 one-dark 主题给。
const HIGHLIGHT_CUSTOM_STYLE: Record<string, unknown> = {
  backgroundColor: 'var(--color-stone-900)',
  margin: 0,
  borderRadius: '0.5rem',
  padding: '0.75rem',
  fontSize: '0.875rem',
  lineHeight: 1.5,
};

/** 代码块的语言：从子树里 <code> 的 className="language-xxx" 认。 */
function codeLanguage(children: ReactNode): string | null {
  const items = Array.isArray(children) ? children : [children];
  for (const item of items) {
    if (!isValidElement(item)) {
      continue;
    }
    const props = item.props as {className?: unknown};
    if (typeof props.className !== 'string') {
      continue;
    }
    const match = /language-([\w+-]+)/.exec(props.className);
    if (match !== null) {
      return match[1] ?? null;
    }
  }
  return null;
}

/** 从 React 子树递归抽字符串（improvement-research frontend-chat N4 的做法）：不序列化 DOM。 */
function nodeText(node: ReactNode): string {
  if (typeof node === 'string') {
    return node;
  }
  if (Array.isArray(node)) {
    return node.map(nodeText).join('');
  }
  if (isValidElement(node)) {
    return nodeText((node.props as {children?: ReactNode}).children);
  }
  return '';
}

/**
 * 代码块：外面包一层相对定位的容器，右上角一个复制按钮；命中已注册语言
 * 且高亮 chunk 已加载时用 react-syntax-highlighter 渲染，否则原样 <pre>
 * （markdown.css 的深色底样式是多一层保护）。流式期间未闭合的代码块也会早早
 * 出现复制按钮，无害（N4）。
 */
function CodeBlock({
  children,
  copyLabel,
  copiedLabel,
}: {
  children?: ReactNode;
  copyLabel: string;
  copiedLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const [highlighter, setHighlighter] = useState<HighlighterModule | null>(null);
  const copyTimer = useRef<number | null>(null);
  const language = codeLanguage(children);
  const highlightable = language !== null && HIGHLIGHT_LANGUAGES.has(language);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) {
        window.clearTimeout(copyTimer.current);
      }
    },
    [],
  );
  useEffect(() => {
    if (!highlightable) {
      return;
    }
    let cancelled = false;
    loadHighlighter().then(
      (loaded) => {
        if (!cancelled) {
          setHighlighter(loaded);
        }
      },
      () => {
        // chunk 加载不出来就保持纯文本：没有高亮总比整段回答崩溃好。
      },
    );
    return () => {
      cancelled = true;
    };
  }, [highlightable]);
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(nodeText(children));
    } catch {
      // clipboard 不可用/没权限时静默失败（本部署 https/localhost，正常可用）。
      return;
    }
    setCopied(true);
    if (copyTimer.current !== null) {
      window.clearTimeout(copyTimer.current);
    }
    // 1.5 秒后还原：icon 和文字都回到「复制」。
    copyTimer.current = window.setTimeout(() => {
      setCopied(false);
    }, 1500);
  }
  return (
    <div className="code-block-wrap relative">
      {highlighter !== null && language !== null ? (
        <highlighter.Highlighter
          language={language}
          style={highlighter.highlightStyle}
          customStyle={HIGHLIGHT_CUSTOM_STYLE}
        >
          {nodeText(children)}
        </highlighter.Highlighter>
      ) : (
        <pre>{children}</pre>
      )}
      <button
        type="button"
        className="btn btn-ghost btn-xs absolute right-1.5 top-1.5 text-stone-300 hover:text-white"
        aria-label={copied ? copiedLabel : copyLabel}
        onClick={() => {
          void copyCode();
        }}
      >
        {copied ? (
          <Check className="size-3.5" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}

/**
 * 图片地址的放行规则：普通链接继续用 Markdown 库默认那一套（http、https、mailto
 * 这些），只有图片多开一个口子，而且只认校验过的内嵌 SVG。
 *
 * 校验在 message-body.ts 里做（解码、解析、清理、重新编码），这里拿到的是清理后的
 * 地址；地址不在这条白名单里的直接清空，页面上不会去请求任何外部图片。
 */
function imageUrlTransform(value: string, key: string): string {
  if (key === 'src') {
    return value.startsWith('data:image/svg+xml;base64,') ? value : '';
  }
  return defaultUrlTransform(value);
}

/**
 * 助手回答里的 Markdown。
 *
 * markdown 库默认不解析原始 HTML（HTML 会当文字显示），链接和图片的地址也只放行
 * http、https、mailto 这些协议，所以不用额外做转义。
 *
 * 公式用 remark-math 认出 `$...$` 和 `$$...$$`，再由 rehype-katex 排出来。
 * 公式写错时 KaTeX 会把原文显示出来，出错颜色跟正文一样，不另外标红。
 *
 * 代码块（pre）换成 CodeBlock：右上角复制按钮 + 按需加载的语法高亮。
 *
 * 图片：上游把内嵌图写成 `![说明](data:image/svg+xml;base64,…)`。原文在
 * message-body.ts 里换成了占位标记，这里由 rehypeMessageImages 把标记变回图片，
 * 说明文字渲染成灰色小字挂在图片下方。打字机把地址排除在播放之外就是靠这一层。
 */
export const MarkdownText = memo(function MarkdownText({
  text,
  copyLabel,
  copiedLabel,
  images = [],
  showImages = true,
  imageLabel,
  imageUnavailableLabel,
  onImageLoad,
}: {
  text: string;
  /** 代码块复制按钮的文字（i18n copy / copied）。 */
  copyLabel: string;
  copiedLabel: string;
  /** 消息里的图片（message-body.ts 拆出来的，按标记编号排列）。 */
  images?: readonly MessageImage[];
  /** 图片显不显示：打字机还在放的时候只显示灰色说明，放完才是 true。 */
  showImages?: boolean;
  /** 没有说明文字时图片的替代文字（i18n image）。 */
  imageLabel?: string;
  /** 图片没通过校验时的提示（i18n imageUnavailable）。 */
  imageUnavailableLabel?: string;
  /** 图片加载完长高了：滚动容器贴底时靠它继续跟随（不贴底就保持阅读位置）。 */
  onImageLoad?: () => void;
}) {
  // 组件表：链接在新窗口打开；图片只认校验过的内嵌 SVG，其余地址清空；表格外面套
  // 一层可以横着滚；代码块进 CodeBlock。复制按钮的文案跟着语言环境走，
  // 所以表按 labels memo 一份，不放在模块级。
  const components = useMemo<Components>(
    () => ({
      a({href, children}) {
        return (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        );
      },
      img({src, alt, width, height}) {
        // 地址在这一层之前已经被 imageUrlTransform 清过；空地址说明图片没通过校验
        // 或者根本不是内嵌 SVG，此时不画空的 <img>，只把说明文字留下。
        if (src === undefined || src === '') {
          return alt === undefined || alt === '' ? null : (
            <span className="chat-image-failed">{alt}</span>
          );
        }
        // 宽高交给浏览器先占位（CSS 的 max-width: 100% 会把它压进气泡），
        // 图片加载完那一帧才不会把下面的内容顶一下。
        return (
          <img
            className="chat-image"
            src={src}
            alt={alt ?? ''}
            width={width}
            height={height}
            decoding="async"
            onLoad={onImageLoad}
          />
        );
      },
      table({children}) {
        return (
          <div className="markdown-table-wrap">
            <table>{children}</table>
          </div>
        );
      },
      pre({children}) {
        return (
          <CodeBlock copyLabel={copyLabel} copiedLabel={copiedLabel}>
            {children}
          </CodeBlock>
        );
      },
    }),
    [copyLabel, copiedLabel, onImageLoad],
  );
  // 只带图片标记的文本才走改写插件：没有图片时插件不挂，渲染路径跟以前完全一样。
  const rehypePlugins = useMemo<PluggableList>(
    () => [
      [rehypeKatex, {errorColor: 'currentColor'}],
      [
        rehypeMessageImages,
        {
          images,
          showImages,
          labels: {
            image: imageLabel ?? '',
            unavailable: imageUnavailableLabel ?? '',
          },
        },
      ],
    ],
    [images, showImages, imageLabel, imageUnavailableLabel],
  );
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={rehypePlugins}
        urlTransform={imageUrlTransform}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  );
});
