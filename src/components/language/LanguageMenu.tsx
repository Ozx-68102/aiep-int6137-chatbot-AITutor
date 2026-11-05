import {ChevronDown, Languages} from 'lucide-react';
import {useEffect, useRef, useState} from 'react';
import {locales, translations} from '../../i18n/index.ts';
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
            ? 'btn min-w-36 justify-between border-base-300 bg-base-100 text-left hover:bg-base-200 active:bg-base-300'
            : 'btn btn-square border-base-300 bg-base-100 text-inherit hover:bg-base-200 active:bg-base-300'
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
            ? 'absolute top-[calc(100%+0.35rem)] right-0 z-10 min-w-36 animate-in rounded-box border border-base-300 bg-base-100 shadow-lg fade-in slide-in-from-top-2 duration-200'
            : 'absolute top-[calc(100%+0.35rem)] right-0 z-10 hidden'
        }
        role="menu"
        aria-label={text.language}
        aria-hidden={!open}
        inert={!open}
      >
        <ul className="menu w-full p-1.5" role="none">
          {locales.map((item) => (
            <li key={item.id} role="none">
              <button
                type="button"
                role="menuitemradio"
                lang={htmlLang[item.id]}
                className={item.id === locale ? 'menu-active' : undefined}
                aria-checked={item.id === locale}
                onClick={() => {
                  onChange(item.id);
                  setOpen(false);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
