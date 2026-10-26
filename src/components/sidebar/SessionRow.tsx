import {Ellipsis} from 'lucide-react';
import {type MouseEvent, useEffect, useRef, useState} from 'react';
import {translations} from '../../i18n.ts';
import {sessionTitle} from '../../session/empty.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {ConfirmDelete} from './ConfirmDelete.tsx';
import {RenameSession} from './RenameSession.tsx';

export function SessionRow({
  locale,
  session,
  active,
  fallbackTitle,
  onOpen,
  onRename,
  onDelete,
}: {
  locale: Locale;
  session: Session;
  active: boolean;
  fallbackTitle: string;
  onOpen: () => void;
  onRename: (title: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const text = translations[locale];
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPoint, setMenuPoint] = useState<{top: number; right: number} | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  function openMenu(event: MouseEvent<HTMLButtonElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    setMenuPoint({top: rect.bottom + 4, right: window.innerWidth - rect.right});
    setMenuOpen((open) => !open);
  }

  const rowClass = active
    ? 'group mb-1 flex items-center rounded-lg border border-emerald-900 bg-emerald-50'
    : 'group mb-1 flex items-center rounded-lg border border-transparent';
  const actionClass = menuOpen || renameOpen || deleteOpen
    ? 'relative mr-1 shrink-0 opacity-100 transition-opacity duration-200 ease-out'
    : 'pointer-events-none relative mr-1 shrink-0 opacity-0 transition-opacity duration-200 ease-out group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100';

  return (
    <li className={rowClass}>
      <button
        type="button"
        className="min-w-0 flex-1 truncate border-0 bg-transparent px-3 py-2 text-left"
        lang={session.titleLocale ? htmlLang[session.titleLocale] : undefined}
        aria-current={active ? 'true' : undefined}
        onClick={onOpen}
      >
        {sessionTitle(session, fallbackTitle)}
      </button>
      <div className={actionClass} ref={menuRef}>
        <button
          type="button"
          className="inline-flex size-8 items-center justify-center rounded-lg border border-transparent bg-transparent text-inherit transition-colors duration-200 ease-out hover:bg-stone-900/10"
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
            className="rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left"
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
            className="rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left"
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
