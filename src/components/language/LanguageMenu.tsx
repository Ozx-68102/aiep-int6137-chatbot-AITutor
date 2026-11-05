import {ChevronDown, Languages} from 'lucide-react';
import {type KeyboardEvent as ReactKeyboardEvent, useEffect, useRef, useState} from 'react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // 之前是否打开过：关闭时据此决定要不要把焦点还给触发按钮，首次挂载不误触。
  const wasOpenRef = useRef(false);

  function menuItems(): HTMLButtonElement[] {
    return Array.from(
      popupRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]') ?? [],
    );
  }

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

  // 打开即把焦点挪进菜单（优先落在当前语言上），关闭把焦点还给触发按钮——
  // role="menu" 的语义向读屏用户承诺了这些行为。
  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const items = menuItems();
      const checked = items.find((item) => item.getAttribute('aria-checked') === 'true');
      const target = checked ?? items.at(0);
      if (target !== undefined) {
        target.focus();
      }
      return;
    }
    if (!wasOpenRef.current) {
      return;
    }
    wasOpenRef.current = false;
    // 浮层转入 inert 时浏览器会把焦点丢回 body：只在那时（或焦点还留在
    // 菜单里时）接管。点外部按钮关闭的场景，焦点已经落在点击目标上，
    // 不抢回来。
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (active instanceof Node && menuRef.current?.contains(active))
    ) {
      triggerRef.current?.focus();
    }
  }, [open]);

  // 方向键导航：上/下循环移动，Home/End 跳首尾。type-ahead 不做：一共
  // 只有三个选项，方向键循环已经够用。
  function onPopupKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    if (items.length === 0) {
      return;
    }
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % items.length;
        break;
      case 'ArrowUp':
        next = index < 0 ? items.length - 1 : (index - 1 + items.length) % items.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = items.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    items[next]?.focus();
  }

  return (
    <div className="relative ml-auto shrink-0" ref={menuRef}>
      <button
        ref={triggerRef}
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
        ref={popupRef}
        className={
          open
            ? 'absolute top-[calc(100%+0.35rem)] right-0 z-10 min-w-36 animate-in rounded-box border border-base-300 bg-base-100 shadow-lg fade-in slide-in-from-top-2 duration-200'
            : 'absolute top-[calc(100%+0.35rem)] right-0 z-10 hidden'
        }
        role="menu"
        aria-label={text.language}
        aria-hidden={!open}
        inert={!open}
        onKeyDown={onPopupKeyDown}
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
