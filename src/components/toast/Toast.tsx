import {CircleCheck} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

const exitMs = 150;
const showMs = 3000;

/**
 * 成功之后短暂出现的浮层：改完名字、删掉会话这类操作，弹窗自己就关了，
 * 得有个地方告诉用户「成了」。失败不走这里 —— 失败留在输入框上方的框里。
 *
 * 出现和消失都有动画：消失时先播完淡出再卸载。
 *
 * 样式刻意不用 alert-success：维护者要求任何时候都是白底黑字，
 * 成功语义只由左侧的绿色对勾和文案本身表达。
 */
export function Toast({
  message,
  lang,
  onDismiss,
}: {
  message: string | null;
  lang: string;
  onDismiss: () => void;
}) {
  const [shown, setShown] = useState<{id: number; text: string} | null>(null);
  const [closing, setClosing] = useState(false);
  const [wasMessage, setWasMessage] = useState(message);
  const [counter, setCounter] = useState(0);
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  // 有新的提示就换一条新的（编号变了，动画重新播一遍）；没有提示了就准备淡出。
  if (message !== wasMessage) {
    setWasMessage(message);
    if (message !== null && message !== '') {
      const id = counter + 1;
      setCounter(id);
      setShown({id, text: message});
      setClosing(false);
    } else {
      setClosing(true);
    }
  }

  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = window.setTimeout(() => {
      setShown(null);
      setClosing(false);
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [closing]);

  useEffect(() => {
    if (shown === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      dismissRef.current();
    }, showMs);
    return () => window.clearTimeout(timer);
  }, [shown]);

  if (shown === null) {
    return null;
  }

  return createPortal(
    <div className="pointer-events-none fixed top-6 left-1/2 z-[100] -translate-x-1/2 px-4">
      <div
        key={shown.id}
        className={
          closing
            ? 'alert m-0 bg-base-100 text-center shadow-lg animate-out fade-out zoom-out-95 duration-150'
            : 'alert m-0 bg-base-100 text-center shadow-lg animate-in fade-in zoom-in-95 duration-150'
        }
        role="status"
        lang={lang}
      >
        <CircleCheck className="size-5 shrink-0 text-success" aria-hidden="true" />
        <span>{shown.text}</span>
      </div>
    </div>,
    document.body,
  );
}
