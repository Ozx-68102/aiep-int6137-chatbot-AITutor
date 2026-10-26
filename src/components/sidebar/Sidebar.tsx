import {PanelLeftClose, SquarePlus, User} from 'lucide-react';
import {SessionRow} from './SessionRow.tsx';
import logoUrl from '../../assets/H-Squared_Bot_Vector.svg';
import {translations} from '../../i18n.ts';
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
  onRename: (id: string, title: string) => void;
  onDelete: (id: string) => void;
  onOpenSettings: () => void;
}) {
  const text = translations[locale];

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
              className="shrink-0 cursor-pointer border-0 bg-transparent p-0"
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
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
            aria-label={text.hideSidebar}
            title={text.hideSidebar}
            onClick={onClose}
          >
            <PanelLeftClose aria-hidden="true"/>
          </button>
        </div>
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2"
          onClick={onCreate}
        >
          <SquarePlus aria-hidden="true" className="size-4 shrink-0"/>
          {text.createSession}
        </button>
        <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              locale={locale}
              session={session}
              active={session.id === activeId}
              fallbackTitle={text.newChat}
              onOpen={() => onOpenSession(session.id)}
              onRename={(title) => onRename(session.id, title)}
              onDelete={() => onDelete(session.id)}
            />
          ))}
        </ul>
        <button
          type="button"
          className={
            settingsOpen
              ? 'flex w-full items-center gap-2 rounded-lg border border-emerald-900 bg-emerald-50 px-3 py-2 text-left'
              : 'flex w-full items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left'
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
