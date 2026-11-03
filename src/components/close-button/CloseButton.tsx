export function CloseButton({label, onClick}: {label: string; onClick: () => void}) {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm btn-circle absolute top-3 right-3 text-2xl leading-none"
      aria-label={label}
      onClick={onClick}
    >
      ×
    </button>
  );
}
