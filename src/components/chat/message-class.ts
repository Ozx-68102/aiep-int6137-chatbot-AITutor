import type {Message} from '../../type/chat.ts';

export function bubbleClass(role: Message['role'], entering: boolean): string {
  if (role === 'user') {
    return entering
      ? 'mb-3 ml-auto max-w-xl animate-in rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 ml-auto max-w-xl rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap text-white';
  }
  if (role === 'error') {
    return entering
      ? 'mb-3 max-w-xl animate-in rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap text-red-600 fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 max-w-xl rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap text-red-600';
  }
  return entering
    ? 'mb-3 max-w-xl animate-in rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap fade-in slide-in-from-bottom-2 duration-200'
    : 'mb-3 max-w-xl rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap';
}
