/**
 * 收到一条完整的助手回答之后，先把它拆成两样东西：
 *
 * - **播放文本**：交给打字机逐字播放的内容。图片地址整段换成了占位标记，说明文字
 *   留在原位（所以说明会跟着正文一起打出来）。
 * - **图片列表**：校验好的图片，播放结束后由标记变回图片。
 *
 * 上游是整块返回的（见 docs/CHAT_STREAM_PROTOCOL.md「上游整块返回答案」），所以这里
 * 只按「一整条完整消息」处理，不为「地址收到一半」留分支。
 *
 * 识别图片走 Markdown 解析器而不是正则：代码块里的 `![…](…)` 是示例文字，正则会把
 * 它当成图片；解析器分得清。地址和说明都从语法树节点上取，位置用字节偏移量回填到
 * 原文，因此除图片以外的内容一个字都不会被改写。
 */

import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import {unified} from 'unified';

import type {MessageImage} from './image-marks.ts';
import {CAPTION_CLOSE, captionMark, imageMark, stripMarkCharacters} from './image-marks.ts';
import {readImageSource} from './image-source.ts';

/** 语法树里我们关心的字段（mdast 的形状，只声明用得到的部分）。 */
type MdNode = {
  type: string;
  position?: {start?: {offset?: number}; end?: {offset?: number}};
  children?: MdNode[];
  alt?: string | null;
  url?: string;
};

/** 一条消息拆出来的结果。 */
export type MessageBody = {
  /** 打字机播放的文本（图片换成了标记）。 */
  playText: string;
  /** 按标记里的编号排列的图片。 */
  images: MessageImage[];
  /** 有没有图片（没有的话播放文本与原文一字不差，打字机走原来的路）。 */
  hasImages: boolean;
};

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

/** 把一棵树里所有 image 节点按出现顺序收集起来。 */
function collectImages(node: MdNode, found: MdNode[]): void {
  if (node.type === 'image') {
    found.push(node);
  }
  if (node.children !== undefined) {
    for (const child of node.children) {
      collectImages(child, found);
    }
  }
}

/**
 * 拆一条消息。
 *
 * 图片说明作为灰字参与播放：标记的顺序是「图片标记、说明开始、说明文字、说明结束」，
 * 打出来的效果就是正文先出现、说明跟着慢慢出现，而图片本身要等播完。
 *
 * 说明为空时不留空标记对——省得播完留一截空的灰块。
 */
export function splitMessageBody(text: string): MessageBody {
  const tree = processor.parse(text) as unknown as MdNode;
  const found: MdNode[] = [];
  collectImages(tree, found);
  if (found.length === 0) {
    return {playText: text, images: [], hasImages: false};
  }

  const images: MessageImage[] = [];
  let playText = '';
  let cursor = 0;
  for (const node of found) {
    const start = node.position?.start?.offset;
    const end = node.position?.end?.offset;
    if (start === undefined || end === undefined) {
      continue;
    }
    const index = images.length;
    const caption = (node.alt ?? '').trim();
    const source = readImageSource(node.url ?? '');
    images.push({caption, ...source});
    playText += text.slice(cursor, start);
    playText += imageMark(index);
    if (caption !== '') {
      playText += `${captionMark(index)}${caption}${CAPTION_CLOSE}`;
    }
    // 图片后面的换行原样留着（段落之间靠它分隔），下一轮从图片结尾接着取。
    cursor = end;
  }
  playText += text.slice(cursor);
  return {playText, images, hasImages: true};
}

/** 错误降级用的缓存：同一条消息只解析一次（每条气泡每次渲染都会问一次）。 */
const degradedCache = new Map<string, string>();
const DEGRADED_CACHE_LIMIT = 50;

/**
 * 渲染出错、气泡降级成纯文本时用的文字：把图片换成占位标记、再去掉标记，
 * 也就是「正文加说明，但没有图片地址」。降级是坏情况的保底，不能让它把几千字符的
 * Base64 糊到屏幕上。
 *
 * 结果按原文缓存：气泡重渲染时不会重复解析。
 */
export function degradedText(text: string): string {
  const cached = degradedCache.get(text);
  if (cached !== undefined) {
    return cached;
  }
  const result = stripMarkCharacters(splitMessageBody(text).playText);
  if (degradedCache.size >= DEGRADED_CACHE_LIMIT) {
    const oldest = degradedCache.keys().next();
    if (!oldest.done) {
      degradedCache.delete(oldest.value);
    }
  }
  degradedCache.set(text, result);
  return result;
}
