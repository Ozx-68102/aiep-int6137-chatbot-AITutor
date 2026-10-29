import {PanelLeftOpen, Send} from 'lucide-react';
import type {SubmitEvent} from 'react';
import {translations} from '../../i18n.ts';
import {sessionTitle} from '../../session/empty.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {bubbleClass} from './message-class.ts';

function visibleText(role: 'user' | 'assistant' | 'error', text: string): string {
  if (role !== 'assistant') {
    return text;
  }
  return text.replace(/^\n+/, '');
}

export function ChatMain({
  locale,
  sidebarOpen,
  onShowSidebar,
  active,
  notice,
  enteringIds,
  onAnimationEnd,
  pending,
  draft,
  inputLocked,
  sendLocked,
  onDraft,
  onSubmit,
}: {
  locale: Locale;
  sidebarOpen: boolean;
  onShowSidebar: () => void;
  active: Session | undefined;
  notice: string | null;
  enteringIds: string[];
  onAnimationEnd: (id: string) => void;
  pending: boolean;
  draft: string;
  inputLocked: boolean;
  sendLocked: boolean;
  onDraft: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
}) {
  const text = translations[locale];

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-stone-300 px-4 py-3">
        {sidebarOpen ? null : (
          <button
            type="button"
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
            aria-label={text.showSidebar}
            title={text.showSidebar}
            onClick={onShowSidebar}
          >
            <PanelLeftOpen aria-hidden="true" />
          </button>
        )}
        <h1 className="m-0 min-w-0 flex-1 truncate text-lg">
          {active ? sessionTitle(active, text.newChat) : text.newChat}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-4" aria-live="polite" aria-busy={pending}>
        {notice ? (
          <p
            className="mb-3 text-red-600"
            role="alert"
            lang={notice === text.connectionError ? htmlLang[locale] : 'zh-Hans'}
          >
            {notice}
          </p>
        ) : null}
        {active && active.messages.length > 0
          ? active.messages.map((message) => {
              const textShown = visibleText(message.role, message.text);
              if (textShown === '') {
                return null;
              }
              return (
                <p
                  key={message.id}
                  lang={message.locale ? htmlLang[message.locale] : undefined}
                  className={bubbleClass(message.role, enteringIds.includes(message.id))}
                  onAnimationEnd={() => onAnimationEnd(message.id)}
                >
                  {textShown}
                </p>
              );
            })
          : null}
        {!active || (active.messagesKnown && active.messages.length === 0) ? (
          <p className="m-0 text-stone-500">{text.empty}</p>
        ) : null}
      </div>
      <form
        className="flex items-center gap-2 border-t border-stone-300 px-4 pt-3 pb-4"
        onSubmit={onSubmit}
      >
        <input
          className={
            inputLocked
              ? 'min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2.5 opacity-50'
              : 'min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2.5'
          }
          value={draft}
          placeholder={text.placeholder}
          aria-label={text.placeholder}
          disabled={inputLocked}
          onChange={(event) => onDraft(event.target.value)}
        />
        <button
          type="submit"
          className={
            sendLocked || draft.trim() === ''
              ? 'inline-flex size-9 shrink-0 cursor-default items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit opacity-50'
              : 'inline-flex size-9 shrink-0 items-center justify-center rounded-lg border border-emerald-900 bg-emerald-900 text-white transition-[filter] duration-150 ease-out enabled:hover:brightness-95 enabled:active:brightness-90'
          }
          aria-label={text.send}
          title={text.send}
          disabled={sendLocked || draft.trim() === ''}
        >
          <Send aria-hidden="true" />
        </button>
      </form>
    </main>
  );
}
