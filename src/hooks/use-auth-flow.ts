import {useEffect, useRef, useState} from 'react';
import {useLocation, useNavigate, type NavigateFunction} from 'react-router';
import {connectionFailure, explain} from '../api/failure.ts';
import {ApiError, mustChangePasswordEvent} from '../api/http.ts';
import {logout, readProfile} from '../api/profile.ts';
import {login, sessionsFromList} from '../api/session.ts';
import type {LoginResult} from '../api/session.ts';
import type {Messages} from '../i18n/index.ts';
import {clearAllDrafts} from '../session/drafts.ts';
import {
  clearCachedProfile,
  clearLogoutMarker,
  saveCachedProfile,
  writeLogoutMarker,
} from '../session/profile-cache.ts';
import {openPushChannel} from '../session/push-channel.ts';
import {clearUnsent, readUnsent, saveUnsent} from '../session/unsent.ts';
import type {Session} from '../type/chat.ts';
import {isLocale, type Locale} from '../type/locale.ts';
import type {usePasswordChange} from './use-password-change.ts';
import type {usePathRouting} from './use-path-routing.ts';
import type {useProfileActions} from './use-profile-actions.ts';
import type {useServiceStatus} from './use-service-status.ts';
import type {useSessionActions} from './use-session-actions.ts';
import type {useTurnEngine} from './use-turn-engine.ts';

/**
 * 「会话失效、留在原页面」状态的原因：401 的 reason 词表（expired/disabled）
 * 加上推送通道的失效原因（password_changed/admin_reset）；推送帧里不认识的
 * reason 词一律记成 unknown——也按失效处理，文案退回服务器推来的 message。
 */
export type SessionInvalidReason =
  | 'expired'
  | 'disabled'
  | 'password_changed'
  | 'admin_reset'
  | 'unknown';

/** 留在原页面的失效状态：原因 + 服务器推来的建议文案（只在 unknown 时用）。 */
export type SessionInvalid = {reason: SessionInvalidReason; message: string | null};

/** 推送帧的 reason 词 → 页面状态词；词表之外的词一律 unknown。 */
function toSessionInvalidReason(reason: string): SessionInvalidReason {
  if (
    reason === 'expired' ||
    reason === 'disabled' ||
    reason === 'password_changed' ||
    reason === 'admin_reset'
  ) {
    return reason;
  }
  return 'unknown';
}

type AuthFlowDeps = {
  locale: Locale;
  text: Messages;
  setLocale: (locale: Locale) => void;
  setUsername: (username: string | null) => void;
  setAvatarUrl: (url: string | null) => void;
  setSessions: (sessions: Session[]) => void;
  setActiveId: (id: string | null) => void;
  setDraft: (value: string) => void;
  setNotice: (notice: string | null) => void;
  setView: (view: 'chat' | 'profile') => void;
  setComposingNew: (value: boolean) => void;
  setConfirmLogout: (value: boolean) => void;
  navigateRef: {current: NavigateFunction};
  draftRef: {current: string};
  routingRef: {current: ReturnType<typeof usePathRouting> | null};
  serviceRef: {current: ReturnType<typeof useServiceStatus> | null};
  engineRef: {current: ReturnType<typeof useTurnEngine> | null};
  passwordRef: {current: ReturnType<typeof usePasswordChange> | null};
  profileApiRef: {current: ReturnType<typeof useProfileActions> | null};
  sessionActionsRef: {current: ReturnType<typeof useSessionActions> | null};
};

/**
 * 登录状态机：auth 三态、登录（submitLogin/openAccount）、退出（signOut）、
 * 会话类 401 的统一入口（handleAuthError/enterLoginGuarded/enterLogin）、
 * 留在原页面的过期状态、强制修改密码标记与它的全局事件监听、路径守卫，
 * 以及推送通道的建连/关连接。
 *
 * 其他 hook 的 API 一律走传入的 ref 读（这些 hook 在本 hook 之后才接线），
 * 事件回调触发时读到的都是最新的一份。
 */
