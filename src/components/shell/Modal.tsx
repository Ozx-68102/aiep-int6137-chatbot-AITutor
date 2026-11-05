import {type ReactNode, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

const exitMs = 150;

type Phase = 'closed' | 'open' | 'closing';

// 当前打开着的弹窗面板栈：多个弹窗同时开着时（例如会话过期就地重登录叠在
// 设置弹窗上），只有栈顶那个响应 Esc 和 Tab 焦点圈定，不互相抢键盘。
const openPanels: HTMLElement[] = [];

// 背景滚动锁计数：最后一个弹窗关闭才恢复 body 滚动。overflow: hidden 在
// 移动端 Safari 上不保留滚动位置（解锁后跳回顶部），是已知的小瑕疵，
// 先接受（docs/improvement-research/frontend-app.md P6 提到 position: fixed
// 的替代方案，代价更大，这里不做）。
let bodyScrollLocks = 0;
let bodyOverflowBeforeLock = '';

// 面板里可能拿到焦点的元素。inert 子树里的（比如收起状态的语言菜单浮层）
// 和 display: none 的（比如头像的 file input）不在 Tab 顺序里，也不进圈定循环。
const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function focusableIn(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => element.closest('[inert]') === null && element.getClientRects().length > 0,
  );
}

/**
 * 弹窗的外壳：背景淡入淡出，窗子从 95% 放大着淡入淡出。
 *
 * 关闭时先播完退出动画再卸载 —— 直接卸载就是瞬间消失，看着很生硬。
 * 各弹窗自己管内容，Esc、点背景关闭、Tab 焦点圈定、背景滚动锁、关闭后
 * 把焦点还给触发元素，都在这里统一处理。
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
  const panelRef = useRef<HTMLDivElement>(null);

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

  // 打开时：入栈、把焦点挪进面板、锁背景滚动；关闭时：出栈、解锁、还焦点。
  useEffect(() => {
    if (!open) {
      return;
    }
    const panel = panelRef.current;
    // 记录触发元素：此刻焦点还在面板外面才算数。面板里的 autofocus 元素
    // 先抢走焦点时（比如重登录弹窗的用户名输入框），没有可靠的触发元素
    // 可记，关闭时就跳过还焦点。触发元素随页面卸载时 isConnected 为
    // false，同样跳过，focus() 落在已卸载节点上本来就是无效操作。
    const active = document.activeElement;
    const trigger =
      active instanceof HTMLElement && panel !== null && !panel.contains(active) ? active : null;
    if (panel !== null) {
      openPanels.push(panel);
      // 焦点优先进 autofocus 元素，其次第一个可聚焦元素；面板里一个
      // 可聚焦元素都没有时退回面板本身（tabIndex=-1）。
      const target =
        panel.querySelector<HTMLElement>('[autofocus]') ?? focusableIn(panel).at(0) ?? panel;
      target.focus();
    }
    if (bodyScrollLocks === 0) {
      bodyOverflowBeforeLock = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    bodyScrollLocks += 1;
    return () => {
      if (panel !== null) {
        const index = openPanels.indexOf(panel);
        if (index >= 0) {
          openPanels.splice(index, 1);
        }
      }
      bodyScrollLocks -= 1;
      if (bodyScrollLocks === 0) {
        document.body.style.overflow = bodyOverflowBeforeLock;
      }
      if (trigger !== null && trigger.isConnected) {
        trigger.focus();
      }
    };
  }, [open]);

  // Esc 关闭和 Tab 圈定：只有栈顶的弹窗处理。
  useEffect(() => {
    if (!open) {
      return;
    }
    function onKey(event: KeyboardEvent) {
      const panel = panelRef.current;
      if (panel === null || openPanels.at(-1) !== panel) {
        return;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') {
        return;
      }
      const items = focusableIn(panel);
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (current === null || !panel.contains(current)) {
        // 焦点不知怎么落到了面板外面：直接拉回第一个元素。
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
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
        ref={panelRef}
        className={
          phase === 'closing'
            ? `modal-box relative flex flex-col scale-100 border border-base-300 opacity-100 animate-out fade-out zoom-out-95 duration-150 ${panelClass}`
            : `modal-box relative flex flex-col scale-100 border border-base-300 opacity-100 animate-in fade-in zoom-in-95 duration-150 ${panelClass}`
        }
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
