import type {Locale} from './locale.ts';

export type Message = {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  locale: Locale;
};

export type Session = {
  id: string;
  title: string | null;
  titleLocale: Locale | null;
  messages: Message[];
};