export function useAuthFlow(deps: AuthFlowDeps) {
  const {
    locale,
    text,
    setLocale,
    setUsername,
    setAvatarUrl,
    setSessions,
    setActiveId,
    setDraft,
    setNotice,
    setView,
    setComposingNew,
    setConfirmLogout,
    navigateRef,
    draftRef,
    routingRef,
    serviceRef,
    engineRef,
    passwordRef,
    profileApiRef,
    sessionActionsRef,
  } = deps;
  const location = useLocation();
  const navigate = useNavigate();
  const [auth, setAuth] = useState<'checking' | 'anonymous' | 'ready'>('checking');
  const [loginOffline, setLoginOffline] = useState(false);
  const [loginDetail, setLoginDetail] = useState<string | null>(null);
  const [loginNotice, setLoginNotice] = useState<string | null>(null);
  const [loginSubmitting, setLoginSubmitting] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  // 留在原页面的过期状态（docs/ACCOUNT_MANAGEMENT.md 会话状态通道的最小 HTTP 版）：
  // auth 保持 ready，聊天页原样保留、输入区禁用、输入区上方挂常驻警示条。
  // expired 可以就地重新登录（Modal 里弹 LoginScreen）；disabled 是终态，只给提示。
  // 触发来源两个：带 reason 的 401（handleAuthError），以及推送通道的失效帧
  //（handlePushInvalid，原因多三种：密码已修改、被管理员重置、不认识的词）。
  const [sessionInvalid, setSessionInvalid] = useState<SessionInvalid | null>(null);
  const [reloginOpen, setReloginOpen] = useState(false);
  // 推送通道的世代编号：重新登录成功后加一，通道效果随之关掉旧连接、新建
  // 一条（旧连接在登录态失效后已经彻底死了，不复用）。
  const [pushEpoch, setPushEpoch] = useState(0);
  // 「必须修改密码」拦截：密码来自别人手的账号（预设密码、被控制台重置过
  // 密码）被服务器打了标记，本人改出一个新密码之前不放行其他功能。来源
  // 三个：登录响应、profile 响应，以及任何请求收到的 403（http.ts 的全局
  // 保底事件）。契约见 docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「必须改密标记」。
  const [mustChangePassword, setMustChangePassword] = useState(false);
  // sessionInvalid 的 ref 镜像：enterLoginGuarded 在异步回调里读，不捕获状态值。
  const sessionInvalidRef = useRef(sessionInvalid);
  // 多标签页的 storage 监听只注册一次，登出处理要读到最新的 enterLoginGuarded：
  // 走 ref，别让它成为效果依赖。初值给 null、由下面的镜像效果填上：在这里
  // 直接读后面才声明的函数会被 React Compiler 记成「初始化期间读取」。
  // 镜像在挂载后的第一帧就完成，storage 事件不可能比它更早到。
  const enterLoginGuardedRef = useRef<((detail: string | null) => void) | null>(null);
  // 推送失效的回调同样走 ref：通道效果只注册一次，回调要读到最新的一份
  //（和 enterLoginGuardedRef 同一做法，镜像效果在函数声明之后）。
  const handlePushInvalidRef = useRef<((reason: string, message: string | null) => void) | null>(
    null,
  );

  const loginError = loginOffline ? text.connectionError : loginDetail;

  // http.ts 的全局保底：任何请求收到 403 且响应体带 must_change_password
  // 标记，都会广播这个事件，页面在这里进入强制修改密码的拦截。事件是同步
  // 派发的：监听器在错误继续往上抛之前就会执行，各调用方不用各自处理。
  useEffect(() => {
    function onMustChangePassword() {
      setMustChangePassword(true);
    }
    window.addEventListener(mustChangePasswordEvent, onMustChangePassword);
    return () => {
      window.removeEventListener(mustChangePasswordEvent, onMustChangePassword);
    };
  }, []);

  // 推送通道 /api/events（docs/LOGIN_SESSIONS_AND_RATE_LIMITING.md「推送通道」）：
  // 登录态有效期间挂着一条连接，服务器主动推「你已被强制下线」（令牌过期、
  // 密码已修改、被管理员重置），不用等下一次请求收到 401。进入登录态
  //（auth 不是 ready）时效果清理、连接关闭；重新登录成功后 pushEpoch 加一，
  // 效果重跑、新建一条连接，不复用旧的。每标签页一条，同源自动带 cookie。
  useEffect(() => {
    if (auth !== 'ready') {
      return;
    }
    const channel = openPushChannel((reason, message) => {
      handlePushInvalidRef.current?.(reason, message);
    });
    return () => {
      channel.close();
    };
  }, [auth, pushEpoch]);

  // 拦截期间的路径守卫：用户手输别的地址、用浏览器前进后退离开，都送回
  // /password。渲染分支本身不看地址（拦截生效期间只渲染强制改密页），这里
  // 把地址栏也按住，两边一致。
  useEffect(() => {
    if (auth === 'ready' && mustChangePassword && location.pathname !== '/password') {
      void navigate('/password', {replace: true});
    }
  }, [auth, mustChangePassword, location.pathname, navigate]);

  useEffect(() => {
    sessionInvalidRef.current = sessionInvalid;
  });

  function enterLogin(detail: string | null) {
    // 被强制退回登录页时，正打到一半的字存起来，登录成功后放回输入框。
    // 主动退出不走这里存：signOut 成功之后会把这份缓存清掉。
    const typed = draftRef.current.trim();
    if (typed !== '') {
      saveUnsent(typed);
    }
    setAuth('anonymous');
    setSessions([]);
    setActiveId(null);
    setDraft('');
    setNotice(null);
    setUsername(null);
    clearCachedProfile();
    setView('chat');
    // 主动退出（登出、改密成功强制回来）地址去规范登录入口 /login：
    // 旧会话 id 不再留在地址栏、浏览器历史和复制出去的链接里，
    // 重新登录后也不会又弹回改密页。被 401 强制退回登录页时地址不动：登录界面
    // 就地渲染，重新登录后由路由自动认领回原会话。
    if (detail === null) {
      void navigateRef.current('/login', {replace: true});
    }
    routingRef.current?.resetPasswordEntry();
    setComposingNew(false);
    setConfirmLogout(false);
    setSessionInvalid(null);
    setReloginOpen(false);
    // 回登录界面就解除拦截：标记还在不在，由下一次登录响应说了算。
    setMustChangePassword(false);
    profileApiRef.current?.setProfileError(null);
    passwordRef.current?.setError(null);
    sessionActionsRef.current?.titleSaves.current.clear();
    engineRef.current?.resetForLogin();
    setLoginOffline(false);
    setLoginDetail(detail);
    setLoginSubmitting(false);
  }

  /**
   * 会话类 401 的统一入口（轮次引擎、半截回答轮询和 App 自己的请求都走
   * 这里）：带着 reason（expired/disabled）就进入「留在原页面的过期状态」——
   * 聊天页、会话列表、草稿、profile 缓存全部原样保留，只禁用输入区、挂
   * 常驻警示条；没有 reason（老后端）保守回退整页 enterLogin 路径。只在
   * auth 是 ready 时有意义：checking/anonymous 阶段的 401 照旧走整页登录屏。
   */
  function handleAuthError(error: ApiError) {
    if (error.reason === 'expired' || error.reason === 'disabled') {
      setSessionInvalid({reason: error.reason, message: null});
      return;
    }
    enterLogin(error.detail);
  }

  /**
   * 推送通道收到 valid:false：与收到带 reason 的 401 完全同一套行为——
   * 会话、消息、草稿原地保留，输入区禁用、挂常驻警示条。不认识的 reason
   * 词也按失效处理（文案退回帧里的 message）。
   */
  function handlePushInvalid(reason: string, message: string | null) {
    setSessionInvalid({reason: toSessionInvalidReason(reason), message});
  }

  /**
   * 其余动作（侧栏、设置、改密、服务状态恢复）的 401 出口还是 enterLogin：
   * 已经在留在原页面的过期状态里时不再升级成整页清空——横幅已经挂着了，清空
   * 反而把这个状态保住的东西弄丢。
   */
  function enterLoginGuarded(detail: string | null) {
    if (sessionInvalidRef.current !== null) {
      return;
    }
    enterLogin(detail);
  }

  // enterLoginGuarded 的 ref 镜像单独放在它的声明之后：React Compiler 不接受
  // 在函数声明之前把它捕获进任何闭包（会报「初始化期间读取」）。多标签页的
  // storage 监听只读这个 ref，不直接捕获函数。
  useEffect(() => {
    enterLoginGuardedRef.current = enterLoginGuarded;
  });

  // handlePushInvalid 的 ref 镜像单独放在它的声明之后：和 enterLoginGuardedRef
  // 同一个理由，React Compiler 不接受在函数声明之前把它捕获进闭包。
  useEffect(() => {
    handlePushInvalidRef.current = handlePushInvalid;
  });

  async function submitLogin(usernameValue: string, password: string, turnstileToken: string) {
    if (loginOffline) {
      return;
    }
    setLoginSubmitting(true);
    setLoginOffline(false);
    setLoginDetail(null);
    setLoginNotice(null);
    try {
      const result = await login(usernameValue, password, turnstileToken);
      await openAccount(result);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setLoginDetail(error.detail);
        return;
      }
      if (connectionFailure(error)) {
        setLoginOffline(true);
        serviceRef.current?.showConnectionWarning();
        return;
      }
      setLoginDetail(explain(error, locale, text.connectionError));
    } finally {
      setLoginSubmitting(false);
    }
  }

  async function openAccount(result: LoginResult) {
    // 登录回来了：清掉上一次登出留下的标记（事件只认写入瞬间，墓碑不留着）。
    clearLogoutMarker();
    if (isLocale(result.locale)) {
      setLocale(result.locale);
    }
    // 上一个登录态的进行中请求、轮询和「线程已加载」标记都作废：一次清掉。
    // 整页登录路径里 enterLogin 已经清过（幂等）；在原页面重新登录靠这次清理
    // 加 bumpThreadRetry 让当前会话的历史重新拉取——activeId 和 auth 都没变，
    // 线程加载效果只能靠 retry 计数重新触发。
    engineRef.current?.resetForLogin();
    engineRef.current?.bumpThreadRetry();
    setSessionInvalid(null);
    setReloginOpen(false);
    // 登录响应里的「必须修改密码」标记：为真就进入拦截（只渲染强制改密页），
    // 为假解除拦截、恢复正常。
    setMustChangePassword(result.must_change_password);
    // 重新登录成功后推送通道新建一条连接：auth 本来就是 ready 时（在原页面
    // 重新登录）靠这个编号让通道效果重跑；全新登录时 auth 的变化同样触发。
    setPushEpoch((current) => current + 1);
    let next = sessionsFromList(result.sessions);
    setSessions(next);
    routingRef.current?.claimPath(next);
    // 被强制下线时存下的那句话放回输入框；放回就消费掉，别带去再下一次登录。
    // 在原页面重新登录时输入框里的字本来就留着，没有存下的句子就不要动它。
    const unsent = readUnsent();
    if (unsent !== '') {
      setDraft(unsent);
      clearUnsent();
    }
    setNotice(null);
    setView('chat');
    setAuth('ready');
    void readProfile()
      .then((profile) => {
        setUsername(profile.username);
        setLocale(profile.locale);
        setAvatarUrl(profile.avatarUrl);
        saveCachedProfile({username: profile.username, locale: profile.locale});
        // 重新拉一份 profile 核对标记：改密成功时服务器在同一个事务里清掉
        // 它；万一这里还拿到 true，拦截重新生效。
        setMustChangePassword(profile.mustChangePassword);
      })
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 401) {
          handleAuthError(error);
        }
      });
  }

  async function signOut() {
    if (loggingOut) {
      return;
    }
    setLoggingOut(true);
    profileApiRef.current?.setProfileError(null);
    try {
      await logout();
      enterLogin(null);
      // 主动退出：enterLogin 刚存过草稿，这里清掉，别带去下一次登录。
      // （退出时 401 是被强制下线，走上面 catch 的路，不清。）
      clearUnsent();
      // 各会话的草稿也在主动退出时清空：共用电脑不留半截字（对齐
      // clearCachedProfile 的隐私处理）。被强制下线不清——重新登录后草稿原样恢复。
      clearAllDrafts();
      // 把主动登出广播给其他标签页（P7）：收到 storage 事件的标签页立即
      // 回登录界面，不等下一次 401。写入方收不到自己的 storage 事件。
      writeLogoutMarker();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        enterLogin(null);
        return;
      }
      if (connectionFailure(error)) {
        serviceRef.current?.showConnectionWarning();
        return;
      }
      profileApiRef.current?.setProfileError(explain(error, locale, text.connectionError));
    } finally {
      setLoggingOut(false);
    }
  }

  return {
    auth,
    setAuth,
    loginOffline,
    setLoginOffline,
    setLoginDetail,
    loginNotice,
    setLoginNotice,
    loginSubmitting,
    loginError,
    sessionInvalid,
    reloginOpen,
    setReloginOpen,
    mustChangePassword,
    setMustChangePassword,
    loggingOut,
    enterLoginGuardedRef,
    enterLoginGuarded,
    handleAuthError,
    submitLogin,
    signOut,
  };
}
