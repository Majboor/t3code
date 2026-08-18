/**
 * Placement rules for the macOS notch panel.
 *
 * Deliberately free of Electron imports: the interesting decisions here are
 * arithmetic over a display's `bounds`/`workArea`, and those are worth
 * exercising against synthetic displays (notched built-in panel, plain
 * external monitor, a display narrower than the panel) rather than against a
 * real screen we cannot reproduce in CI.
 */

export interface NotchRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface NotchPoint {
  readonly x: number;
  readonly y: number;
}

/** The subset of Electron's `Display` the layout actually depends on. */
export interface NotchDisplayMetrics {
  readonly bounds: NotchRect;
  readonly workArea: NotchRect;
}

export interface NotchLayout {
  /**
   * Bounds of the host window. It is sized for the *expanded* panel at all
   * times — see `notchWindow.ts` for why the window never resizes on hover.
   */
  readonly window: NotchRect;
  /** Screen-space rect of the pill as drawn while collapsed. */
  readonly collapsed: NotchRect;
  /** Screen-space rect of the panel as drawn while expanded. */
  readonly expanded: NotchRect;
  /** Distance from the top of the display down to the top of the work area. */
  readonly menuBarInset: number;
  /** Height of the part of the collapsed pill that clears the menu bar. */
  readonly chinHeight: number;
  readonly hasNotch: boolean;
}

export const NOTCH_COLLAPSED_WIDTH = 190;

/**
 * How far the collapsed pill drops below the menu bar. On a notched Mac the
 * rest of the pill is hidden behind the notch itself, so this sliver is the
 * only part anyone ever sees.
 */
export const NOTCH_COLLAPSED_CHIN_HEIGHT = 10;

/**
 * On a Mac without a notch there is nothing to hide behind, so the collapsed
 * pill sits entirely below the menu bar and needs enough height to read as a
 * deliberate shape rather than a rendering glitch.
 */
export const NOTCH_COLLAPSED_STANDALONE_HEIGHT = 14;

export const NOTCH_PANEL_WIDTH = 380;
export const NOTCH_PANEL_HEIGHT = 160;

/**
 * Slack around the panel inside the host window. The panel's drop shadow is
 * drawn by CSS, so it needs transparent window to bleed into or macOS clips it.
 */
export const NOTCH_PANEL_GUTTER = 16;

/**
 * A notched display reserves a taller menu bar so the menus clear the camera
 * housing: roughly 37-38pt against 24-25pt on every other Mac. macOS exposes
 * no notch API, so that gap is the only signal available, and any threshold
 * between the two clusters separates them.
 */
export const NOTCH_MENU_BAR_INSET_THRESHOLD = 32;

function centerWithin(outer: NotchRect, width: number): number {
  return Math.round(outer.x + (outer.width - width) / 2);
}

/** Rects are clamped rather than allowed to go non-positive on odd displays. */
function atLeastOne(value: number): number {
  return Math.max(1, Math.round(value));
}

export function resolveNotchLayout(display: NotchDisplayMetrics): NotchLayout {
  const { bounds, workArea } = display;
  const menuBarInset = Math.max(0, Math.round(workArea.y - bounds.y));
  const hasNotch = menuBarInset >= NOTCH_MENU_BAR_INSET_THRESHOLD;

  const panelWidth = atLeastOne(Math.min(NOTCH_PANEL_WIDTH, bounds.width));
  const panelHeight = atLeastOne(Math.min(NOTCH_PANEL_HEIGHT, bounds.height - menuBarInset));

  const windowWidth = atLeastOne(Math.min(panelWidth + NOTCH_PANEL_GUTTER * 2, bounds.width));
  const windowHeight = atLeastOne(
    Math.min(menuBarInset + panelHeight + NOTCH_PANEL_GUTTER, bounds.height),
  );

  const window: NotchRect = {
    x: centerWithin(bounds, windowWidth),
    y: Math.round(bounds.y),
    width: windowWidth,
    height: windowHeight,
  };

  const chinHeight = hasNotch ? NOTCH_COLLAPSED_CHIN_HEIGHT : NOTCH_COLLAPSED_STANDALONE_HEIGHT;
  const collapsedWidth = atLeastOne(Math.min(NOTCH_COLLAPSED_WIDTH, windowWidth));
  const collapsed: NotchRect = {
    x: centerWithin(bounds, collapsedWidth),
    // With a notch the pill starts at the very top so it reads as an extension
    // of the housing; without one it would just cover live menu bar items.
    y: hasNotch ? window.y : window.y + menuBarInset,
    width: collapsedWidth,
    height: atLeastOne(Math.min(hasNotch ? menuBarInset + chinHeight : chinHeight, windowHeight)),
  };

  const expanded: NotchRect = {
    x: centerWithin(bounds, panelWidth),
    y: window.y + menuBarInset,
    width: panelWidth,
    height: panelHeight,
  };

  return { window, collapsed, expanded, menuBarInset, chinHeight, hasNotch };
}

/** Left/top edges are inside the rect, right/bottom edges are not. */
export function containsPoint(rect: NotchRect, point: NotchPoint): boolean {
  return (
    point.x >= rect.x &&
    point.x < rect.x + rect.width &&
    point.y >= rect.y &&
    point.y < rect.y + rect.height
  );
}

export function unionRect(a: NotchRect, b: NotchRect): NotchRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

/**
 * The region that counts as "still hovering". Expanding uses the pill alone so
 * the panel does not fire from anywhere along the menu bar; staying expanded
 * uses the pill *and* the panel, so travelling down into the panel — across the
 * gap the pill leaves behind — never reads as a mouse-out.
 */
export function resolveNotchHoverTarget(layout: NotchLayout, expanded: boolean): NotchRect {
  return expanded ? unionRect(layout.collapsed, layout.expanded) : layout.collapsed;
}

/** Screen-space rect rebased onto the host window's coordinate system. */
export function toWindowLocalRect(rect: NotchRect, window: NotchRect): NotchRect {
  return { x: rect.x - window.x, y: rect.y - window.y, width: rect.width, height: rect.height };
}

export function areRectsEqual(a: NotchRect, b: NotchRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}
