export const locales = [
  { id: 'zh-CN', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
] as const

export type Locale = (typeof locales)[number]['id']

export const translations = {
  'zh-CN': {
    sessions: '会话',
    newChat: '新对话',
    hideSidebar: '收起会话列表',
    showSidebar: '展开会话列表',
    language: '语言',
    placeholder: '输入你的问题',
    send: '发送',
    empty: '还没有对话。在下方输入问题。',
  },
  'zh-TW': {
    sessions: '對話',
    newChat: '新對話',
    hideSidebar: '收起對話列表',
    showSidebar: '展開對話列表',
    language: '語言',
    placeholder: '輸入你的問題',
    send: '發送',
    empty: '還沒有對話。在下方輸入問題。',
  },
  en: {
    sessions: 'Chats',
    newChat: 'New chat',
    hideSidebar: 'Hide chat list',
    showSidebar: 'Show chat list',
    language: 'Language',
    placeholder: 'Type your question',
    send: 'Send',
    empty: 'No messages yet. Type a question below.',
  },
} satisfies Record<Locale, Record<string, string>>
