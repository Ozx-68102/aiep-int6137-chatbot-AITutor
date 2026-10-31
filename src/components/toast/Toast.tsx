import {useEffect, useRef} from 'react';

/**
 * 成功之后短暂出现的浮层：改完名字、删掉会话这类操作，弹窗自己就关了，
 * 得有个地方告诉用户「成了」。失败不走这里 —— 失败留在输入框上方的框里。
 */
export function Toast({
  message,
  lang,
  onDismiss,
}: {
  message: string;
  lang: string;
  onDismiss: () => void;
}) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      dismissRef.current();
    }, 3000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="pointer-events-none fixed top-6 left-1/2 z-[100] -translate-x-1/2 px-4">
      <p
        className="m-0 rounded-lg border border-emerald-800 bg-white px-4 py-3 text-center text-emerald-900 shadow-lg"
        role="status"
        lang={lang}
      >
        {message}
      </p>
    </div>
  );
}
