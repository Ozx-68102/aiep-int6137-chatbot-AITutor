/**
 * 临时类型垫片：react-syntax-highlighter 不带类型声明，
 * @types/react-syntax-highlighter 也还没装（装依赖只能维护者做）。
 * 这里只声明本项目用到的面——prism-light 的默认导出组件
 * （language / style / customStyle / PreTag / codeTagProps / children）、
 * registerLanguage 方法、语言语法与主题样式对象的默认导出。
 *
 * 维护者装好 @types/react-syntax-highlighter 之后删除本垫片：
 * 官方类型更全，这份声明会把它遮住。
 */

declare module 'react-syntax-highlighter/dist/esm/prism-light' {
  import type {ComponentType} from 'react';

  export type SyntaxHighlighterProps = {
    language?: string;
    style?: Record<string, unknown>;
    customStyle?: Record<string, unknown>;
    codeTagProps?: Record<string, unknown>;
    PreTag?: string;
    children?: string | string[];
  };

  const SyntaxHighlighter: ComponentType<SyntaxHighlighterProps> & {
    registerLanguage(name: string, language: unknown): void;
  };

  export default SyntaxHighlighter;
}

declare module 'react-syntax-highlighter/dist/esm/languages/prism/*' {
  const language: unknown;
  export default language;
}

declare module 'react-syntax-highlighter/dist/esm/styles/prism/*' {
  const style: Record<string, unknown>;
  export default style;
}
