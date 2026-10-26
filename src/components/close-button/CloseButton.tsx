export function CloseButton({label, onClick}: {label: string; onClick: () => void}) {
  return (
    <button
      type="button"
      className="absolute top-3 right-3 inline-flex size-9 items-center justify-center rounded-lg border-0 bg-transparent text-2xl leading-none"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}
