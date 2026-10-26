import {Ellipsis, Pin} from 'lucide-react';
import {type MouseEvent, useEffect, useRef, useState} from 'react';
import {translations} from '../../i18n.ts';
import {sessionTitle} from '../../session/empty.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {ConfirmDelete} from './ConfirmDelete.tsx';
import {RenameSession} from './RenameSession.tsx';

function menuPointFor(button: HTMLButtonElement): {top: number; right: number} {
  const rect = button.getBoundingClientRect();
  const origin = menuOrigin(button);
  return {
    top: rect.bottom + 4 - origin.top,
    right: origin.right - rect.right,
  };
}

function menuOrigin(node: HTMLElement): {top: number; right: number} {
  let current = node.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (style.translate !== 'none' || style.transform !== 'none' || style.scale !== 'none' || style.rotate !== 'none') {
      const box = current.getBoundingClientRect();
      return {
        top: box.top + (Number.parseFloat(style.borderTopWidth) || 0),
        right: box.right - (Number.parseFloat(style.borderRightWidth) || 0),
      };
    }
    current = current.parentElement;
  }
  return {top: 0, right: window.innerWidth};
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
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!menuOpen) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
      }
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

  function openMenu(event: MouseEvent<HTMLButtonElement>) {
    setMenuPoint(menuPointFor(event.currentTarget));
    setMenuOpen((open) => !open);
  }

  const rowClass = active
    ? 'group mb-1 flex items-center rounded-lg border border-emerald-900 bg-emerald-50'
    : 'group mb-1 flex items-center rounded-lg border border-transparent transition-colors duration-150 ease-out hover:bg-stone-900/5';
  const dotsShown = menuOpen || renameOpen || deleteOpen || active;
  const actionClass = dotsShown
    ? 'relative mr-1 shrink-0 opacity-100 transition-opacity duration-200 ease-out'
    : 'relative mr-1 shrink-0 opacity-0 transition-opacity duration-200 ease-out group-hover:opacity-100 group-focus-within:opacity-100';

  return (
    <li ref={rowRef} className={rowClass}>
      <button
        type="button"
        className="min-w-0 flex-1 truncate border-0 bg-transparent px-3 py-2 text-left"
        lang={session.titleLocale ? htmlLang[session.titleLocale] : undefined}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
      >
        {sessionTitle(session, fallbackTitle)}
      </button>
      {session.pinned ? <Pin aria-hidden="true" className="mr-1 size-3.5 shrink-0"/> : null}
      <div className={actionClass} ref={menuRef}>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent bg-transparent text-inherit transition-colors duration-150 ease-out hover:bg-stone-900/15 active:bg-stone-900/25"
          ref={buttonRef}
          aria-label={text.sessionActions}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
          onClick={openMenu}
        >
          <Ellipsis aria-hidden="true" className="size-4"/>
        </button>
        <div
          className={
            menuOpen
              ? 'fixed z-50 flex min-w-36 flex-col rounded-lg border border-stone-300 bg-white p-1.5 shadow-lg'
              : 'fixed z-50 hidden'
          }
          style={menuPoint ? {top: menuPoint.top, right: menuPoint.right} : undefined}
          role="menu"
          aria-hidden={!menuOpen}
          inert={!menuOpen}
        >
          <button
            type="button"
            role="menuitem"
            className="rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
            onClick={() => {
              setMenuOpen(false);
              setRenameOpen(true);
            }}
          >
            {text.rename}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
            onClick={() => {
              setMenuOpen(false);
              onPin(!session.pinned);
            }}
          >
            {session.pinned ? text.unpin : text.pin}
          </button>
          <button
            type="button"
            role="menuitem"
            className="rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left text-red-600 transition-colors duration-150 ease-out enabled:hover:bg-red-600/10 enabled:active:bg-red-600/20"
            onClick={() => {
              setMenuOpen(false);
              setDeleteOpen(true);
            }}
          >
            {text.deleteSession}
          </button>
        </div>
      </div>
      {renameOpen ? (
        <RenameSession
          locale={locale}
          initialTitle={session.title ?? ''}
          onCancel={() => setRenameOpen(false)}
          onConfirm={async (title) => {
            const saved = await onRename(title);
            if (saved) {
              setRenameOpen(false);
            }
            return saved;
          }}
        />
      ) : null}
      {deleteOpen ? (
        <ConfirmDelete
          locale={locale}
          onCancel={() => setDeleteOpen(false)}
          onConfirm={async () => {
            const removed = await onDelete();
            if (removed) {
              setDeleteOpen(false);
            }
            return removed;
          }}
        />
      ) : null}
    </li>
  );
}
