import {useState} from 'react';
import {defaultAvatarUrl} from '../../api/profile.ts';

/**
 * 头像。地址拿不到或者加载失败，就退回默认那张。
 */
export function AvatarImage({
  src,
  alt,
  className,
}: {
  src: string | null;
  alt: string;
  className?: string;
}) {
  // 记下哪个地址加载失败过。换了地址自然就不算失败，不用另外重置。
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const url = !src || failedSrc === src ? defaultAvatarUrl : src;

  return (
    <div className="avatar shrink-0">
      <img
        src={url}
        alt={alt}
        className={className}
        onError={() => {
          setFailedSrc(src);
        }}
      />
    </div>
  );
}
