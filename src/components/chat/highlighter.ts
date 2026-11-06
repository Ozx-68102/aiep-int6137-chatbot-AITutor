/**
 * 按需加载的语法高亮（react-syntax-highlighter 的 prism-light 路线）。
 *
 * 这个文件只被 MarkdownText.tsx 在第一个「语言命中注册表」的代码块渲染时
 * 动态 import()，Vite 会把它连同高亮库、语言语法和主题打包成一个独立
 * chunk：主包体积不涨（docs/improvement-research/frontend-chat.md N4
 * 的注记、docs/TECH.md「代码高亮」条）。
 *
 * 注册的语言集很小：python、javascript、typescript、java。同一份清单在
 * MarkdownText.tsx 的 HIGHLIGHT_LANGUAGES 里静态复制了一份（那边要在
 * 不加载本 chunk 的前提下判断该不该加载），改语言时两边一起改。
 *
 * 类型：官方 @types/react-syntax-highlighter 已在 devDependencies
 * （2026-11-05 补装），tsconfig 以 "types" 显式把它的环境声明拉进程序；
 * 早先过渡用的 src/types/ 垫片已删除。
 */
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import SyntaxHighlighter from 'react-syntax-highlighter/dist/esm/prism-light';
import oneDark from 'react-syntax-highlighter/dist/esm/styles/prism/one-dark';

SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('java', java);

export const Highlighter = SyntaxHighlighter;
export const highlightStyle = oneDark;
