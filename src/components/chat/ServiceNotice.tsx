export function ServiceNotice({text}: {text: string}) {
  return (
    <p
      className="mb-3 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      role="status"
    >
      {text}
    </p>
  );
}
