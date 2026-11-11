/**
 * 助手回答里内嵌图片（`![说明](data:image/svg+xml;base64,…)`）的占位标记，以及把标记
 * 变回图片的那一步语法树改写。
 *
 * 为什么要有标记：图片地址本身是几千个字符的 Base64，打字机按字符切片播放时会把地址
 * 露出大半，用户看到的是乱码。所以收到完整回答后先把图片整段换成标记（地址不在里面），
 * 打字机只播放正文和图片下方的说明文字；播完之后标记再变回真正的图片。
 *
 * 标记用 Unicode 私用区的字符，正常文字里不会出现。编号也是一个私用区字符：标记被
 * 截在半路时编号凑不出来，解析时把它当成半截标记丢掉，不会误认成别的图片。
 */

/** 标记的开头：图片本身、说明文字。 */
const IMAGE_OPEN = '\uE000';
const CAPTION_OPEN = '\uE002';
/** 标记的结尾。 */
const MARK_END = '\uE001';
/** 说明文字的结尾。 */
export const CAPTION_CLOSE = '\uE003';
/** 编号字符的起点（私用区，够放几百张图）。 */
const ID_BASE = 0xe100;

/** 图片占位标记。 */
export function imageMark(id: number): string {
  return `${IMAGE_OPEN}${String.fromCharCode(ID_BASE + id)}${MARK_END}`;
}

/** 说明文字的开头标记（结尾是 CAPTION_CLOSE，不带编号：说明不嵌套）。 */
export function captionMark(id: number): string {
  return `${CAPTION_OPEN}${String.fromCharCode(ID_BASE + id)}${MARK_END}`;
}

/** 去掉全部标记字符：读屏、复制、错误降级用这个，别让私用区字符漏出去。 */
export function stripMarkCharacters(text: string): string {
  return text.replace(/[\ue000-\ue003\ue100-\ue1ff]/g, '');
}

/**
 * 一张图片的渲染信息。src 是校验并清理过的地址；没通过校验是空串，
 * 此时只显示说明文字和一行提示。
 */
export type MessageImage = {
  /** 图片说明（Markdown 方括号里的文字），可能为空。 */
  caption: string;
  src: string;
  /** 按 100% 宽度显示时的宽高比参照，来自 viewBox 或宽高属性。 */
  width: number;
  height: number;
};

/** 渲染时要用的界面文案。 */
export type ImageLabels = {
  /** 没有说明文字时用的替代文字。 */
  image: string;
  /** 校验没通过时的提示。 */
  unavailable: string;
};

/** 改写标记时的参数。 */
export type ImageRenderOptions = {
  images: readonly MessageImage[];
  /** 文字播放完了没有：没播完只显示灰色说明，图片本身先不出现。 */
  showImages: boolean;
  labels: ImageLabels;
};

type HastNode = {type: string; [key: string]: unknown};
type HastElement = HastNode & {
  type: 'element';
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
};
type HastText = HastNode & {type: 'text'; value: string};

/** 解析出来的一段：普通文字、图片、说明开头、说明结尾。 */
type Segment =
  | {kind: 'text'; value: string}
  | {kind: 'image'; id: number}
  | {kind: 'caption-start'}
  | {kind: 'caption-end'};

function isElement(node: HastNode): node is HastElement {
  return node.type === 'element' && Array.isArray((node as HastElement).children);
}

function isText(node: HastNode): node is HastText {
  return node.type === 'text' && typeof node.value === 'string';
}

function textNode(value: string): HastText {
  return {type: 'text', value};
}

function element(
  tagName: string,
  properties: Record<string, unknown>,
  children: HastNode[],
): HastElement {
  return {type: 'element', tagName, properties, children};
}

/** 编号字符换算回下标；不是编号字符返回 null。 */
function idOf(char: string | undefined): number | null {
  if (char === undefined) {
    return null;
  }
  const code = char.charCodeAt(0) - ID_BASE;
  return code >= 0 && code < 0x100 ? code : null;
}

/**
 * 把一段文字按标记切开。
 *
 * 标记没写完（打字机正好截在中间）时不认它：它前面的文字照常留下，它自己和它后面的
 * 内容不要——宁可少显示半句，也不能把标记字符当正文露出来。
 */
function splitMarks(value: string): Segment[] {
  const segments: Segment[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer !== '') {
      segments.push({kind: 'text', value: buffer});
      buffer = '';
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === IMAGE_OPEN || char === CAPTION_OPEN) {
      const id = idOf(value[index + 1]);
      if (id === null || value[index + 2] !== MARK_END) {
        break;
      }
      flush();
      segments.push(char === IMAGE_OPEN ? {kind: 'image', id} : {kind: 'caption-start'});
      index += 2;
      continue;
    }
    if (char === CAPTION_CLOSE) {
      flush();
      segments.push({kind: 'caption-end'});
      continue;
    }
    buffer += char;
  }
  flush();
  return segments;
}

