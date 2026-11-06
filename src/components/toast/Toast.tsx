import {CircleCheck} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

const exitMs = 150;
const showMs = 3000;

export type ToastItem = {id: number; text: string};

/**
 * 成功之后短暂出现的浮层：改完名字、删掉会话这类操作，弹窗自己就关了，
 * 得有个地方告诉用户「成了」。失败不走这里 —— 失败留在输入框上方的框里。
 *
 * 出现和消失都有动画：消失时先播放完淡出再卸载。
 *
 * 状态归一（O7）：唯一来源是父级传进来的 toast（{id, text} 或 null），
 * 组件内不再维护第二套计数、也不做渲染期比较。id 变化就是一条新提示：
 * key={toast.id} 让整个节点重建、动画重播，3 秒计时也随之从零开始——
 * 连续两条同文案、不同 id 的提示各自播放。lang 由父级按当前 locale
 * 现算传入：显示中途切语言，提示跟着换语言。
 *
 * 样式刻意不用 alert-success：维护者要求任何时候都是白底黑字，
 * 成功语义只由左侧的绿色对勾和文案本身表达。
 */
export function Toast({
  toast,
  lang,
  onDismiss,
}: {
  toast: ToastItem | null;
  lang: string;
  onDismiss: () => void;
}) {
  // 正在淡出的那条 toast 的 id。closing 由「closingId === 当前 id」现算：
  // 新提示（不同 id）进来时天然就是非淡出态，不用在效果里同步复位布尔，
  // 避开 set-state-in-effect 的级联渲染。
  const [closingId, setClosingId] = useState<number | null>(null);
  const dismissRef = useRef(onDismiss);
  const id = toast === null ? null : toast.id;
  const closing = id !== null && closingId === id;

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  // 新提示（id 变化）出现：重新计满 3 秒，到点把它标成淡出中。
  useEffect(() => {
    if (id === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      setClosingId(id);
    }, showMs);
    return () => window.clearTimeout(timer);
  }, [id]);

  // 淡出：动画播放完再让父级清掉 toast（toast 变 null，节点随之卸载）。
  // 两个 setState 在同一个回调里，React 18 自动批处理成一次重渲染，
  // 不会闪现一帧淡入样式。
  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = window.setTimeout(() => {
      setClosingId(null);
      dismissRef.current();
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [closing]);

  if (toast === null) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed top-6 left-1/2 z-[100] -translate-x-1/2 px-4">
      <div
        key={toast.id}
        className={
          closing
            ? 'alert m-0 bg-base-100 text-center shadow-lg animate-out fade-out zoom-out-95 duration-150'
            : 'alert m-0 bg-base-100 text-center shadow-lg animate-in fade-in zoom-in-95 duration-150'
        }
        role="status"
        lang={lang}
      >
        <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
        <span>{toast.text}</span>
      </div>
    </div>,
    document.body,
  );
}
