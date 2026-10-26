import {useEffect, useRef} from 'react';

export function ConnectionToast({
  message,
  lang,
  onDismiss,
}: {
  message: string;
  lang: string;
  onDismiss: () => void;
}) {
  const dismissRef = useRef(onDismiss);

  useEffect(() => {
    dismissRef.current = onDismiss;
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      dismissRef.current();
    }, 5000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="pointer-events-none fixed top-6 left-1/2 z-[100] -translate-x-1/2 px-4">
      <p
        className="m-0 rounded-lg border border-stone-300 bg-white px-4 py-3 text-center text-red-600 shadow-lg"
        role="alert"
        lang={lang}
      >
        {message}
      </p>
    </div>
  );
}
