import {useEffect, useRef} from 'react';
import {useLocation, useNavigate} from 'react-router';
import {readDraft} from '../session/drafts.ts';
import {chatIdFromPath, FORCE_CHANGE_PWD, SELF_CHANGE_PWD} from '../session/paths.ts';
import {rememberChatReturn} from '../session/password-return.ts';
import type {Session} from '../type/chat.ts';

/** 拆分前的旧自助改密地址：只认作别名，路径归位效果把它换成 /change-pwd。 */
const LEGACY_PASSWORD_PWD = '/password';

/**
 * 认领路径的三种来由，行为各不相同：
 * - login：刚登录成功。密码地址和 /login 都没有停留的意义，归位根路径。
 * - restore：刷新页面或直接打开深链，恢复登录态。自助改密页留在原页。
 * - recovery：服务从「连不上」恢复后补齐工作区。这不是一次新的登录，
 *   除会话地址外什么都不动——尤其是别把正在改密的用户强制送回首页。
 */
export type ClaimMode = 'login' | 'restore' | 'recovery';

type PathRoutingDeps = {
  auth: 'checking' | 'anonymous' | 'ready';
  sessions: Session[];
  activeId: string | null;
  showSession: (id: string) => void;
  showNewChat: () => void;
  setView: (view: 'chat' | 'profile') => void;
  setComposingNew: (value: boolean) => void;
  setActiveId: (id: string | null) => void;
  /** 认领路径后把对应会话自己的草稿放回输入框（草稿按会话存，刷新不丢）。 */
  setDraft: (value: string) => void;
};

/**
 * 真实路径路由的整个 URL 层：路径归位、路径驱动的会话切换、登录后的
 * 状态认领（claimPath），以及自助改密页的进入方式记录（passwordEntry）。
 *
 * 依赖按值传入、在效果里镜像进 ref：本 hook 的效果比主控制器的 ref 同步
 * 效果先跑，读主控制器的 ref 会拿到上一帧；读自己的 depsRef 永远是本帧。
 */
