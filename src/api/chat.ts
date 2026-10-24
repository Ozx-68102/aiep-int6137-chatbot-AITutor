import type { Locale } from '../i18n.ts'

const replies: Record<Locale, string> = {
  'zh-CN': '这是本地示例回复。接到 FastGPT 之后，这里会显示正式回答。',
  'zh-TW': '這是本地示例回覆。接到 FastGPT 之後，這裡會顯示正式回答。',
  en: 'This is a sample reply stored in the app. A real answer will appear here after FastGPT is connected.',
}

export function sendMessage(text: string, locale: Locale): string {
  const trimmed = text.trim()
  if (!trimmed) {
    throw new Error('消息不能为空')
  }
  return replies[locale]
}
