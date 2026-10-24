import {Languages, PanelLeftClose, PanelLeftOpen, Plus, Send} from 'lucide-react';
import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {sendMessage} from './api/chat.ts';
import {locales, translations} from './i18n.ts';
import type {Message, Session} from './type/chat.ts';
import type {Locale} from './type/locale.ts';

const htmlLang: Record<Locale, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  'en': 'en',
};

function createSession(): Session {
  return {id: crypto.randomUUID(), title: null, titleLocale: null, messages: []};
}

function sessionTitle(session: Session, fallback: string): string {
  return session.title ?? fallback;
}

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh-CN');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessions, setSessions] = useState<Session[]>(() => [createSession()]);
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? '');
  const [draft, setDraft] = useState('');
  const [languageOpen, setLanguageOpen] = useState(false);
  const [enteringIds, setEnteringIds] = useState<string[]>([]);
  const languageMenuRef = useRef<HTMLDivElement>(null);
  const text = translations[locale];
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0];

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale];
    document.title = 'H^2 Bot';
  }, [locale]);

  useEffect(() => {
    if (!languageOpen) {
      return;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      if (!languageMenuRef.current?.contains(event.target as Node)) {
        setLanguageOpen(false);
      }
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setLanguageOpen(false);
      }
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [languageOpen]);

  function openSession(id: string) {
    setActiveId(id);
  }

  function addSession() {
    const session = createSession();
    setSessions((current) => [session, ...current]);
    setActiveId(session.id);
    setDraft('');
  }

  function submitMessage(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || !active) {
      return;
    }
    const answer = sendMessage(question, locale);
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      locale,
    };
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: answer,
      locale,
    };
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== active.id) {
          return session;
        }
        return {
          ...session,
          title: session.title ?? question,
          titleLocale: session.titleLocale ?? locale,
          messages: [...session.messages, userMessage, assistantMessage],
        };
      }),
    );
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      setEnteringIds((current) => [...current, userMessage.id, assistantMessage.id]);
    }
    setDraft('');
  }

  return (
    <div
      className={
        sidebarOpen
          ? 'grid h-full grid-cols-[16rem_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out'
          : 'grid h-full grid-cols-[0_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out'
      }
    >
      <aside
        className={
          sidebarOpen
            ? 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r border-stone-300 bg-stone-200 p-3'
            : 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r-0 bg-stone-200 px-0 py-3'
        }
        aria-label={text.sessions}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen}
      >
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
              aria-label={text.newChat}
              title={text.newChat}
              onClick={addSession}
            >
              <Plus aria-hidden="true" />
            </button>
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
              aria-label={text.hideSidebar}
              title={text.hideSidebar}
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeftClose aria-hidden="true" />
            </button>
          </div>
          <ul className="m-0 min-h-0 flex-1 list-none overflow-auto p-0">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={
                    session.id === active?.id
                      ? 'mb-1 w-full truncate rounded-lg border border-emerald-900 bg-emerald-50 px-3 py-2 text-left'
                      : 'mb-1 w-full truncate rounded-lg border border-transparent bg-transparent px-3 py-2 text-left'
                  }
                  lang={session.titleLocale ? htmlLang[session.titleLocale] : undefined}
                  aria-current={session.id === active?.id ? 'true' : undefined}
                  onClick={() => openSession(session.id)}
                >
                  {sessionTitle(session, text.newChat)}
                </button>
              </li>
            ))}
          </ul>
        </aside>
      <main className="flex min-h-0 min-w-0 flex-col bg-white">
        <header className="flex items-center justify-between gap-2 border-b border-stone-300 px-4 py-3">
          {sidebarOpen ? null : (
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
              aria-label={text.showSidebar}
              title={text.showSidebar}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen aria-hidden="true" />
            </button>
          )}
          <h1 lang="en" className="m-0 text-lg">H^2 Bot</h1>
          <div className="relative ml-auto" ref={languageMenuRef}>
            <button
              type="button"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit"
              aria-label={text.language}
              aria-expanded={languageOpen}
              aria-haspopup="menu"
              title={text.language}
              onClick={() => setLanguageOpen((open) => !open)}
            >
              <Languages aria-hidden="true" />
            </button>
            <div
              className={
                languageOpen
                  ? 'absolute top-[calc(100%+0.35rem)] right-0 z-10 flex min-w-36 animate-in flex-col rounded-lg border border-stone-300 bg-white p-1.5 fade-in slide-in-from-top-2 duration-200'
                  : 'absolute top-[calc(100%+0.35rem)] right-0 z-10 hidden'
              }
              role="menu"
              aria-label={text.language}
              aria-hidden={!languageOpen}
              inert={!languageOpen}
            >
              {locales.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                    lang={htmlLang[item.id]}
                    className={
                      item.id === locale
                        ? 'rounded-md border border-emerald-900 bg-emerald-50 px-2.5 py-1.5 text-left'
                        : 'rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left'
                    }
                    aria-checked={item.id === locale}
                  onClick={() => {
                    setLocale(item.id);
                    setLanguageOpen(false);
                  }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4" aria-live="polite">
          {active && active.messages.length > 0 ? (
            active.messages.map((message) => (
              <p
                key={message.id}
                lang={htmlLang[message.locale]}
                className={
                  message.role === 'user'
                    ? enteringIds.includes(message.id)
                      ? 'mb-3 ml-auto max-w-xl animate-in rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white fade-in slide-in-from-bottom-2 duration-200'
                      : 'mb-3 ml-auto max-w-xl rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white'
                    : enteringIds.includes(message.id)
                      ? 'mb-3 max-w-xl animate-in rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap fade-in slide-in-from-bottom-2 duration-200'
                      : 'mb-3 max-w-xl rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap'
                }
                onAnimationEnd={() => {
                  setEnteringIds((current) => current.filter((id) => id !== message.id));
                }}
              >
                {message.text}
              </p>
            ))
          ) : (
            <p className="m-0 text-stone-500">{text.empty}</p>
          )}
        </div>
        <form className="flex items-center gap-2 border-t border-stone-300 px-4 pt-3 pb-4" onSubmit={submitMessage}>
          <input
            className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2.5"
            value={draft}
            placeholder={text.placeholder}
            aria-label={text.placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-900 bg-emerald-900 text-white disabled:cursor-default disabled:border-stone-300 disabled:bg-white disabled:text-inherit disabled:opacity-50"
            aria-label={text.send}
            title={text.send}
            disabled={draft.trim() === ''}
          >
            <Send aria-hidden="true" />
          </button>
        </form>
      </main>
    </div>
  );
}
