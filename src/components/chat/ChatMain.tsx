import {ArrowDown, CircleStop, PanelLeftOpen, Send} from 'lucide-react';
import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import {translations} from '../../i18n.ts';
import {sessionTitle} from '../../session/empty.ts';
import {visibleText, waitingForText} from '../../session/text.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {BubbleBoundary} from './BubbleBoundary.tsx';
import {bubbleClass} from './message-class.ts';
import {MarkdownText} from './MarkdownText.tsx';
import {MessageActions} from './MessageActions.tsx';
import {ThinkingBubble} from './ThinkingBubble.tsx';
import {WarningBox, type WarningItem} from './WarningBox.tsx';

/** 正在编辑的那条提问：气泡 id、轮次编号、框里当前的文字。 */
type EditingState = {messageId: string; turnId: string; text: string};

export function ChatMain({
  locale,
  sidebarOpen,
  onShowSidebar,
  active,
  warnings,
  enteringIds,
  onAnimationEnd,
  pending,
  progressText,
  draft,
  inputLocked,
  sendLocked,
  onDraft,
  onSubmit,
  onStop,
  onRetry,
  onEditResend,
}: {
  locale: Locale;
  sidebarOpen: boolean;
  onShowSidebar: () => void;
  active: Session | undefined;
  warnings: WarningItem[];
  enteringIds: Set<string>;
  onAnimationEnd: (id: string) => void;
  pending: boolean;
  progressText: string | undefined;
  draft: string;
  inputLocked: boolean;
  sendLocked: boolean;
  onDraft: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRetry: (turnId: string) => void;
  onEditResend: (turnId: string, text: string) => void;
}) {
  const text = translations[locale];
  // 滚动跟随：距底 48px 以内算贴底。贴底时内容变化自动滚到底；用户往上滚
  // 就停止跟随，露出悬浮的「回到底部」圆钮。切换会话时 App.tsx 用 key 把
  // 本组件整个重挂载，贴底状态自然复位。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= 48);
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    // 一步滚到底，不用平滑滚动：平滑滚动的中间状态会把贴底判定又打回去。
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  }
  // 输入框自动长高：随内容增高，CSS 的 max-h-40 封顶后内部滚动。做成对
  // draft 的 effect：草稿被程序性清空/恢复（切会话、被踢后回填）时高度也同步。
  const formRef = useRef<HTMLFormElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = textareaRef.current;
    if (el === null) {
      return;
    }
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // 编辑态：最后一轮的用户提问就地换成编辑框（docs/MESSAGE_ACTIONS.md 第三期）。
  // 切换会话时 App.tsx 用 key 把整个 ChatMain 重挂载，没提交的编辑框跟着清掉。
  const [editing, setEditing] = useState<EditingState | null>(null);
  const editAreaRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = editAreaRef.current;
    if (el === null) {
      return;
    }
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [editing?.text]);
  const chatMessages = active?.messages ?? [];
  // 贴底时跟着内容变化贴住底部：流式输出、新消息、编辑框长高都算。
  useEffect(() => {
    if (!atBottom) {
      return;
    }
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    el.scrollTop = el.scrollHeight;
  }, [atBottom, active?.messages, editing?.text]);
  let lastUserMessageId: string | null = null;
  for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
    if (chatMessages[index].role === 'user') {
      lastUserMessageId = chatMessages[index].id;
      break;
    }
  }
  function submitEdit() {
    if (editing === null || editing.text.trim() === '' || pending) {
      return;
    }
    onEditResend(editing.turnId, editing.text);
    setEditing(null);
  }

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
      {/* 读屏播报收窄到这一处：只在本会话有等待中的回答时报「正在思考」，
          空闲时为空。消息滚动容器不再整个 aria-live，改成 role="log"。 */}
      <span className="sr-only" role="status" aria-live="polite">
        {pending ? text.thinking : ''}
      </span>
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          className="h-full overflow-auto p-4"
          role="log"
          aria-label={active ? sessionTitle(active, text.newChat) : text.newChat}
          onScroll={handleScroll}
          aria-busy={pending}
        >
          {active && active.messages.length > 0
            ? active.messages.map((message) => {
                const entering = enteringIds.has(message.id);
                const textShown = visibleText(message.role, message.text);
                if (textShown === '') {
                  if (waitingForText(message)) {
                    return (
                      <ThinkingBubble
                        key={message.id}
                        entering={entering}
                        label={text.thinking}
                        progress={progressText}
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
                      <BubbleBoundary fallbackText={textShown}>
                        <div
                          lang={message.locale ? htmlLang[message.locale] : undefined}
                          className={classes.bubble}
                          onAnimationEnd={() => onAnimationEnd(message.id)}
                        >
                          <MarkdownText text={textShown} />
                        </div>
                      </BubbleBoundary>
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
                const classes = bubbleClass(message.role, entering);
                if (editing !== null && editing.messageId === message.id) {
                  // 编辑态：气泡原地换成自动长高的编辑框，右下角「取消」「发送」。
                  // Enter/「发送」发出、Shift+Enter 换行、Esc 取消
                  //（docs/MESSAGE_ACTIONS.md 第三期）。
                  return (
                    <div key={message.id} className={classes.wrap}>
                      <div className="w-full max-w-[600px]">
                        <textarea
                          ref={editAreaRef}
                          autoFocus
                          className="textarea w-full min-h-10 max-h-40 resize-none overflow-y-auto text-base"
                          rows={2}
                          maxLength={8000}
                          value={editing.text}
                          aria-label={text.edit}
                          onChange={(event) =>
                            setEditing({
                              messageId: message.id,
                              turnId: editing.turnId,
                              text: event.target.value,
                            })
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Escape') {
                              event.preventDefault();
                              setEditing(null);
                              return;
                            }
                            if (
                              event.key === 'Enter' &&
                              !event.shiftKey &&
                              !event.nativeEvent.isComposing
                            ) {
                              event.preventDefault();
                              submitEdit();
                            }
                          }}
                        />
                        <div className="mt-2 flex justify-end gap-2">
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm"
                            onClick={() => setEditing(null)}
                          >
                            {text.cancel}
                          </button>
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={editing.text.trim() === '' || pending}
                            onClick={submitEdit}
                          >
                            {text.send}
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                }
                // 编辑按钮只给最后一轮的用户提问；流式输出中（pending）不出现。
                const canEdit =
                  !pending && message.id === lastUserMessageId && message.turnId !== undefined;
                return (
                  <div key={message.id} className={`${classes.wrap} group`}>
                    <BubbleBoundary fallbackText={textShown}>
                      <p
                        lang={message.locale ? htmlLang[message.locale] : undefined}
                        className={classes.bubble}
                        onAnimationEnd={() => onAnimationEnd(message.id)}
                      >
                        {textShown}
                      </p>
                    </BubbleBoundary>
                    <MessageActions
                      message={message}
                      failedText={text.replyInterrupted}
                      stoppedText={text.replyStopped}
                      retryLabel={text.retry}
                      onRetry={onRetry}
                      canEdit={canEdit}
                      editLabel={text.edit}
                      onEdit={
                        canEdit
                          ? () =>
                              setEditing({
                                messageId: message.id,
                                turnId: message.turnId ?? '',
                                text: message.text,
                              })
                          : undefined
                      }
                    />
                  </div>
                );
              })
            : null}
          {!active || (active.messagesKnown && active.messages.length === 0) ? (
            <p className="m-0 text-stone-500">{text.empty}</p>
          ) : null}
        </div>
        {!atBottom ? (
          <button
            type="button"
            className="btn btn-circle btn-ghost bg-base-100 shadow absolute bottom-4 left-1/2 z-10 -translate-x-1/2"
            aria-label={text.backToBottom}
            title={text.backToBottom}
            onClick={scrollToBottom}
          >
            <ArrowDown aria-hidden="true" />
          </button>
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
        <form ref={formRef} className="flex items-end gap-2" onSubmit={onSubmit}>
          <textarea
            ref={textareaRef}
            className="textarea min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto text-base"
            rows={1}
            maxLength={8000}
            value={draft}
            placeholder={text.placeholder}
            aria-label={text.placeholder}
            disabled={inputLocked}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => {
              // Enter 发送、Shift+Enter 换行。输入法组合期的回车是在选词
              // （isComposing），不算发送——中文打字不会误发。
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                formRef.current?.requestSubmit();
              }
            }}
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
