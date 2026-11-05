import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import {defineConfig} from 'vite';

// 第三方库分块。把不常变的三方包按家族拆成独立 chunk 的收益：
// 改动 src/ 里的业务代码时，只有应用代码那个 chunk 的哈希变化，
// 用户重新下载的只有它；vendor 分块内容没变，浏览器缓存继续命中。
//
// Vite 8 底层是 rolldown，旧写法 build.rollupOptions.output.manualChunks
// 已废弃（oxlint 的 no-deprecated 会拦），这里用 codeSplitting.groups。

// 从模块 id 里取出包名。pnpm 的真实路径形如
// .../node_modules/.pnpm/<pkg>@<ver>.../node_modules/<pkg>/...，
// 取最后一段 node_modules 之后的部分；@scope/name 算一个包名。
function packageNameOf(id: string): string | null {
  const clean = id.split('?')[0];
  if (clean.startsWith('\0') || clean.endsWith('.css')) return null;
  const marker = '/node_modules/';
  const at = clean.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = clean.slice(at + marker.length).split('/');
  if (parts[0].startsWith('@')) return parts.slice(0, 2).join('/');
  return parts[0];
}

// react 家族：核心运行时加路由，升级依赖之外基本不动。
const REACT_PACKAGES = new Set([
  'react',
  'react-dom',
  'scheduler',
  'react-router',
  '@remix-run/route-pattern',
  'cookie-es',
]);

// markdown/公式家族：react-markdown 和 remark/rehype/micromark/mdast/
// unist/unified/vfile/katex 整棵树，前缀匹配。
const MARKDOWN_PREFIXES = [
  'react-markdown',
  'remark',
  'rehype',
  'micromark',
  'mdast',
  'hast-util',
  'unist-util',
  'unified',
  'vfile',
  'katex',
  'devlop',
  'bail',
  'trough',
  'zwitch',
  'ccount',
  'longest-streak',
  'markdown-table',
  'trim-lines',
  'is-plain-obj',
  'html-url-attributes',
  'style-to-object',
  'inline-style-parser',
  'web-namespaces',
  'parse5',
  'entities',
  '@ungap/structured-clone',
  'estree-util-is-identifier-name',
  'escape-string-regexp',
  'extend',
  'dequal',
  'debug',
  'ms',
  'supports-color',
  'commander',
  'stringify-entities',
  'character-entities-html4',
];

// 这些包同时被 markdown 树和 react-syntax-highlighter 树依赖（按
// pnpm-lock.yaml 的快照树核对过）。划进 vendor-markdown 会让高亮的
// 按需动态 chunk 跨块引用它们，所以留给打包器默认处理，保持
// 动态 chunk 自包含。
const SHARED_WITH_HIGHLIGHTER = new Set([
  'character-entities',
  'character-entities-legacy',
  'character-reference-invalid',
  'decode-named-character-reference',
  'parse-entities',
  'is-alphabetical',
  'is-alphanumerical',
  'is-decimal',
  'is-hexadecimal',
  'comma-separated-tokens',
  'space-separated-tokens',
  'property-information',
  'hast-util-parse-selector',
  'hastscript',
]);

// 判断一个模块属于哪个 vendor 家族；不属于任何家族返回 undefined。
function vendorFamilyOf(id: string): string | undefined {
  const name = packageNameOf(id);
  // 自有源码（src/ 下）不参与分块，跟着入口走。
  if (name === null) return undefined;
  // react-syntax-highlighter 走 MarkdownText 里的动态 import，是按需
  // 加载的独立 chunk，不划进任何 vendor 分块，避免破坏按需加载。
  if (name.startsWith('react-syntax-highlighter')) return undefined;
  if (SHARED_WITH_HIGHLIGHTER.has(name)) return undefined;
  if (REACT_PACKAGES.has(name)) return 'vendor-react';
  if (MARKDOWN_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    return 'vendor-markdown';
  }
  return undefined;
}

export default defineConfig({
  plugins: [tailwindcss(), react()],
  build: {
    // 生成 .map 文件，但产物 JS 里不写 sourceMappingURL 注释：排查线上
    // 问题时可以拿 map 手动分析，而 dist 万一原样部署出去，浏览器也
    // 不会发现源码定位入口。
    sourcemap: 'hidden',
    rolldownOptions: {
      output: {
        codeSplitting: {
          // 只收测试命中的包本身，不连带它们的依赖一起划进来
          //（依赖归属由上面的名单精确控制）。
          includeDependenciesRecursively: false,
          groups: [
            {
              name: 'vendor-react',
              test: (id) => vendorFamilyOf(id) === 'vendor-react',
            },
            {
              name: 'vendor-markdown',
              test: (id) => vendorFamilyOf(id) === 'vendor-markdown',
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3001',
    },
  },
});
