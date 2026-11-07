import {useEffect, useRef, useState} from 'react';
import {narrowScreenNow, useNarrowScreen} from './use-narrow-screen.ts';

/**
 * 侧边栏的开合状态：窄屏上自动收起（收起后是浮层），窗口拉宽按用户
 * 之前的偏好恢复；用户在宽屏上手动开合会更新这个偏好。
 */
export function useSidebarState() {
  // 初始的宽窄判断与 useNarrowScreen 共用同一个断点查询串：改断点只改一处。
  const [sidebarOpen, setSidebarOpen] = useState(() => !narrowScreenNow());
  // 用户在宽屏上想看到的侧边栏状态。窄屏自动收起只是临时的，不改它。
  const sidebarWanted = useRef(sidebarOpen);
  const narrow = useNarrowScreen(() => {
    // 窄屏自动收起：不改用户的偏好，窗口拉宽之后按偏好恢复。
    setSidebarOpen(false);
  });

  useEffect(() => {
    // 窗口从窄变宽：按用户之前的偏好把侧边栏恢复回去。
    if (!narrow) {
      setSidebarOpen(sidebarWanted.current);
    }
  }, [narrow]);

  function openSidebar() {
    sidebarWanted.current = true;
    setSidebarOpen(true);
  }

  function closeSidebar() {
    // 窄屏上侧边栏是浮层，关掉它不代表用户想在宽屏上也收起。
    if (!narrow) {
      sidebarWanted.current = false;
    }
    setSidebarOpen(false);
  }

  return {narrow, sidebarOpen, openSidebar, closeSidebar};
}
