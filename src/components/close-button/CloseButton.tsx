export function CloseButton({label, onClick}: {label: string; onClick: () => void}) {
  return (
    <button
      type="button"
      className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-lg border-0 bg-transparent text-2xl leading-none transition-colors duration-150 ease-out enabled:hover:bg-stone-900/10 enabled:active:bg-stone-900/20"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}