/** 图片元素：校验通过的画图，没通过的给一行提示；文字还没播完就什么都不显示。 */
function imageElement(
  image: MessageImage | undefined,
  options: ImageRenderOptions,
): HastElement | null {
  if (!options.showImages || image === undefined) {
    return null;
  }
  if (image.src === '') {
    return element('span', {className: ['chat-image-failed']}, [
      textNode(options.labels.unavailable),
    ]);
  }
  return element(
    'img',
    {
      className: ['chat-image'],
      src: image.src,
      alt: image.caption === '' ? options.labels.image : image.caption,
      width: image.width,
      height: image.height,
      decoding: 'async',
    },
    [],
  );
}

function captionElement(children: HastNode[]): HastElement {
  return element('span', {className: ['chat-image-caption']}, children);
}

/** 这一段是不是我们生成的图片（img，或校验失败时的提示）。 */
function isImageElement(node: HastNode): boolean {
  if (!isElement(node) || (node.tagName !== 'img' && node.tagName !== 'span')) {
    return false;
  }
  const className = node.properties.className;
  return Array.isArray(className) && className.some((name) => String(name) === 'chat-image');
}

function isCaptionElement(node: HastNode): boolean {
  if (!isElement(node) || node.tagName !== 'span') {
    return false;
  }
  const className = node.properties.className;
  return Array.isArray(className) && className.includes('chat-image-caption');
}

function isBlankNode(node: HastNode): boolean {
  return isText(node) && node.value.trim() === '';
}

/**
 * 段落里只有一张图和它的说明时，把段落换成 figure：`<figure>` 不能塞进 `<p>` 里。
 * 顺序在这里定死——图片在上、说明在下；图片夹在正文中间时不提升，保持行内。
 */
function promoteFigure(node: HastElement): HastElement {
  const meaningful = node.children.filter((child) => !isBlankNode(child));
  const image = meaningful.find((child) => isImageElement(child));
  const caption = meaningful.find((child) => isCaptionElement(child));
  if (
    image === undefined ||
    meaningful.length > 2 ||
    meaningful.some((child) => child !== image && child !== caption)
  ) {
    return node;
  }
  const children: HastNode[] = [image];
  if (caption !== undefined && isElement(caption)) {
    children.push(element('figcaption', {className: ['chat-image-caption']}, caption.children));
  }
  return element('figure', {className: ['chat-image-figure']}, children);
}

/** 把说明开头到结尾之间的内容收成一整段灰色文字。 */
function collectCaptions(nodes: HastNode[]): HastNode[] {
  const rebuilt: HastNode[] = [];
  let index = 0;
  while (index < nodes.length) {
    const child = nodes[index];
    if (child === undefined) {
      break;
    }
    if (child.type === 'caption-start') {
      const collected: HastNode[] = [];
      index += 1;
      while (index < nodes.length) {
        const inner = nodes[index];
        if (inner === undefined || inner.type === 'caption-end') {
          break;
        }
        collected.push(inner);
        index += 1;
      }
      if (index < nodes.length) {
        index += 1;
      }
      // 说明文字一个字都还没打出来时不留空壳，免得占位。
      if (collected.length > 0) {
        rebuilt.push(captionElement(collected));
      }
      continue;
    }
    if (child.type === 'caption-end') {
      index += 1;
      continue;
    }
    rebuilt.push(child);
    index += 1;
  }
  return rebuilt;
}

/** 递归改写：切标记、换图片、收说明。传进来的必须是节点本身（重组结果写回它的 children）。 */
function transformChildren(parent: {children: HastNode[]}, options: ImageRenderOptions): void {
  const flat: HastNode[] = [];
  for (const child of parent.children) {
    if (isText(child)) {
      for (const segment of splitMarks(child.value)) {
        if (segment.kind === 'text') {
          flat.push(textNode(segment.value));
        } else if (segment.kind === 'image') {
          const rendered = imageElement(options.images[segment.id], options);
          if (rendered !== null) {
            flat.push(rendered);
          }
        } else if (segment.kind === 'caption-start') {
          flat.push({type: 'caption-start'});
        } else {
          flat.push({type: 'caption-end'});
        }
      }
      continue;
    }
    if (isElement(child)) {
      transformChildren(child, options);
    }
    flat.push(child);
  }

  parent.children = collectCaptions(flat)
    .map((child) => (isElement(child) && child.tagName === 'p' ? promoteFigure(child) : child))
    // 只装着图片标记的段落，在图片出现之前会是空的：留着会白占一段行距，
    // 播放时跟着上下的文字一跳一跳。空的段落不留（<br> 之类别的空元素照留）。
    .filter((child) => !(isElement(child) && child.tagName === 'p' && child.children.length === 0));
}

/**
 * rehype 插件：把占位标记变成图片和灰色说明。图片位置、说明的灰色样式都在这里定，
 * MarkdownText 只管把结果交给 React。
 */
export function rehypeMessageImages(options: ImageRenderOptions) {
  return (tree: unknown) => {
    const root = tree as {children?: HastNode[]};
    if (Array.isArray(root.children)) {
      // 传 root 本身，不要另包一层对象：改写结果要写回这棵树的 children。
      transformChildren(root as {children: HastNode[]}, options);
    }
  };
}
