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
 * 出现和消失都有动画：消失时先播完淡出再卸载。
 *
 * 状态归一（O7）：唯一来源是父级传进来的 toast（{id, text} 或 null），
 * 组件内不再维护第二套计数、也不做渲染期比较。id 变化就是一条新提示：
 * key={toast.id} 让整个节点重建、动画重播，3 秒计时也随之从零开始——
 * 连续两条同文案、不同 id 的提示各播各的。lang 由父级按当前 locale
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
  const [closing, setClosing] = useState(false);
  const dismissRef = useRef(onDismiss);
  const id = toast === null ? null : toast.id;

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  // 新提示（id 变化）出现：收起可能进行到一半的淡出，重新计满 3 秒。
  useEffect(() => {
    if (id === null) {
      return;
    }
    setClosing(false);
    const timer = window.setTimeout(() => {
      setClosing(true);
    }, showMs);
    return () => window.clearTimeout(timer);
  }, [id]);

  // 淡出：动画播完再让父级清掉 toast（toast 变 null，节点随之卸载）。
  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = window.setTimeout(() => {
      setClosing(false);
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
