import type {Message} from '../../type/chat.ts';

export function bubbleClass(role: Message['role'], entering: boolean): string {
  if (role === 'user') {
    return entering
      ? 'mb-3 ml-auto w-fit max-w-[600px] animate-in rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap break-words text-white fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 ml-auto w-fit max-w-[600px] rounded-xl bg-emerald-900 px-3.5 py-2.5 whitespace-pre-wrap break-words text-white';
  }
  if (role === 'error') {
    return entering
      ? 'mb-3 w-fit max-w-[600px] animate-in rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap break-words text-red-600 fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 w-fit max-w-[600px] rounded-xl border border-stone-300 bg-stone-50 px-3.5 py-2.5 whitespace-pre-wrap break-words text-red-600';
  }
  if (role === 'notice') {
    return entering
      ? 'mb-3 w-fit animate-in rounded-lg bg-stone-100 px-3 py-1 text-xs text-stone-600 fade-in slide-in-from-bottom-2 duration-200'
      : 'mb-3 w-fit rounded-lg bg-stone-100 px-3 py-1 text-xs text-stone-600';
  }
  return entering
    ? 'mb-3 w-fit max-w-[600px] animate-in rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap break-words fade-in slide-in-from-bottom-2 duration-200'
    : 'mb-3 w-fit max-w-[600px] animate-in rounded-xl bg-stone-100 px-3.5 py-2.5 whitespace-pre-wrap break-words fade-in duration-300 motion-reduce:animate-none';
}
