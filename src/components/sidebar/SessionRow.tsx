import {Ellipsis, Pin} from 'lucide-react';
import {type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {translations} from '../../i18n/index.ts';
import {sessionTitle} from '../../session/empty.ts';
import type {Session} from '../../type/chat.ts';
import {type Locale} from '../../type/locale.ts';
import {ConfirmDelete} from './ConfirmDelete.tsx';
import {RenameSession} from './RenameSession.tsx';

/** 二级菜单挂在 body 上，位置按视口算。 */
function menuPointFor(button: HTMLButtonElement): {top: number; right: number} {
  const rect = button.getBoundingClientRect();
  return {
    top: rect.bottom + 4,
    right: window.innerWidth - rect.right,
  };
}

export function SessionRow({
  locale,
  session,
  active,
  fallbackTitle,
  onOpen,
  onRename,
  onDelete,
  onPin,
  rowRef,
}: {
  locale: Locale;
  session: Session;
  active: boolean;
  fallbackTitle: string;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
  onPin: (pinned: boolean) => void;
  rowRef?: (node: HTMLLIElement | null) => void;
}) {
  const text = translations[locale];
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{top: number; right: number} | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  // 之前是否打开过：关闭时据此决定要不要把焦点还给触发按钮（LanguageMenu 同款语义）。
  const wasOpenRef = useRef(false);

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [],
    );
  }

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) {
        return;
      }
      setMenuOpen(false);
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    function place() {
      const button = buttonRef.current;
      if (!button) {
        return;
      }
      setMenuPoint(menuPointFor(button));
    }
    document.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [menuOpen]);

  // 打开即把焦点挪进菜单（第一项），关闭把焦点还给触发按钮——role="menu"
  // 的语义向读屏用户承诺了这些行为。点重命名/删除时弹窗会先抢走焦点，
  // 那时焦点既不在 body 也不在菜单里，下面的守卫保证不抢回来。
  useEffect(() => {
    if (menuOpen) {
      wasOpenRef.current = true;
      const items = menuItems();
      const target = items.at(0);
      if (target !== undefined) {
        target.focus();
      }
      return;
    }
    if (!wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = false;
    // 浮层转入 inert 时浏览器会把焦点丢回 body：只在那时（或焦点还留在
    // 菜单里时）接管；点外部按钮关闭的场景，焦点已在点击目标上，不抢。
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (active instanceof Node && menuRef.current?.contains(active))
    ) {
      buttonRef.current?.focus();
    }
  }, [menuOpen]);

  // 方向键导航：上/下循环移动，Home/End 跳首尾。type-ahead 不做：一共
  // 只有三项，方向键循环已经够用。
  function onMenuKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next].focus();
  }

  function openMenu(event: MouseEvent<HTMLButtonElement>) {
    setMenuPoint(menuPointFor(event.currentTarget));
    setMenuOpen((open) => !open);
  }

  const rowClass = active
    ? 'group mb-1 flex items-center rounded-lg border border-primary bg-primary/10'
    : 'group mb-1 flex items-center rounded-lg border border-transparent transition-colors duration-150 ease-out hover:bg-base-content/5';
  const dotsShown = menuOpen || renameOpen || deleteOpen || active;
  const actionClass = dotsShown
    ? 'relative mr-1 shrink-0 opacity-100 transition-opacity duration-200 ease-out'
    : 'relative mr-1 shrink-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-within:opacity-100';

  return (
    <li ref={rowRef} className={rowClass}>
      <button
        type="button"
        className="min-w-0 flex-1 truncate border-0 bg-transparent px-3 py-2 text-left"
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
      >
        {sessionTitle(session, fallbackTitle)}
      </button>
      {session.pinned ? <Pin aria-hidden="true" className="mr-1 size-3.5 shrink-0" /> : null}
      <div className={actionClass}>
        <button
          type="button"
          className="btn btn-ghost btn-sm btn-square text-inherit"
          ref={buttonRef}
          aria-label={text.sessionActions}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={openMenu}
        >
          <Ellipsis aria-hidden="true" className="size-4" />
        </button>
      </div>
      {createPortal(
        <div
          ref={menuRef}
          className={
            menuOpen
              ? 'fixed z-50 min-w-36 rounded-box border border-base-300 bg-base-100 shadow-lg'
              : 'fixed z-50 hidden'
          }
          style={menuPoint ? {top: menuPoint.top, right: menuPoint.right} : undefined}
          role="menu"
          aria-hidden={!menuOpen}
          inert={!menuOpen}
          onKeyDown={onMenuKeyDown}
        >
          <ul className="menu w-full p-1.5" role="none">
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  setRenameOpen(true);
                }}
              >
                {text.rename}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onPin(!session.pinned);
                }}
              >
                {session.pinned ? text.unpin : text.pin}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                className="text-error"
                onClick={() => {
                  setMenuOpen(false);
                  setDeleteOpen(true);
                }}
              >
                {text.deleteSession}
              </button>
            </li>
          </ul>
        </div>,
        document.body,
      )}
      <RenameSession
        locale={locale}
        open={renameOpen}
        initialTitle={session.title ?? ''}
        error={dialogError}
        onCancel={() => {
          setDialogError(null);
          setRenameOpen(false);
        }}
        onConfirm={async (title) => {
          const saved = await onRename(title);
          if (saved) {
            setRenameOpen(false);
          } else {
            // 没成功：弹窗留着，错误就写在弹窗里，别让用户什么都看不到。
            setDialogError(text.actionFailed);
          }
          return saved;
        }}
      />
      <ConfirmDelete
        locale={locale}
        open={deleteOpen}
        error={dialogError}
        onCancel={() => {
          setDialogError(null);
          setDeleteOpen(false);
        }}
        onConfirm={async () => {
          const removed = await onDelete();
          if (removed) {
            setDeleteOpen(false);
          } else {
            setDialogError(text.actionFailed);
          }
          return removed;
        }}
      />
    </li>
  );
}
