import {CircleStop, PanelLeftOpen, Send} from 'lucide-react';
import type {SubmitEvent} from 'react';
import {translations} from '../../i18n.ts';
import {sessionTitle} from '../../session/empty.ts';
import {visibleText, waitingForText} from '../../session/text.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {bubbleClass} from './message-class.ts';
import {MarkdownText} from './MarkdownText.tsx';
import {MessageActions} from './MessageActions.tsx';
import {ThinkingBubble} from './ThinkingBubble.tsx';
import {WarningBox, type WarningItem} from './WarningBox.tsx';

export function ChatMain({
  locale,
  sidebarOpen,
  onShowSidebar,
  active,
  warnings,
  enteringIds,
  onAnimationEnd,
  pending,
  draft,
  inputLocked,
  sendLocked,
  onDraft,
  onSubmit,
  onStop,
  onRetry,
}: {
  locale: Locale;
  sidebarOpen: boolean;
  onShowSidebar: () => void;
  active: Session | undefined;
  warnings: WarningItem[];
  enteringIds: string[];
  onAnimationEnd: (id: string) => void;
  pending: boolean;
  draft: string;
  inputLocked: boolean;
  sendLocked: boolean;
  onDraft: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRetry: (turnId: string) => void;
}) {
  const text = translations[locale];

  return (
    <main className="flex min-h-0 min-w-0 flex-col bg-white">
      <header className="flex items-center justify-between gap-2 border-b border-stone-300 px-4 py-3">
        {sidebarOpen ? null : (
          <button
            type="button"
            className="btn btn-ghost btn-square btn-sm shrink-0"
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
        {active && active.messages.length > 0
          ? active.messages.map((message) => {
              const entering = enteringIds.includes(message.id);
              const textShown = visibleText(message.role, message.text);
              if (textShown === '') {
                if (waitingForText(message)) {
                  return (
                    <ThinkingBubble
                      key={message.id}
                      entering={entering}
                      label={text.thinking}
                      onAnimationEnd={() => onAnimationEnd(message.id)}
                    />
                  );
                }
                if (
                  message.role === 'assistant' &&
                  (message.failed === true || message.aborted === true)
                ) {
                  // 零文字的失败/被停轮：没有气泡，只有脚注，
                  // 位置自然落在用户提问下方（docs/MESSAGE_ACTIONS.md）。
                  const classes = bubbleClass('assistant', false);
                  return (
                    <div key={message.id} className={`${classes.wrap} group`}>
                      <MessageActions
                        message={message}
                        failedText={text.replyInterrupted}
                        stoppedText={text.replyStopped}
                        retryLabel={text.retry}
                        entering={entering}
                        onRetry={onRetry}
                        onAnimationEnd={() => onAnimationEnd(message.id)}
                      />
                    </div>
                  );
                }
                return null;
              }
              if (message.role === 'assistant') {
                const classes = bubbleClass(message.role, entering);
                return (
                  <div key={message.id} className={`${classes.wrap} group`}>
                    <div
                      lang={message.locale ? htmlLang[message.locale] : undefined}
                      className={classes.bubble}
                      onAnimationEnd={() => onAnimationEnd(message.id)}
                    >
                      <MarkdownText text={textShown} />
                    </div>
                    <MessageActions
                      message={message}
                      failedText={text.replyInterrupted}
                      stoppedText={text.replyStopped}
                      retryLabel={text.retry}
                      entering={entering}
                      onRetry={onRetry}
                      onAnimationEnd={() => onAnimationEnd(message.id)}
                    />
                  </div>
                );
              }
              // TODO（docs/MESSAGE_ACTIONS.md 第三期）：最后一轮用户提问的脚注 hover 区里
              // 加「编辑」按钮，点开是就地展开的编辑框（Enter/「发送」发出、Shift+Enter 换行、
              // Esc 取消），发出去等于把这一轮重问一遍，用户视角跟「重试」一样。
              const classes = bubbleClass(message.role, entering);
              return (
                <div key={message.id} className={`${classes.wrap} group`}>
                  <p
                    lang={message.locale ? htmlLang[message.locale] : undefined}
                    className={classes.bubble}
                    onAnimationEnd={() => onAnimationEnd(message.id)}
                  >
                    {textShown}
                  </p>
                  <MessageActions
                    message={message}
                    failedText={text.replyInterrupted}
                    stoppedText={text.replyStopped}
                    retryLabel={text.retry}
                    onRetry={onRetry}
                  />
                </div>
              );
            })
          : null}
        {!active || (active.messagesKnown && active.messages.length === 0) ? (
          <p className="m-0 text-stone-500">{text.empty}</p>
        ) : null}
      </div>
      {/* 警示横幅：聊天滚动区与输入区之间的流内兄弟节点。分隔线固定在输入区顶上，
          横幅坐在线的正上方，出现时压缩滚动区高度、不遮挡内容；多条纵向堆叠。 */}
      {warnings.length > 0 ? (
        <div className="px-4 pt-3">
          {warnings.map((warning) => (
            <WarningBox
              key={warning.id}
              tone={warning.tone}
              text={warning.text}
              dismissLabel={text.close}
              onDismiss={warning.onDismiss}
            />
          ))}
        </div>
      ) : null}
      <div className="border-t border-stone-300 px-4 pt-3 pb-4">
        <form className="flex items-center gap-2" onSubmit={onSubmit}>
          <input
            className="input min-w-0 flex-1"
            value={draft}
            placeholder={text.placeholder}
            aria-label={text.placeholder}
            disabled={inputLocked}
            onChange={(event) => onDraft(event.target.value)}
          />
          {pending ? (
            <button
              type="button"
              className="btn btn-ghost btn-square btn-sm shrink-0"
              aria-label={text.stop}
              title={text.stop}
              onClick={onStop}
            >
              <CircleStop aria-hidden="true" />
            </button>
          ) : (
            <button
              type="submit"
              className={
                sendLocked || draft.trim() === ''
                  ? 'btn btn-square btn-sm shrink-0'
                  : 'btn btn-primary btn-square btn-sm shrink-0'
              }
              aria-label={text.send}
              title={text.send}
              disabled={sendLocked || draft.trim() === ''}
            >
              <Send aria-hidden="true" />
            </button>
          )}
        </form>
      </div>
    </main>
  );
}
