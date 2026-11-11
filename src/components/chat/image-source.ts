/**
 * 图片地址的校验：只放行内嵌的 SVG（`data:image/svg+xml;base64,…`），别的地址一概不用。
 *
 * 上游现在给的就是这种内嵌图，图片内容已经跟着消息正文存下来了，页面不需要去下载
 * 任何东西。放开这一种就够了；外链图片、`data:image/png` 之类都不在这个范围里。
 *
 * 检查顺序是「先解码、再解析、再清理、最后重新编码」：
 *
 * 1. Base64 解出来必须是合法的 UTF-8 文本；
 * 2. 文本得是能解析的 SVG 根元素；
 * 3. 交给 DOMPurify 按 SVG 的白名单清一遍：脚本、事件属性、外链元素都会被去掉；
 * 4. 再自己走一遍，把 DOMPurify 默认放过的对外引用去掉（见 stripExternalReferences）；
 * 5. 按清完的结果重新编码成 data 地址——显示的是清理过的内容，不是原文。
 *
 * 第 5 步是关键：只清理不重新编码，等于把没清理过的内容交给浏览器。
 */

import DOMPurify from 'dompurify';

import type {MessageImage} from './image-marks.ts';

/** 解码后的 SVG 上限。现在的样本是 950 字节，留了很宽的余量。 */
const MAX_SVG_BYTES = 200 * 1024;

/** 图片最大显示宽高比（宽 / 高），超出就当异常值，按 4:3 显示。 */
const MAX_ASPECT = 8;

/** SVG 命名空间。 */
const SVG_NS = 'http://www.w3.org/2000/svg';

/** 允许的 data 地址写法：`data:image/svg+xml;base64,` 后跟 Base64。 */
const SVG_DATA_URL = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/;

/** 校验失败时的默认尺寸（4:3），只用来占位，不影响显示比例。 */
const FALLBACK_WIDTH = 4;
const FALLBACK_HEIGHT = 3;

/**
 * Base64 解码。用 atob 而不是 Buffer：这段代码在浏览器里跑。
 * 返回 null 表示不是合法 Base64 或者超出大小上限。
 */
function decodeBase64(value: string): Uint8Array | null {
  if (value.length > MAX_SVG_BYTES * 2) {
    return null;
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (bytes.byteLength > MAX_SVG_BYTES) {
    return null;
  }
  return bytes;
}

/** 按 UTF-8 解码，非法字节序列返回 null（TextDecoder 默认不抛错，要开 fatal）。 */
function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  } catch {
    return null;
  }
}

/** 把一个数字字符串读成正数；读不出来返回 null。 */
function positive(value: string | null): number | null {
  if (value === null || value.trim() === '') {
    return null;
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * 从清理过的 SVG 上读出显示比例。优先用 viewBox（画布定义），没有再看 width/height；
 * 都读不出来就按 4:3 占位。比例离谱的（细长条）也不采信，免得图被压成一条线。
 */
function readRatio(svg: Element): {width: number; height: number} {
  const viewBox = svg.getAttribute('viewBox');
  if (viewBox !== null) {
    const parts = viewBox.trim().split(/[\s,]+/);
    if (parts.length === 4) {
      const width = positive(parts[2] ?? null);
      const height = positive(parts[3] ?? null);
      if (width !== null && height !== null && width / height <= MAX_ASPECT) {
        return {width, height};
      }
    }
  }
  const width = positive(svg.getAttribute('width'));
  const height = positive(svg.getAttribute('height'));
  if (width !== null && height !== null && width / height <= MAX_ASPECT) {
    return {width, height};
  }
  return {width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT};
}

/**
 * 去掉还在指外面的东西。
 *
 * DOMPurify 的 SVG 白名单会放过两类对外引用：`<image href="http://…">` 这种外链图，
 * 和样式表里的 `@import url(…)`。图片是用 `<img>` 加 data 地址渲染的，浏览器在这种
 * 静态模式里本来就不去取外部资源（也不执行脚本），但这层删除很便宜，留着比依赖浏览器
 * 的实现细节稳。指向本图内部（`#…`）的引用照留，那是渐变、裁剪路径这些正常用法。
 */
function stripExternalReferences(root: Element): void {
  const external = (value: string): boolean => {
    const trimmed = value.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      return false;
    }
    // 相对地址、绝对地址、data 地址一概不留：图里不该出现外部资源。
    return true;
  };
  const walk = (element: Element): void => {
    for (const attribute of [...element.attributes]) {
      const value = attribute.value;
      const name = attribute.localName;
      if (name === 'href' || name === 'src') {
        if (external(value)) {
          element.removeAttributeNode(attribute);
        }
        continue;
      }
      // style="…url(http://…)" 这种内联样式
      if (name === 'style' && /url\(\s*['"]?(?!#)/i.test(value)) {
        element.removeAttributeNode(attribute);
      }
    }
    if (element.localName === 'style' || element.localName === 'image') {
      const text = element.textContent ?? '';
      if (element.localName === 'image') {
        element.remove();
        return;
      }
      if (/@import|url\(\s*['"]?(?!#)/i.test(text)) {
        element.remove();
        return;
      }
    }
    for (const child of [...element.children]) {
      walk(child);
    }
  };
  walk(root);
}

/** 把清理过的 SVG 元素重新编码成 data 地址。 */
function encodeSvg(svg: Element): string | null {
  const text = new XMLSerializer().serializeToString(svg);
  if (text === '') {
    return null;
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > MAX_SVG_BYTES) {
    return null;
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/**
 * 把一段 SVG 文本清理成可信的 `<svg>` 元素。解析失败、根元素不是 svg、
 * 清完什么都不剩，都返回 null。
 *
 * 用 DOMParser 按 XML 解析（image/svg+xml）：不符合 XML 的内容直接拿不到根元素，
 * 顺带把「靠容错解析拼出奇怪结构」这条路堵掉。
 */
function parseAndSanitize(text: string): Element | null {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    return null;
  }
  const root = doc.documentElement;
  if (root.namespaceURI !== SVG_NS || root.localName !== 'svg') {
    return null;
  }
  const cleaned = DOMPurify.sanitize(text, {
    USE_PROFILES: {svg: true, svgFilters: true},
    RETURN_DOM_FRAGMENT: true,
  });
  const element = cleaned.firstElementChild;
  if (element === null || element.namespaceURI !== SVG_NS || element.localName !== 'svg') {
    return null;
  }
  stripExternalReferences(element);
  return element;
}

/**
 * 校验一条图片地址，给出能直接放进 `<img src>` 的地址和显示比例。
 * 没通过校验时 src 是空串，调用方据此显示说明文字和提示。
 */
export function readImageSource(url: string): Omit<MessageImage, 'caption'> {
  const failed = {src: '', width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT};
  const match = SVG_DATA_URL.exec(url);
  const encoded = match?.[1];
  if (encoded === undefined) {
    return failed;
  }
  const bytes = decodeBase64(encoded);
  if (bytes === null) {
    return failed;
  }
  const text = decodeUtf8(bytes);
  if (text === null) {
    return failed;
  }
  const svg = parseAndSanitize(text);
  if (svg === null) {
    return failed;
  }
  const src = encodeSvg(svg);
  if (src === null) {
    return failed;
  }
  return {src, ...readRatio(svg)};
}
