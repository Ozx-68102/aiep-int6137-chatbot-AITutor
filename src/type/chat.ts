import type {Locale} from './locale.ts';

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  locale?: Locale;
};

export type Session = {
  id: string;
  title: string | null;
  pinned: boolean;
  pinnedAt: string | null;
  messages: Message[];
  messagesKnown: boolean;
};
