import {CircleAlert} from 'lucide-react';
import {useRef, useState} from 'react';
import {translations} from '../../i18n/index.ts';
import {readCachedAvatarData} from '../../session/profile-cache.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';
import {AvatarImage} from '../avatar/AvatarImage.tsx';

// 头像上传的客户端预检门槛，口径和 avatarHint 的文案保持一致：
// PNG/JPG/JPEG/HEIC，不超过 5MB。这里只是把明显不合格的文件当场拦下、
// 省得无谓上传一次，服务端校验仍然是权威。
const maxAvatarBytes = 5 * 1024 * 1024;

// HEIC/HEIF 的 MIME 字符串以 IANA 注册为准（RFC 4337、ISO/IEC 23008-12）：
// 单图是 image/heic、image/heif，多帧序列是 image/heic-sequence、
// image/heif-sequence。Safari 对 .heic 文件报 image/heic；部分浏览器
// （如 Windows 上的 Chrome）file.type 是空串，这时退回按扩展名判断，
// 不然 HEIC 会被误拦。
const allowedAvatarTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/heic',
  'image/heic-sequence',
  'image/heif',
  'image/heif-sequence',
]);
const allowedAvatarExtensions = new Set(['png', 'jpg', 'jpeg', 'heic', 'heif']);

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
  // 预检拒绝文件时的当场提示；下一次重新选文件就清掉。
  const [pickError, setPickError] = useState<string | null>(null);
  // 离线启动时资料接口还没回来，App 传下来的 avatarUrl 是 null：用本地
  // 缓存的头像 dataURL 显示，不闪现默认图。挂载时读一次就够；在线以后
  // 一律以 prop 为准。
  const [cachedAvatar] = useState(() => readCachedAvatarData());

  function handlePick(file: File) {
    const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase();
    const typeAllowed =
      allowedAvatarTypes.has(file.type) ||
      (file.type === '' && allowedAvatarExtensions.has(extension));
    if (!typeAllowed) {
      setPickError(text.avatarWrongType);
      return;
    }
    if (file.size > maxAvatarBytes) {
      setPickError(text.avatarTooLarge);
      return;
    }
    setPickError(null);
    onPick(file);
  }

  return (
    <div className="flex items-start gap-4 border-b border-base-300 py-4">
      <AvatarImage
        src={avatarUrl ?? cachedAvatar}
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
                handlePick(file);
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
        {pickError ? (
          <p
            className="m-0 mt-2 flex items-center gap-1.5 text-xs"
            role="alert"
            lang={htmlLang[locale]}
          >
            <CircleAlert className="size-4 shrink-0 text-error" aria-hidden="true" />
            <span>{pickError}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
