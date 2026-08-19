export type ResponsiveSidebarState = "expanded" | "collapsed";

/**
 * Which sidebar is actually on screen depends on the viewport: the desktop
 * sidebar tracks `open`, the mobile sheet tracks `openMobile`. Reading only
 * `open` reports "expanded" for a phone whose sheet is shut, and "collapsed"
 * for a desktop trigger that is in fact showing an open sidebar.
 */
export function resolveSidebarState(input: {
  isMobile: boolean;
  open: boolean;
  openMobile: boolean;
}): ResponsiveSidebarState {
  return (input.isMobile ? input.openMobile : input.open) ? "expanded" : "collapsed";
}
