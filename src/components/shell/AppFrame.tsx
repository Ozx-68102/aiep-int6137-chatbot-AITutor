import type {Dispatch, SetStateAction, SubmitEvent} from 'react';
import type {NavigateFunction} from 'react-router';
import {connectionFailure, explain, type LoginOutcome} from '../../api/failure.ts';
import {sendFeedback} from '../../api/feedback.ts';
import {ApiError} from '../../api/http.ts';
import {defaultAvatarUrl} from '../../api/profile.ts';
import type {SessionInvalid} from '../../hooks/use-auth-flow.ts';
import type {usePasswordChange} from '../../hooks/use-password-change.ts';
import type {usePathRouting} from '../../hooks/use-path-routing.ts';
import type {useProfileActions} from '../../hooks/use-profile-actions.ts';
import type {useServiceStatus} from '../../hooks/use-service-status.ts';
import type {useSessionActions} from '../../hooks/use-session-actions.ts';
import type {useTurnEngine} from '../../hooks/use-turn-engine.ts';
import type {Messages} from '../../i18n/index.ts';
import {SELF_CHANGE_PWD} from '../../session/paths.ts';
import type {Session} from '../../type/chat.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {ChatMain} from '../chat/ChatMain.tsx';
import type {WarningItem} from '../chat/WarningBox.tsx';
import {ConfirmLogout} from '../settings/ConfirmLogout.tsx';
import {SettingsModal} from '../settings/SettingsModal.tsx';
import {Sidebar} from '../sidebar/Sidebar.tsx';
import {Toast, type ToastItem} from '../toast/Toast.tsx';
import {chatFrameClass} from './frame-class.ts';
import {ReloginModal} from './ReloginModal.tsx';

type AppFrameProps = {
  narrow: boolean;
  sidebarOpen: boolean;
  locale: Locale;
  text: Messages;
  sessions: Session[];
  activeId: string | null;
  active: Session | undefined;
  view: 'chat' | 'profile';
  username: string | null;
  avatarUrl: string | null;
  warnings: WarningItem[];
  enteringIds: Set<string>;
  setEnteringIds: Dispatch<SetStateAction<Set<string>>>;
  activePending: boolean;
  progressText: string | undefined;
  draft: string;
  inputLocked: boolean;
  sendLocked: boolean;
  confirmLogout: boolean;
  setConfirmLogout: Dispatch<SetStateAction<boolean>>;
  setView: Dispatch<SetStateAction<'chat' | 'profile'>>;
  setNotice: Dispatch<SetStateAction<string | null>>;
  loggingOut: boolean;
  toast: ToastItem | null;
  setToast: Dispatch<SetStateAction<ToastItem | null>>;
  sessionInvalid: SessionInvalid | null;
  reloginOpen: boolean;
  setReloginOpen: Dispatch<SetStateAction<boolean>>;
  setLoginDetail: Dispatch<SetStateAction<string | null>>;
  setLoginOffline: Dispatch<SetStateAction<boolean>>;
  loginError: string | null;
  loginSubmitting: boolean;
  setLocale: Dispatch<SetStateAction<Locale>>;
  addSession: () => void;
  closeSidebar: () => void;
  openSidebar: () => void;
  openSession: (id: string) => void;
  showToast: (message: string) => void;
  handleDraft: (value: string) => void;
  submitMessage: (event: SubmitEvent<HTMLFormElement>) => void;
  submitLogin: (
    usernameValue: string,
    passwordValue: string,
    turnstileToken: string,
  ) => Promise<LoginOutcome>;
  signOut: () => Promise<void>;
  handleAuthError: (error: ApiError) => void;
  navigate: NavigateFunction;
  engine: ReturnType<typeof useTurnEngine>;
  sessionActions: ReturnType<typeof useSessionActions>;
  profileApi: ReturnType<typeof useProfileActions>;
  password: ReturnType<typeof usePasswordChange>;
  routing: ReturnType<typeof usePathRouting>;
  service: ReturnType<typeof useServiceStatus>;
};

/**
 * 已登录聊天页的整个框架：侧栏、聊天主体、设置弹窗、退出确认、就地重新
 * 登录弹窗和 Toast。状态和回调全部由 ChatApp 传入，这个组件只管渲染，
 * 自己不持有任何状态。
 */
