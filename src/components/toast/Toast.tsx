import {useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

const exitMs = 150;
const showMs = 3000;

/**
 * 成功之后短暂出现的浮层：改完名字、删掉会话这类操作，弹窗自己就关了，
 * 得有个地方告诉用户「成了」。失败不走这里 —— 失败留在输入框上方的框里。
 *
 * 出现和消失都有动画：消失时先播完淡出再卸载。
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
      <p
        key={shown.id}
        className={
          closing
            ? 'm-0 animate-out rounded-lg border border-emerald-800 bg-white px-4 py-3 text-center text-emerald-900 shadow-lg fade-out zoom-out-95 duration-150'
            : 'm-0 animate-in rounded-lg border border-emerald-800 bg-white px-4 py-3 text-center text-emerald-900 shadow-lg fade-in zoom-in-95 duration-150'
        }
        role="status"
        lang={lang}
      >
        {shown.text}
      </p>
    </div>,
    document.body,
  );
}
