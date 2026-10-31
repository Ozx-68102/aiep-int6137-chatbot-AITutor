import type {Locale} from './locale.ts';

export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'error';
  text: string;
  locale?: Locale;
  waiting?: boolean;
  /** 这一轮的编号。同一轮的提问和回答共用一个。 */
  turnId?: string;
};

export type Session = {
  id: string;
  title: string | null;
  pinned: boolean;
  pinnedAt: string | null;
  messages: Message[];
  messagesKnown: boolean;
};
