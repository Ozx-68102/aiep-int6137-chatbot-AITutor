import {useRef} from 'react';
import {translations} from '../../i18n.ts';
import type {Locale} from '../../type/locale.ts';
import {AvatarImage} from '../avatar/AvatarImage.tsx';

export function AvatarPicker({
  locale,
  avatarUrl,
  busy,
  custom,
  onPick,
  onRemove,
}: {
  locale: Locale;
  avatarUrl: string | null;
  busy: boolean;
  custom: boolean;
  onPick: (file: File) => void;
  onRemove: () => void;
}) {
  const text = translations[locale];
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-center gap-4 border-b border-stone-300 py-4">
      <AvatarImage
        src={avatarUrl}
        alt={text.avatar}
        className="size-20 shrink-0 rounded-full border border-stone-300 bg-stone-100 object-cover"
      />
      <div className="flex flex-col items-start gap-2">
        <p className="m-0 text-sm text-stone-600">{text.avatarHint}</p>
        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              // 选同一个文件也要能再触发一次。
              event.target.value = '';
              if (file) {
                onPick(file);
              }
            }}
          />
          <button
            type="button"
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            {busy ? text.avatarSaving : custom ? text.changeAvatar : text.uploadAvatar}
          </button>
          {custom ? (
            <button
              type="button"
              className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm text-red-600 transition-colors duration-150 ease-out enabled:hover:bg-red-600/10 enabled:active:bg-red-600/20 disabled:opacity-50"
              disabled={busy}
              onClick={onRemove}
            >
              {text.removeAvatar}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
