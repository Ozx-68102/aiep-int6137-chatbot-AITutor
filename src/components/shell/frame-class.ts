export function chatFrameClass(narrow: boolean, sidebarOpen: boolean): string {
  if (narrow) {
    return 'relative grid h-full grid-cols-1';
  }
  if (sidebarOpen) {
    return 'relative grid h-full grid-cols-[20rem_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out';
  }
  return 'relative grid h-full grid-cols-[0_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out';
}
