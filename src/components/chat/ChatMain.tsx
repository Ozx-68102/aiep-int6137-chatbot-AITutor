import {ArrowDown, CircleStop, PanelLeftOpen, Send} from 'lucide-react';
import {type SubmitEvent, useEffect, useRef, useState} from 'react';
import type {FeedbackValue} from '../../api/feedback.ts';
import {translations} from '../../i18n/index.ts';
import {sessionTitle} from '../../session/empty.ts';
import {visibleText, waitingForText} from '../../session/text.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {BubbleBoundary} from './BubbleBoundary.tsx';
import {bubbleClass} from './message-class.ts';
import {MessageActions} from './MessageActions.tsx';
import {ThinkingBubble} from './ThinkingBubble.tsx';
import {TypewriterText} from './TypewriterText.tsx';
import {WarningBox, type WarningItem} from './WarningBox.tsx';
import {WELCOME_TEXT} from './welcome-text.ts';

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
  presentIds,
  onPresentEnd,
  progressText,
  draft,
  inputLocked,
  sendLocked,
  onWaitHint,
  onDraft,
  onSubmit,
  onStop,
  onRetry,
  onEditResend,
  onFeedback,
}: {
  locale: Locale;
  sidebarOpen: boolean;
  onShowSidebar: () => void;
  active: Session | undefined;
  warnings: WarningItem[];
  enteringIds: Set<string>;
  onAnimationEnd: (id: string) => void;
  pending: boolean;
  /** 要「打字机播放」的消息 id（轮次引擎登记）：只播放本轮刚收到的回答。 */
  presentIds: Set<string>;
  /** 播放结束（放完或取消）：引擎据此把 id 移出登记。 */
  onPresentEnd: (id: string) => void;
  progressText: string | undefined;
  draft: string;
  inputLocked: boolean;
  sendLocked: boolean;
  /** 「请等待 AI 回答完毕」轻提示：禁用发送按钮外壳的悬停浮层和触屏点按都走它。 */
  onWaitHint: () => void;
  onDraft: (value: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onStop: () => void;
  onRetry: (turnId: string) => void;
  onEditResend: (turnId: string, text: string) => void;
  onFeedback: (turnId: string, feedback: FeedbackValue) => Promise<boolean>;
}) {
  const text = translations[locale];
  // 滚动跟随：距底 48px 以内算贴底。贴底时内容变化自动滚到底；用户往上滚
  // 就停止跟随，露出悬浮的「回到底部」圆形按钮。切换会话时 App.tsx 用 key 把
  // 本组件整个重挂载，贴底状态自然复位。
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // atBottom 的 ref 镜像：播放每个周期调用 handleReveal，闭包里不能读到旧渲染的状态。
  const atBottomRef = useRef(true);

  function handleScroll() {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    const at = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    setAtBottom(at);
    atBottomRef.current = at;
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (el === null) {
      return;
    }
    // 一步滚到底，不用平滑滚动：平滑滚动的中间状态会把贴底判定又打回去。
    el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    atBottomRef.current = true;
  }

  /** 打字机播放每个周期长高：贴底时持续跟随（消息数组不变，下面的效果指望不上）。 */
  function handleReveal() {
    if (!atBottomRef.current) {
      return;
    }
    const el = scrollRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }
  // 输入框自动长高：随内容增高，CSS 的 max-h-40 封顶后内部滚动。做成对
  // draft 的 effect：草稿被程序性清空/恢复（切会话、被强制下线后回填）时高度也同步。
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
    const message = chatMessages[index];
    if (message !== undefined && message.role === 'user') {
      lastUserMessageId = message.id;
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

  // 欢迎语气泡只在「还没有任何消息」的会话视图出现：!active 是新对话初始视图，
  // messagesKnown 且为空是新建后确认无历史的空会话。历史加载中（messagesKnown
  // 为假）不显示，免得加载完成时被旧消息替换掉、闪现一下。
  const showWelcome = !active || (active.messagesKnown && active.messages.length === 0);
  const welcomeClass = bubbleClass('assistant', false);

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
                          retryBusy={pending}
                          onRetry={onRetry}
                          onAnimationEnd={() => onAnimationEnd(message.id)}
                          copyLabel={text.copy}
                          copiedLabel={text.copied}
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
                      <BubbleBoundary
                        key={`${message.id}:${message.waiting === true ? 'waiting' : 'final'}`}
                        fallbackText={textShown}
                      >
                        <div
                          lang={message.locale ? htmlLang[message.locale] : undefined}
                          className={classes.bubble}
                          onAnimationEnd={() => onAnimationEnd(message.id)}
                        >
                          <TypewriterText
                            id={message.id}
                            text={textShown}
                            present={presentIds.has(message.id)}
                            onEnd={onPresentEnd}
                            onReveal={handleReveal}
                            copyLabel={text.copy}
                            copiedLabel={text.copied}
                          />
                        </div>
                      </BubbleBoundary>
                      <MessageActions
                        message={message}
                        failedText={text.replyInterrupted}
                        stoppedText={text.replyStopped}
                        retryLabel={text.retry}
                        entering={entering}
                        retryBusy={pending}
                        onRetry={onRetry}
                        onAnimationEnd={() => onAnimationEnd(message.id)}
                        copyLabel={text.copy}
                        copiedLabel={text.copied}
                        canFeedback={!pending}
                        likeLabel={text.like}
                        dislikeLabel={text.dislike}
                        onFeedback={onFeedback}
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
                      copyLabel={text.copy}
                      copiedLabel={text.copied}
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
          {/* 欢迎语是合成气泡：只存在于无任何消息的会话视图（新会话开始），
              首条消息一出现就退场，有历史的旧会话不追溯。不进消息表、不进请求
              上下文、不带操作行（2026-11-06 决定）；文案固定繁中，出处见
              welcome-text.ts。纯文本无 markdown 解析风险，不套 BubbleBoundary；
              也不是真消息，不登记 enteringIds 进场动画。 */}
          {showWelcome ? (
            <div className={welcomeClass.wrap}>
              <p lang={htmlLang['zh-TW']} className={welcomeClass.bubble}>
                {WELCOME_TEXT}
              </p>
            </div>
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
      {/* 警示横幅：聊天滚动区与输入区之间的流内兄弟节点。分隔线固定在输入区上方，
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
              action={warning.action}
            />
          ))}
        </div>
      ) : null}
      {/* 底部输入条：padding-bottom 取 max(1rem, 安全区)——iPhone 刘海屏/
          横屏下发送按钮不再贴进圆角（N10；env() 生效前提是 index.html 的
          viewport meta 带 viewport-fit=cover）。 */}
      <div className="border-t border-stone-300 px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
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
                if (pending) {
                  // pending 期间 Enter 不发送：弹和禁用发送按钮同一句轻提示。
                  // 选「给提示」而不是静默：框里正打着字，静默会像键盘失灵。
                  onWaitHint();
                  return;
                }
                formRef.current?.requestSubmit();
              }
            }}
          />
          {pending ? (
            draft.trim() === '' ? (
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
              // pending 且输入框有字：停止按钮换成禁用的发送按钮（维护者决定的行为）；
              // 清空输入（全选删除）停止按钮就回来。disabled 按钮不响应鼠标
              // 事件——悬停浮层（daisyUI tooltip）和点按提示都放在外壳 span 上，
              // 按钮加 pointer-events-none 让 hover/点按可靠地落到外壳。
              <span
                className="tooltip tooltip-top shrink-0"
                data-tip={text.waitForReply}
                onClick={() => {
                  // 触屏没有悬停，浮层出不来：点按外壳用轻提示给同一句话。
                  // 有悬停能力的设备已经有 tooltip，不再重复弹。
                  if (window.matchMedia('(hover: none)').matches) {
                    onWaitHint();
                  }
                }}
              >
                <button
                  type="submit"
                  className="btn btn-square btn-sm pointer-events-none"
                  aria-label={text.send}
                  disabled
                >
                  <Send aria-hidden="true" />
                </button>
              </span>
            )
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
