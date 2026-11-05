import {useEffect, useRef, useState} from 'react';

/** 窄屏断点的查询串（O9）：TS 侧的唯一出处，初始状态和监听共用这一个值。 */
export const narrowQuery = '(max-width: 767px)';

/** 当前视口是不是窄屏：与 useNarrowScreen 用同一个查询串，避免两处判断分家。 */
export function narrowScreenNow(): boolean {
  return window.matchMedia(narrowQuery).matches;
}

export function useNarrowScreen(onEnterNarrow: () => void): boolean {
  const [narrow, setNarrow] = useState(narrowScreenNow);
  const onEnterNarrowRef = useRef(onEnterNarrow);

  useEffect(() => {
    const media = window.matchMedia(narrowQuery);
    function onChange() {
      setNarrow(media.matches);
      if (media.matches) {
        onEnterNarrowRef.current();
      }
    }
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  return narrow;
}
