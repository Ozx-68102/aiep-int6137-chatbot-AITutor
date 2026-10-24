import { useEffect, useState, type FormEvent } from 'react'
import { sendMessage } from './api/chat.ts'
import { locales, translations, type Locale } from './i18n.ts'

type Message = {
  id: string
  role: 'user' | 'assistant'
  text: string
  locale: Locale
}

type Session = {
  id: string
  title: string | null
  titleLocale: Locale | null
  messages: Message[]
}

const htmlLang: Record<Locale, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
  en: 'en',
}

function createSession(): Session {
  return { id: crypto.randomUUID(), title: null, titleLocale: null, messages: [] }
}

function sessionTitle(session: Session, fallback: string): string {
  return session.title ?? fallback
}

export default function App() {
  const [locale, setLocale] = useState<Locale>('zh-CN')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sessions, setSessions] = useState<Session[]>(() => [createSession()])
  const [activeId, setActiveId] = useState(() => sessions[0]?.id ?? '')
  const [draft, setDraft] = useState('')
  const text = translations[locale]
  const active = sessions.find((session) => session.id === activeId) ?? sessions[0]

  useEffect(() => {
    document.documentElement.lang = htmlLang[locale]
    document.title = 'H^2 Bot'
  }, [locale])

  function openSession(id: string) {
    setActiveId(id)
  }

  function addSession() {
    const session = createSession()
    setSessions((current) => [session, ...current])
    setActiveId(session.id)
    setDraft('')
  }

  function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const question = draft.trim()
    if (!question || !active) {
      return
    }
    const answer = sendMessage(question, locale)
    const userMessage: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      text: question,
      locale,
    }
    const assistantMessage: Message = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: answer,
      locale,
    }
    setSessions((current) =>
      current.map((session) => {
        if (session.id !== active.id) {
          return session
        }
        return {
          ...session,
          title: session.title ?? question,
          titleLocale: session.titleLocale ?? locale,
          messages: [...session.messages, userMessage, assistantMessage],
        }
      }),
    )
    setDraft('')
  }

  return (
    <div className={sidebarOpen ? 'app' : 'app sidebar-closed'}>
      {sidebarOpen ? (
        <aside className="sidebar" aria-label={text.sessions}>
          <div className="sidebar-top">
            <button type="button" onClick={() => setSidebarOpen(false)}>
              {text.hideSidebar}
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
          <button type="button" className="new-chat" onClick={addSession}>
            {text.newChat}
          </button>
        </aside>
      ) : null}
      <main className="chat">
        <header className="chat-bar">
          {sidebarOpen ? null : (
            <button type="button" onClick={() => setSidebarOpen(true)}>
              {text.showSidebar}
            </button>
          )}
          <h1 lang="en">H^2 Bot</h1>
          <div className="languages" role="group" aria-label={text.language}>
            {locales.map((item) => (
              <button
                key={item.id}
                type="button"
                lang={htmlLang[item.id]}
                aria-pressed={item.id === locale}
                onClick={() => setLocale(item.id)}
              >
                {item.label}
              </button>
            ))}
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
          <button type="submit" disabled={draft.trim() === ''}>
            {text.send}
          </button>
        </form>
      </main>
    </div>
  )
}
