import {chatIdFromPath} from './paths.ts';

/**
 * 改密的「来路」（「只记 /chat/:id」契约，2026-11 维护者决定）：改密成功后
 * 要回的地方。记的时机两处——路径守卫把人按进强制改密页之前（use-auth-flow
 * 的守卫效果）、从设置进自助改密页之前（use-path-routing 的
 * markPasswordPushed）；消费的时机两处——改密成功（finishPasswordChange 回
 * 这里就地渲染登录屏）和闸门的「放弃本次登录」（cancelGatedLogin）。回登录
 * 界面（enterLogin）就清零。
 *
 * 只认 /chat/:id：根路径本来就是默认落点（回 / 开新会话，claimPath 认领），
 * 密码相关的任何地址绝不能进这份记忆——否则「改完密回改密页」的死循环换个
 * 地址复活。只在拿到聊天地址时写：闸门期间用户拿浏览器后退乱撞，不该把真正
 * 的来路抹掉。进程内存即可：跨刷新本来就要重登，记不住也无妨。
 */
let chatReturn: string | null = null;

/** 记来路：是 /chat/:id 就记；别的不记也不清（已有记忆不降级）。 */
export function rememberChatReturn(pathname: string): void {
  const chatId = chatIdFromPath(pathname);
  if (chatId !== null) {
    chatReturn = `/chat/${chatId}`;
  }
}

/** 读来路：null 表示没记，收尾时回根路径开新会话。 */
export function readChatReturn(): string | null {
  return chatReturn;
}

/** 回登录界面时清零：改密收尾先读再清（enterLogin 里调用）。 */
export function clearChatReturn(): void {
  chatReturn = null;
}
