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
    setDraft('');
  }

  return (
    <div className={sidebarOpen ? 'app' : 'app sidebar-closed'}>
      {sidebarOpen ? (
        <aside className="sidebar" aria-label={text.sessions}>
          <div className="sidebar-top">
            <button
              type="button"
              className="icon-button"
              aria-label={text.newChat}
              title={text.newChat}
              onClick={addSession}
            >
              <Plus aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={text.hideSidebar}
              title={text.hideSidebar}
              onClick={() => setSidebarOpen(false)}
            >
              <PanelLeftClose aria-hidden="true" />
            </button>
          </div>
          <ul className="session-list">
            {sessions.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  className={session.id === active?.id ? 'session current' : 'session'}
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
      ) : null}
      <main className="chat">
        <header className="chat-bar">
          {sidebarOpen ? null : (
            <button
              type="button"
              className="icon-button"
              aria-label={text.showSidebar}
              title={text.showSidebar}
              onClick={() => setSidebarOpen(true)}
            >
              <PanelLeftOpen aria-hidden="true" />
            </button>
          )}
          <h1 lang="en">H^2 Bot</h1>
          <div className="languages" ref={languageMenuRef}>
            <button
              type="button"
              className="icon-button"
              aria-label={text.language}
              aria-expanded={languageOpen}
              aria-haspopup="menu"
              title={text.language}
              onClick={() => setLanguageOpen((open) => !open)}
            >
              <Languages aria-hidden="true" />
            </button>
            {languageOpen ? (
              <div className="language-menu" role="menu" aria-label={text.language}>
                {locales.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitemradio"
                    lang={htmlLang[item.id]}
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
            ) : null}
          </div>
        </header>
        <div className="messages" aria-live="polite">
          {active && active.messages.length > 0 ? (
            active.messages.map((message) => (
              <p
                key={message.id}
                lang={htmlLang[message.locale]}
                className={message.role === 'user' ? 'bubble user' : 'bubble assistant'}
              >
                {message.text}
              </p>
            ))
          ) : (
            <p className="empty">{text.empty}</p>
          )}
        </div>
        <form className="composer" onSubmit={submitMessage}>
          <input
            value={draft}
            placeholder={text.placeholder}
            aria-label={text.placeholder}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="icon-button"
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
