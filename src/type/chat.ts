import type {Locale} from './locale.ts';

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'error' | 'notice';
  text: string;
  locale?: Locale;
  waiting?: boolean;
};

export type Session = {
  id: string;
  title: string | null;
  pinned: boolean;
  pinnedAt: string | null;
  messages: Message[];
  messagesKnown: boolean;
};
