export function chatFrameClass(narrow: boolean, sidebarOpen: boolean): string {
  if (narrow) {
    return 'relative grid h-full grid-cols-1';
  }
  if (sidebarOpen) {
    // 侧边栏跟着屏幕走：屏幕越窄它越窄，屏幕越宽它越宽。
    return 'relative grid h-full grid-cols-[15rem_minmax(0,1fr)] md:grid-cols-[16rem_minmax(0,1fr)] lg:grid-cols-[17rem_minmax(0,1fr)] xl:grid-cols-[19rem_minmax(0,1fr)] 2xl:grid-cols-[21rem_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out';
  }
  return 'relative grid h-full grid-cols-[0_minmax(0,1fr)] transition-[grid-template-columns] duration-200 ease-out';
}
