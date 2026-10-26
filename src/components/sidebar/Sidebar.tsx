import {PanelLeftClose, SquarePlus, User} from 'lucide-react';
import {useLayoutEffect, useRef} from 'react';
import {SessionRow} from './SessionRow.tsx';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {translations} from '../../i18n.ts';
import {orderSessions} from '../../session/pin-order.ts';
import type {Session} from '../../type/chat.ts';
import type {Locale} from '../../type/locale.ts';
import {sidebarClass} from './class.ts';

export function Sidebar({
  locale,
  narrow,
  open,
  sessions,
  activeId,
  settingsOpen,
  username,
  onCreate,
  onClose,
  onOpenSession,
  onRename,
  onDelete,
  onPin,
  onOpenSettings,
}: {
  locale: Locale;
  narrow: boolean;
  open: boolean;
  sessions: Session[];
  activeId: string | null;
  settingsOpen: boolean;
  username: string | null;
  onCreate: () => void;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onRename: (id: string, title: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onPin: (id: string, pinned: boolean) => void;
  onOpenSettings: () => void;
}) {
  const text = translations[locale];
  const ordered = orderSessions(sessions);
  const orderKey = ordered.map((session) => session.id).join('\n');
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const rowTops = useRef(new Map<string, number>());
  const previousOrder = useRef<string | null>(null);

  useLayoutEffect(() => {
    const orderChanged = previousOrder.current !== null && previousOrder.current !== orderKey;
    previousOrder.current = orderKey;
    if (!orderChanged) {
      for (const [id, row] of rowRefs.current) {
        if (row.style.transform === '' || row.style.transform === 'none' || row.style.transform === 'translateY(0)') {
          rowTops.current.set(id, row.getBoundingClientRect().top);
        }
      }
      return;
    }
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const seen = new Set<string>();
    for (const [id, row] of rowRefs.current) {
      seen.add(id);
      row.style.transition = 'none';
      row.style.transform = 'none';
      const nextTop = row.getBoundingClientRect().top;
      const previous = rowTops.current.get(id);
      if (!reduced && previous !== undefined && Math.abs(previous - nextTop) > 1) {
        const delta = previous - nextTop;
        row.style.transform = `translateY(${delta}px)`;
        requestAnimationFrame(() => {
          row.style.transition = 'transform 220ms ease-out';
          row.style.transform = 'translateY(0)';
        });
      }
      rowTops.current.set(id, nextTop);
    }
    for (const id of rowTops.current.keys()) {
      if (!seen.has(id)) {
        rowTops.current.delete(id);
      }
    }
  });

  return (
    <>
      {narrow ? (
        <button
          type="button"
          className={
            open
              ? 'absolute inset-0 z-30 border-0 bg-stone-900/40 opacity-100 transition-opacity duration-200 ease-out'
              : 'pointer-events-none absolute inset-0 z-30 border-0 bg-stone-900/40 opacity-0 transition-opacity duration-200 ease-out'
          }
          aria-label={text.hideSidebar}
          tabIndex={open ? 0 : -1}
          onClick={onClose}
        />
      ) : null}
      <aside
        className={sidebarClass(narrow, open)}
        aria-label={text.sessions}
        aria-hidden={!open}
        inert={!open}
      >
        <div className="flex items-center gap-3">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <button
              type="button"
              className="shrink-0 cursor-pointer rounded-lg border-0 bg-transparent p-0 transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
              aria-label={text.createSession}
              title={text.createSession}
              onClick={onCreate}
            >
              <img src={logoUrl} alt="" className="h-12 w-auto"/>
            </button>
            <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
              Help × Higher Understanding
            </p>
          </div>
          <button
            type="button"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
            aria-label={text.hideSidebar}
            title={text.hideSidebar}
            onClick={onClose}
          >
            <PanelLeftClose aria-hidden="true"/>
          </button>
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
          onClick={onCreate}
        >
          <SquarePlus aria-hidden="true" className="size-4 shrink-0"/>
          {text.createSession}
        </button>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {ordered.map((session) => (
            <SessionRow
              key={session.id}
              locale={locale}
              session={session}
              active={session.id === activeId}
              fallbackTitle={text.newChat}
              rowRef={(node) => {
                if (node) {
                  rowRefs.current.set(session.id, node);
                  return;
                }
                rowRefs.current.delete(session.id);
              }}
              onOpen={() => onOpenSession(session.id)}
              onRename={(title) => onRename(session.id, title)}
              onDelete={() => onDelete(session.id)}
              onPin={(pinned) => onPin(session.id, pinned)}
            />
          ))}
        </ul>
        <button
          type="button"
          className={
            settingsOpen
              ? 'flex w-full items-center gap-2 rounded-lg border border-emerald-900 bg-emerald-50 px-3 py-2 text-left transition-colors duration-150 ease-out enabled:hover:bg-emerald-100 enabled:active:bg-emerald-200'
              : 'flex w-full items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20'
          }
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={onOpenSettings}
        >
          <User aria-hidden="true" className="size-4 shrink-0"/>
          <span className="truncate">{username ?? text.profile}</span>
        </button>
      </aside>
    </>
  );
}
