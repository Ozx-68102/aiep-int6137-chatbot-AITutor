import {useEffect, useRef} from 'react';
import {matchPath, useLocation, useNavigate} from 'react-router';
import {readDraft} from '../session/drafts.ts';
import type {Session} from '../type/chat.ts';

/** /chat/:id 里的会话 id；其它路径（包括不带 id 的 /chat）返回 null。 */
export function chatIdFromPath(pathname: string): string | null {
  const matched = matchPath('/chat/:id', pathname);
  return matched?.params.id ?? null;
}

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
 * 状态认领（claimPath），以及改密页的进入方式记录（passwordEntry）。
 *
 * 依赖按值传入、在效果里镜像进 ref：本 hook 的效果比主控的 ref 同步
 * 效果先跑，读主控的 ref 会拿到上一帧；读自己的 depsRef 永远是本帧。
 */
export function usePathRouting(deps: PathRoutingDeps) {
  const location = useLocation();
  const navigate = useNavigate();
  // 改密页是怎么进来的：'push' = 从设置里点进来（压过一条历史，取消等于浏览器后退）；
  // 'direct' = 刷新、贴地址或前进后退直接打开（没有可退的，取消就地替换路径）；
  // null = 当前不在改密页。
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

  // 路径归位：只认 /、/login、/password、/chat/:id 四类地址，不带 id 的
  // /chat 和未知路径一律送回根路径。
  useEffect(() => {
    const pathname = location.pathname;
    if (pathname === '/' || pathname === '/login' || pathname === '/password') {
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
    if (pathname === '/password') {
      if (passwordEntry.current === null) {
        // 浏览器前进后退回到改密页：历史里这一条本来就是压进去的。
        passwordEntry.current = 'push';
      }
      prevPathRef.current = pathname;
      return;
    }
    passwordEntry.current = null;
    const leavingPassword = prevPathRef.current === '/password';
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
      // 地址里的会话不存在（被删了，或换账号重登）：回根路径重新来过。
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

  /** 登录或引导完成后按当前路径认领状态：打开哪个会话、停在改密页还是回根路径。 */
  function claimPath(list: Session[]): void {
    const {pathname} = locationRef.current;
    const current = depsRef.current;
    if (pathname === '/password') {
      // 直接以 /password 打开、或在改密页上刷新：留在改密页。
      // 这种进入方式历史里没有我们压的那一条，取消走就地替换的路。
      passwordEntry.current = 'direct';
      return;
    }
    if (pathname === '/login') {
      // 已经登录了，规范登录入口没有存在的意义：回根路径，
      // 聊天状态交给路径同步效果收拾。
      void navigateRef.current('/', {replace: true});
      return;
    }
    const wanted = chatIdFromPath(pathname);
    if (wanted === null) {
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

  /** 从设置里进改密页：压了一条历史，取消等于浏览器后退。 */
  function markPasswordPushed() {
    passwordEntry.current = 'push';
  }

  /** 改密页是不是压过历史进来的：决定取消走后退还是就地替换。 */
  function isPasswordPushed(): boolean {
    return passwordEntry.current === 'push';
  }

  /** 退出登录/被踢回登录页：清掉改密页的进入方式记录。 */
  function resetPasswordEntry() {
    passwordEntry.current = null;
  }

  return {claimPath, markPasswordPushed, isPasswordPushed, resetPasswordEntry};
}