export function usePathRouting(deps: PathRoutingDeps) {
  const location = useLocation();
  const navigate = useNavigate();
  // 自助改密页是怎么进来的：'push' = 从设置里点进来（压入过一条历史记录，取消等于浏览器后退）；
  // 'direct' = 刷新、粘贴地址或前进后退直接打开（没有可退的，取消就地替换路径）；
  // null = 当前不在自助改密页。强制改密页（/force-change-pwd）不走这套记录——
  // 闸门的出口只有「改完」和「放弃」两条，都由 use-auth-flow 收尾。
  const passwordEntry = useRef<'push' | 'direct' | null>(null);
  // 上一次渲染时的路径：路径同步效果靠它判断「刚离开改密页」。
  const prevPathRef = useRef('');
  const depsRef = useRef(deps);
  const locationRef = useRef(location);
  const navigateRef = useRef(navigate);
  useEffect(() => {
    depsRef.current = deps;
    locationRef.current = location;
    navigateRef.current = navigate;
  });

  // 路径归位：只认 /、/login、两个改密地址、/chat/:id。不带 id 的 /chat、
  // 未知路径一律送回根路径；旧 /password 只认作别名，就地换成 /change-pwd。
  useEffect(() => {
    const pathname = location.pathname;
    if (pathname === LEGACY_PASSWORD_PWD) {
      void navigate(SELF_CHANGE_PWD, {replace: true});
      return;
    }
    if (
      pathname === '/' ||
      pathname === '/login' ||
      pathname === SELF_CHANGE_PWD ||
      pathname === FORCE_CHANGE_PWD
    ) {
      return;
    }
    if (chatIdFromPath(pathname) === null) {
      void navigate('/', {replace: true});
    }
  }, [location.pathname, navigate]);

  // 路径驱动聊天状态：前进后退或代码导航在 / 与 /chat/:id 之间切换时，
  // 把对应的会话带到台前。取代原来手写的历史监听。
  useEffect(() => {
    const pathname = location.pathname;
    const current = depsRef.current;
    if (current.auth !== 'ready') {
      prevPathRef.current = pathname;
      return;
    }
    if (pathname === SELF_CHANGE_PWD) {
      if (passwordEntry.current === null) {
        // 浏览器前进后退回到自助改密页：历史里这一条本来就是压入的。
        passwordEntry.current = 'push';
      }
      prevPathRef.current = pathname;
      return;
    }
    if (pathname === FORCE_CHANGE_PWD) {
      // 强制改密页不动聊天状态（拦截期间聊天主体不渲染）。
      prevPathRef.current = pathname;
      return;
    }
    passwordEntry.current = null;
    const leavingPassword =
      prevPathRef.current === SELF_CHANGE_PWD || prevPathRef.current === FORCE_CHANGE_PWD;
    prevPathRef.current = pathname;
    if (leavingPassword) {
      current.setView('chat');
    }
    if (pathname === '/login') {
      // 已登录还站在 /login：送回根路径是 claimPath 的事，这里不动聊天状态。
      return;
    }
    const wanted = chatIdFromPath(pathname);
    if (wanted === null) {
      if (pathname === '/') {
        current.showNewChat();
      }
      return;
    }
    const found = current.sessions.find((session) => session.id === wanted);
    if (found === undefined) {
      // 地址里的会话不存在（被删了，或换账号重新登录）：回根路径重新来过。
      current.showNewChat();
      void navigate('/', {replace: true});
      return;
    }
    if (leavingPassword && wanted === current.activeId) {
      // 从改密页退回来、会话没变：只切视图，不走 showSession/showNewChat，
      // 输入框里没发出去的字原样留着。
      return;
    }
    if (wanted !== current.activeId) {
      current.showSession(found.id);
    }
  }, [location.pathname, navigate]);

  /**
   * 登录或引导完成后按当前路径认领状态：打开哪个会话、回根路径。
   * 改密地址一概不认领——旧版 claimPath 会认领 /password，「登录后停在
   * 密码页」正是改完密又被弹回改密页死循环的根。登录来自密码地址时一律
   * 归位根路径；restore（刷新/深链恢复登录态）时只有自助改密页留在原页
   * （改到一半刷新，应该能接着改）；强制页照旧归位——标记为真时渲染走
   * 闸门分支，路径守卫马上把地址拉回 /force-change-pwd（拦截分支只看
   * 标记不看地址，渲染不闪）。
   */
  function claimPath(list: Session[], mode: ClaimMode = 'login'): void {
    const {pathname} = locationRef.current;
    const current = depsRef.current;
    if (pathname === SELF_CHANGE_PWD) {
      if (mode === 'restore') {
        // 在自助改密页上刷新：留在本页接着改。这种进入方式历史里没有
        // 我们压入的那一条，取消走就地替换的路。
        passwordEntry.current = 'direct';
        return;
      }
      if (mode === 'recovery') {
        // 服务刚回来：用户正在改密，别把他从这一页强制送走，也别动进入方式
        //（从设置里点进来的，取消仍该是后退）。
        return;
      }
    }
    if (mode === 'recovery') {
      // 网络恢复不是一次新登录：除会话地址外，任何页面都保持原样。
      // 地址与聊天状态的同步由路径驱动效果负责，这里不去改地址栏。
      if (chatIdFromPath(pathname) === null) {
        return;
      }
    } else if (
      pathname === LEGACY_PASSWORD_PWD ||
      pathname === SELF_CHANGE_PWD ||
      pathname === FORCE_CHANGE_PWD ||
      pathname === '/login'
    ) {
      // 已经登录了，密码地址和规范登录入口都没有停留的意义：回根路径，
      // 聊天状态交给路径同步效果处理。
      void navigateRef.current('/', {replace: true});
      return;
    }
    const wanted = chatIdFromPath(pathname);
    if (wanted === null) {
      if (mode === 'recovery') {
        return;
      }
      current.setComposingNew(true);
      current.setActiveId(null);
      current.setDraft(readDraft(null));
      return;
    }
    const found = list.find((session) => session.id === wanted);
    if (found === undefined) {
      void navigateRef.current('/', {replace: true});
      current.setComposingNew(true);
      current.setActiveId(null);
      current.setDraft(readDraft(null));
      return;
    }
    current.setComposingNew(false);
    current.setActiveId(found.id);
    current.setDraft(readDraft(found.id));
  }

  /**
   * 从设置里进自助改密页：压入一条历史记录（取消等于浏览器后退），并记下
   * 来路——改密成功后回到这里就地重新登录（契约见 session/password-return.ts）。
   */
  function markPasswordPushed() {
    passwordEntry.current = 'push';
    rememberChatReturn(locationRef.current.pathname);
  }

  /** 自助改密页是不是压入过历史记录进来的：决定取消走后退还是就地替换。 */
  function isPasswordPushed(): boolean {
    return passwordEntry.current === 'push';
  }

  /** 退出登录/被强制退回登录页：清掉改密页的进入方式记录（来路的清零在 enterLogin）。 */
  function resetPasswordEntry() {
    passwordEntry.current = null;
  }

  return {claimPath, markPasswordPushed, isPasswordPushed, resetPasswordEntry};
}
