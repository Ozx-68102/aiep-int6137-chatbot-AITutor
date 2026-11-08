import {matchPath} from 'react-router';

/**
 * 改密相关地址的常量与 /chat/:id 解析（2026-11 拆分，维护者决定）：
 * 强制改密（重置密码后的闸门）与自助改密是两条独立路径，各自单一职责。
 * 前端各处（App 的渲染分支、use-auth-flow 的路径守卫、use-path-routing
 * 的归位与认领）都从这里取值，不再散落字面量。
 */

/** 强制改密（闸门）专用地址：登录标记为真时路径守卫把地址按在这里。 */
export const FORCE_CHANGE_PWD = '/force-change-pwd';

/** 自助改密页：设置里点「修改密码」进来改自己的密码。 */
export const SELF_CHANGE_PWD = '/change-pwd';

/** /chat/:id 里的会话 id；其它路径（包括不带 id 的 /chat）返回 null。 */
export function chatIdFromPath(pathname: string): string | null {
  const matched = matchPath('/chat/:id', pathname);
  return matched?.params.id ?? null;
}
