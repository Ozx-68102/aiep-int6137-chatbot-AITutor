import {ChevronDown, Languages} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {locales, translations} from '../../i18n.ts';
import {htmlLang, type Locale} from '../../type/locale.ts';

export function LanguageMenu({
  locale,
  onChange,
  variant = 'icon',
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
  variant?: 'icon' | 'current';
}) {
  const text = translations[locale];
  const current = locales.find((item) => item.id === locale);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    function closeOnOutsidePointer(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      event.stopPropagation();
      setOpen(false);
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  return (
    <div className="relative ml-auto shrink-0" ref={menuRef}>
      <button
        type="button"
        className={
          variant === 'current'
            ? 'inline-flex min-w-36 items-center justify-between gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-left transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20'
            : 'inline-flex size-9 items-center justify-center rounded-lg border border-stone-300 bg-white text-inherit transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20'
        }
        aria-label={text.language}
        aria-expanded={open}
        aria-haspopup="menu"
        title={text.language}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        {variant === 'current' ? (
          <span lang={htmlLang[locale]}>{current?.label}</span>
        ) : (
          <Languages aria-hidden="true" />
        )}
        {variant === 'current' ? (
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        ) : null}
      </button>
      <div
        className={
          open
            ? 'absolute top-[calc(100%+0.35rem)] right-0 z-10 flex min-w-36 animate-in flex-col rounded-lg border border-stone-300 bg-white p-1.5 fade-in slide-in-from-top-2 duration-200'
            : 'absolute top-[calc(100%+0.35rem)] right-0 z-10 hidden'
        }
        role="menu"
        aria-label={text.language}
        aria-hidden={!open}
        inert={!open}
      >
        {locales.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            lang={htmlLang[item.id]}
            className={
              item.id === locale
                ? 'rounded-md border border-emerald-900 bg-emerald-50 px-2.5 py-1.5 text-left transition-colors duration-150 ease-out enabled:hover:bg-emerald-100 enabled:active:bg-emerald-200'
                : 'rounded-md border border-transparent bg-transparent px-2.5 py-1.5 text-left transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20'
            }
            aria-checked={item.id === locale}
            onClick={() => {
              onChange(item.id);
              setOpen(false);
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
