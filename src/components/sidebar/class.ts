export function sidebarClass(narrow: boolean, open: boolean): string {
  if (narrow && open) {
    return 'fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-80 flex-col gap-3 overflow-hidden border-r border-stone-300 bg-base-300 p-3 shadow-2xl transition-transform duration-200 ease-out translate-x-0';
  }
  if (narrow) {
    return 'pointer-events-none fixed inset-y-0 left-0 z-40 flex w-[85vw] max-w-80 flex-col gap-3 overflow-hidden border-r border-stone-300 bg-base-300 p-3 shadow-2xl transition-transform duration-200 ease-out -translate-x-full';
  }
  if (open) {
    return 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r border-stone-300 bg-base-300 p-3';
  }
  return 'flex min-h-0 min-w-0 flex-col gap-3 overflow-hidden border-r-0 bg-base-300 px-0 py-3';
}
