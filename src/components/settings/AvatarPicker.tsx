import {useRef} from 'react';
import {translations} from '../../i18n/index.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {AvatarImage} from '../avatar/AvatarImage.tsx';

export function AvatarPicker({
  locale,
  username,
  avatarUrl,
  busy,
  custom,
  onPick,
}: {
  locale: Locale;
  username: string | null;
  avatarUrl: string | null;
  busy: boolean;
  custom: boolean;
  onPick: (file: File) => void;
}) {
  const text = translations[locale];
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <div className="flex items-start gap-4 border-b border-base-300 py-4">
      <AvatarImage
        src={avatarUrl}
        alt={text.avatar}
        className="size-20 shrink-0 rounded-full border border-base-300 bg-base-200 object-cover"
      />
      <div className="flex min-w-0 flex-col items-start">
        {username ? (
          <p className="m-0 truncate text-lg" lang={htmlLang[locale]}>
            {username}
          </p>
        ) : null}
        <p className="m-0 mt-4 text-xs text-stone-500">{text.avatarHint}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/heic,image/heif"
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
            className="btn btn-sm btn-outline"
            disabled={busy}
            onClick={() => {
              inputRef.current?.click();
            }}
          >
            {busy ? text.avatarSaving : custom ? text.changeAvatar : text.uploadAvatar}
          </button>
        </div>
      </div>
    </div>
  );
}
