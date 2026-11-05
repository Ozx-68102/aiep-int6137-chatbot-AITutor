import type {Message} from '../../type/chat.ts';

/**
 * daisyUI chat 体系需要两层：外层包装（.chat .chat-start/.chat-end，grid 定位），
 * 内层气泡（.chat-bubble + 语义色）。进场动画（tw-animate-css）留在气泡上，
 * 跟 onAnimationEnd 同元素，事件行为不变。
 *
 * 气泡最大宽度（N10）：窄屏按容器的 85%（和容器 padding 叠加后不再几乎
 * 贴满），md 断点起维持 600px 上限。
 */
export type BubbleClass = {
  wrap: string;
  bubble: string;
};

export function bubbleClass(role: Message['role'], entering: boolean): BubbleClass {
  if (role === 'user') {
    return {
      wrap: 'chat chat-end',
      bubble: entering
        ? 'chat-bubble chat-bubble-primary max-w-[85%] md:max-w-[600px] animate-in whitespace-pre-wrap break-words fade-in slide-in-from-bottom-2 duration-200'
        : 'chat-bubble chat-bubble-primary max-w-[85%] md:max-w-[600px] whitespace-pre-wrap break-words',
    };
  }
  return {
    wrap: 'chat chat-start',
    bubble: entering
      ? 'chat-bubble max-w-[85%] md:max-w-[600px] animate-in whitespace-pre-wrap break-words fade-in slide-in-from-bottom-2 duration-200'
      : 'chat-bubble max-w-[85%] md:max-w-[600px] animate-in whitespace-pre-wrap break-words fade-in duration-300 motion-reduce:animate-none',
  };
}
