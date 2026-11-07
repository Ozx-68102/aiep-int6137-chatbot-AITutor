import type {Locale} from '../type/locale.ts';

/** 管理员控制台词条：账号列表、角色、重置密码、改自己的密码。 */
const zhCN = {
  adminConsole: '管理员控制台',
  role: '角色',
  roleChat: '学生',
  roleAdmin: '管理员',
  noAccounts: '暂无账号',
  refreshAccounts: '刷新账号列表',
  resetPassword: '重置密码',
  resetConfirm: '重置后这个账号所有设备都会被强制下线，要用新密码重新登录。',
  passwordShownOnce: '密码只显示这一次，先抄下来。',
  changeMyPassword: '修改我的密码',
  changeMyPasswordWarning: '修改成功后，所有设备都会退出登录，需要用新密码重新登录。',
  passwordHintAdmin: '只能用英文键盘上的字符，不能有空格，长度 8–128，不能包含用户名',
};

export type AdminCopy = typeof zhCN;

const zhTW: AdminCopy = {
  adminConsole: '管理員控制台',
  role: '角色',
  roleChat: '學生',
  roleAdmin: '管理員',
  noAccounts: '暫無帳號',
  refreshAccounts: '重新整理帳號列表',
  resetPassword: '重設密碼',
  resetConfirm: '重設後這個帳號所有裝置都會被登出，要用新密碼重新登入。',
  passwordShownOnce: '密碼只顯示這一次，請先抄下來。',
  changeMyPassword: '修改我的密碼',
  changeMyPasswordWarning: '修改成功後，所有裝置都會登出，需要用新密碼重新登入。',
  passwordHintAdmin: '只能用英文鍵盤上的字元，不能有空格，長度 8–128，不能包含使用者名稱',
};

const en: AdminCopy = {
  adminConsole: 'Admin console',
  role: 'Role',
  roleChat: 'Student',
  roleAdmin: 'Admin',
  noAccounts: 'No accounts yet',
  refreshAccounts: 'Refresh account list',
  resetPassword: 'Reset password',
  resetConfirm:
    'Every device signed in to this account will be signed out and will need the new password to log in again.',
  passwordShownOnce: 'This password is shown only once — write it down now.',
  changeMyPassword: 'Change my password',
  changeMyPasswordWarning:
    'After the change, every device will be signed out and will need the new password to log in again.',
  passwordHintAdmin:
    'English keyboard characters only, no spaces, 8–128 characters, cannot contain your username',
};

export const admin: Record<Locale, AdminCopy> = {'zh-CN': zhCN, 'zh-TW': zhTW, en};
