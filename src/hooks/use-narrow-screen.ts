import {useEffect, useRef, useState} from 'react';

const narrowQuery = '(max-width: 767px)';

export function useNarrowScreen(onEnterNarrow: () => void): boolean {
  const [narrow, setNarrow] = useState(() => window.matchMedia(narrowQuery).matches);
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
