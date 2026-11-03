import {PanelLeftClose, SquarePlus} from 'lucide-react';
import {useLayoutEffect, useRef} from 'react';
import {SessionRow} from './SessionRow.tsx';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {translations} from '../../i18n.ts';
import {orderSessions} from '../../session/pin-order.ts';
import type {Session} from '../../type/chat.ts';
import type {Locale} from '../../type/locale.ts';
import {AvatarImage} from '../avatar/AvatarImage.tsx';
import {sidebarClass} from './class.ts';

export function Sidebar({
  locale,
  narrow,
  open,
  sessions,
  activeId,
  settingsOpen,
  username,
  avatarUrl,
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
  avatarUrl: string | null;
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
        if (
          row.style.transform === '' ||
          row.style.transform === 'none' ||
          row.style.transform === 'translateY(0)'
        ) {
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
              className="btn btn-ghost h-auto shrink-0 p-0"
              aria-label={text.createSession}
              title={text.createSession}
              onClick={onCreate}
            >
              <img src={logoUrl} alt="" className="h-12 w-auto" />
            </button>
            <p lang="en" className="min-w-0 text-xs leading-tight text-stone-600">
              Help × Higher Understanding
            </p>
          </div>
          <button
            type="button"
            className="btn btn-square shrink-0 border-base-300 bg-base-100 text-inherit hover:bg-base-200 active:bg-base-300"
            aria-label={text.hideSidebar}
            title={text.hideSidebar}
            onClick={onClose}
          >
            <PanelLeftClose aria-hidden="true" />
          </button>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={onCreate}>
          <SquarePlus aria-hidden="true" className="size-4 shrink-0" />
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
              ? 'btn btn-block justify-start border-primary bg-primary/10 text-left hover:bg-primary/15 active:bg-primary/20'
              : 'btn btn-block justify-start border-base-300 bg-base-100 text-left hover:bg-base-200 active:bg-base-300'
          }
          aria-current={settingsOpen ? 'page' : undefined}
          onClick={onOpenSettings}
        >
          <AvatarImage
            src={avatarUrl}
            alt=""
            className="size-7 shrink-0 rounded-full border border-base-300 bg-base-200 object-cover"
          />
          <span className="truncate">{username ?? text.profile}</span>
        </button>
      </aside>
    </>
  );
}
