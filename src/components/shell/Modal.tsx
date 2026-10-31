import {type ReactNode, useEffect, useState} from 'react';
import {createPortal} from 'react-dom';

const exitMs = 150;

type Phase = 'closed' | 'open' | 'closing';

/**
 * 弹窗的外壳：背景淡入淡出，窗子从 95% 放大着淡入淡出。
 *
 * 关闭时先播完退出动画再卸载 —— 直接卸载就是瞬间消失，看着很生硬。
 * 各弹窗自己管内容，Esc 和点背景关闭在这里统一处理。
 */
export function Modal({
  open,
  titleId,
  panelClass,
  onClose,
  children,
}: {
  open: boolean;
  titleId: string;
  panelClass: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>(open ? 'open' : 'closed');
  const [wasOpen, setWasOpen] = useState(open);

  // open 变了就在渲染里把状态调过来：打开立刻挂上，关闭先播退出动画。
  if (open !== wasOpen) {
    setWasOpen(open);
    setPhase(open ? 'open' : 'closing');
  }

  useEffect(() => {
    if (phase !== 'closing') {
      return;
    }
    const timer = window.setTimeout(() => {
      setPhase('closed');
    }, exitMs);
    return () => window.clearTimeout(timer);
  }, [phase]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      onClose();
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (phase === 'closed') {
    return null;
  }

  return createPortal(
    <div
      className={
        phase === 'closing'
          ? 'fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4 animate-out fade-out duration-150'
          : 'fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 p-4 animate-in fade-in duration-150'
      }
      onClick={onClose}
    >
      <div
        className={
          phase === 'closing'
            ? `relative flex flex-col rounded-xl border border-stone-300 bg-white shadow-2xl animate-out fade-out zoom-out-95 duration-150 ${panelClass}`
            : `relative flex flex-col rounded-xl border border-stone-300 bg-white shadow-2xl animate-in fade-in zoom-in-95 duration-150 ${panelClass}`
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