export function AppFrame({
  narrow,
  sidebarOpen,
  locale,
  text,
  sessions,
  activeId,
  active,
  view,
  username,
  avatarUrl,
  warnings,
  enteringIds,
  setEnteringIds,
  activePending,
  progressText,
  draft,
  inputLocked,
  sendLocked,
  confirmLogout,
  setConfirmLogout,
  setView,
  setNotice,
  loggingOut,
  toast,
  setToast,
  sessionInvalid,
  reloginOpen,
  setReloginOpen,
  setLoginDetail,
  setLoginOffline,
  loginError,
  loginSubmitting,
  setLocale,
  addSession,
  closeSidebar,
  openSidebar,
  openSession,
  showToast,
  handleDraft,
  submitMessage,
  submitLogin,
  signOut,
  handleAuthError,
  navigate,
  engine,
  sessionActions,
  profileApi,
  password,
  routing,
  service,
}: AppFrameProps) {
  return (
    <div className={chatFrameClass(narrow, sidebarOpen)}>
      <Sidebar
        locale={locale}
        narrow={narrow}
        open={sidebarOpen}
        sessions={sessions}
        activeId={activeId}
        settingsOpen={view === 'profile'}
        username={username}
        avatarUrl={avatarUrl}
        onCreate={addSession}
        onClose={() => {
          closeSidebar();
        }}
        onOpenSession={openSession}
        onRename={(id, title) => sessionActions.renameOpenSession(id, title)}
        onDelete={(id) => sessionActions.removeSession(id)}
        onPin={(id, pinned) => {
          void sessionActions.pinOpenSession(id, pinned);
        }}
        onOpenSettings={() => {
          setConfirmLogout(false);
          profileApi.setProfileError(null);
          setView('profile');
        }}
      />
      <ChatMain
        key={active?.id ?? 'new'}
        locale={locale}
        sidebarOpen={sidebarOpen}
        onShowSidebar={() => {
          openSidebar();
        }}
        active={active}
        warnings={warnings}
        enteringIds={enteringIds}
        onAnimationEnd={(id) => {
          setEnteringIds((current) => {
            if (!current.has(id)) {
              return current;
            }
            const next = new Set(current);
            next.delete(id);
            return next;
          });
        }}
        pending={activePending}
        presentIds={engine.presentIds}
        onPresentEnd={engine.endPresent}
        progressText={progressText}
        draft={draft}
        inputLocked={inputLocked}
        sendLocked={sendLocked}
        onWaitHint={() => {
          showToast(text.waitForReply);
        }}
        onDraft={handleDraft}
        onSubmit={submitMessage}
        onStop={() => {
          if (active) {
            void engine.stopSending(active.id);
          }
        }}
        onRetry={(turnId) => {
          if (active) {
            void engine.retryTurn(active.id, turnId);
          }
        }}
        onEditResend={(turnId, text) => {
          if (active) {
            void engine.retryTurn(active.id, turnId, text);
          }
        }}
        onFeedback={async (turnId, feedback) => {
          if (!active) {
            return false;
          }
          try {
            await sendFeedback(active.id, turnId, feedback);
            return true;
          } catch (error) {
            if (error instanceof ApiError && error.status === 401) {
              // 点赞途中被强制下线：跟其他动作一样走统一的 401 入口。
              handleAuthError(error);
              return false;
            }
            if (connectionFailure(error)) {
              service.showConnectionWarning();
              return false;
            }
            // 后端拒绝（404 轮次不存在、502 上游没收到）或别的错：进输入区
            // 上方的警示横幅；简中显示后端 detail 原文，英文/繁中优先按状态码
            // 映射；按钮状态由 MessageActions 回退。
            setNotice(explain(error, locale, text.actionFailed));
            return false;
          }
        }}
      />
      <SettingsModal
        locale={locale}
        open={view === 'profile'}
        username={username}
        avatarUrl={avatarUrl}
        avatarBusy={profileApi.savingAvatar}
        hasCustomAvatar={avatarUrl !== null && !avatarUrl.startsWith(defaultAvatarUrl)}
        error={confirmLogout ? null : profileApi.profileError}
        saving={profileApi.savingLocale}
        onLocale={(next) => {
          void profileApi.changeLocale(next);
        }}
        onAvatarPick={(file) => {
          void profileApi.pickAvatar(file);
        }}
        onChangePassword={() => {
          password.setError(null);
          // 真页面：地址变成 /change-pwd，压入一条历史记录，浏览器后退就能回来。
          // markPasswordPushed 一并记下来路——改密成功后回到这里就地重新登录。
          routing.markPasswordPushed();
          void navigate(SELF_CHANGE_PWD);
        }}
        onLogout={() => setConfirmLogout(true)}
        onClose={() => {
          setConfirmLogout(false);
          profileApi.setProfileError(null);
          setView('chat');
        }}
      />
      <ConfirmLogout
        locale={locale}
        open={confirmLogout}
        error={profileApi.profileError}
        loggingOut={loggingOut}
        onCancel={() => {
          profileApi.setProfileError(null);
          setConfirmLogout(false);
        }}
        onConfirm={() => {
          void signOut();
        }}
      />
      {/* 会话过期后的就地重新登录：Modal 里放 LoginScreen 同款卡片，不清聊天页的
          任何状态；登录失败弹窗不关，错误留在表单里；成功由 openAccount 就地
          恢复（刷新 profile 和会话列表）。disabled 不提供（终态，登录也没用）。 */}
      <ReloginModal
        open={sessionInvalid !== null && sessionInvalid.reason !== 'disabled' && reloginOpen}
        locale={locale}
        error={loginError}
        submitting={loginSubmitting}
        onLocale={setLocale}
        onSubmit={submitLogin}
        onClose={() => {
          setReloginOpen(false);
          setLoginDetail(null);
          setLoginOffline(false);
        }}
      />
      <Toast
        toast={toast}
        lang={htmlLang[locale]}
        onDismiss={() => {
          setToast(null);
        }}
      />
    </div>
  );
}
