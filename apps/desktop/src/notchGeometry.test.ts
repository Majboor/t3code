import { describe, expect, it } from "vitest";

import {
  containsPoint,
  NOTCH_COLLAPSED_CHIN_HEIGHT,
  NOTCH_COLLAPSED_STANDALONE_HEIGHT,
  NOTCH_COLLAPSED_WIDTH,
  NOTCH_PANEL_GUTTER,
  NOTCH_PANEL_HEIGHT,
  NOTCH_PANEL_WIDTH,
  type NotchDisplayMetrics,
  resolveNotchHoverTarget,
  resolveNotchLayout,
  toWindowLocalRect,
  unionRect,
} from "./notchGeometry.ts";

/** 16" MacBook Pro: primary display, notched menu bar. */
const notchedDisplay: NotchDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 38, width: 1728, height: 1079 },
};

/** External 1440p monitor promoted to primary: ordinary 25pt menu bar. */
const plainDisplay: NotchDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1415 },
};

describe("resolveNotchLayout", () => {
  it("reads the notch off the reserved menu bar height", () => {
    expect(resolveNotchLayout(notchedDisplay).hasNotch).toBe(true);
    expect(resolveNotchLayout(plainDisplay).hasNotch).toBe(false);
  });

  it("centres the window horizontally and pins it to the top of the display", () => {
    const layout = resolveNotchLayout(notchedDisplay);

    expect(layout.window.width).toBe(NOTCH_PANEL_WIDTH + NOTCH_PANEL_GUTTER * 2);
    expect(layout.window.y).toBe(0);
    expect(layout.window.x + layout.window.width / 2).toBe(1728 / 2);
  });

  it("stays centred on a display that is not at the screen origin", () => {
    const layout = resolveNotchLayout({
      bounds: { x: -1728, y: -200, width: 1728, height: 1117 },
      workArea: { x: -1728, y: -162, width: 1728, height: 1079 },
    });

    expect(layout.window.y).toBe(-200);
    expect(layout.window.x + layout.window.width / 2).toBe(-1728 + 1728 / 2);
    expect(layout.expanded.y).toBe(-162);
  });

  it("runs the collapsed pill up behind the notch so only the chin shows", () => {
    const layout = resolveNotchLayout(notchedDisplay);

    expect(layout.menuBarInset).toBe(38);
    expect(layout.collapsed.y).toBe(0);
    expect(layout.collapsed.height).toBe(38 + NOTCH_COLLAPSED_CHIN_HEIGHT);
    expect(layout.collapsed.width).toBe(NOTCH_COLLAPSED_WIDTH);
    expect(layout.chinHeight).toBe(NOTCH_COLLAPSED_CHIN_HEIGHT);
  });

  it("drops the collapsed pill below the menu bar when there is no notch", () => {
    const layout = resolveNotchLayout(plainDisplay);

    expect(layout.collapsed.y).toBe(25);
    expect(layout.collapsed.height).toBe(NOTCH_COLLAPSED_STANDALONE_HEIGHT);
    expect(layout.chinHeight).toBe(NOTCH_COLLAPSED_STANDALONE_HEIGHT);
  });

  it("hangs the expanded panel off the bottom of the menu bar on either kind of Mac", () => {
    expect(resolveNotchLayout(notchedDisplay).expanded).toEqual({
      x: (1728 - NOTCH_PANEL_WIDTH) / 2,
      y: 38,
      width: NOTCH_PANEL_WIDTH,
      height: NOTCH_PANEL_HEIGHT,
    });
    expect(resolveNotchLayout(plainDisplay).expanded.y).toBe(25);
  });

  it("leaves gutter below the panel for its shadow", () => {
    const layout = resolveNotchLayout(notchedDisplay);

    expect(layout.window.height).toBe(38 + NOTCH_PANEL_HEIGHT + NOTCH_PANEL_GUTTER);
    expect(layout.expanded.y + layout.expanded.height).toBeLessThan(
      layout.window.y + layout.window.height,
    );
  });

  it("keeps the window inside a display too small to hold the panel", () => {
    const layout = resolveNotchLayout({
      bounds: { x: 0, y: 0, width: 320, height: 120 },
      workArea: { x: 0, y: 25, width: 320, height: 95 },
    });

    expect(layout.window.x).toBeGreaterThanOrEqual(0);
    expect(layout.window.x + layout.window.width).toBeLessThanOrEqual(320);
    expect(layout.window.y + layout.window.height).toBeLessThanOrEqual(120);
    expect(layout.collapsed.width).toBeLessThanOrEqual(layout.window.width);
  });

  it("survives a display that reports no menu bar at all", () => {
    const layout = resolveNotchLayout({
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      workArea: { x: 0, y: 0, width: 1920, height: 1080 },
    });

    expect(layout.menuBarInset).toBe(0);
    expect(layout.hasNotch).toBe(false);
    expect(layout.collapsed.y).toBe(0);
    expect(layout.expanded.y).toBe(0);
  });
});

describe("resolveNotchHoverTarget", () => {
  it("only the pill can open the panel", () => {
    const layout = resolveNotchLayout(notchedDisplay);

    expect(resolveNotchHoverTarget(layout, false)).toEqual(layout.collapsed);
  });

  it("covers the gap between pill and panel once expanded", () => {
    const layout = resolveNotchLayout(notchedDisplay);
    const target = resolveNotchHoverTarget(layout, true);

    // A cursor travelling straight down the centre from the notch into the
    // panel must never leave the target, or the panel shuts under it.
    for (let y = layout.window.y; y < layout.expanded.y + layout.expanded.height; y += 1) {
      expect(containsPoint(target, { x: 1728 / 2, y })).toBe(true);
    }
    expect(
      containsPoint(target, { x: 1728 / 2, y: layout.expanded.y + layout.expanded.height }),
    ).toBe(false);
  });

  it("is wide enough for the whole panel but no wider", () => {
    const layout = resolveNotchLayout(notchedDisplay);
    const target = resolveNotchHoverTarget(layout, true);

    expect(target.width).toBe(NOTCH_PANEL_WIDTH);
    expect(containsPoint(target, { x: layout.expanded.x, y: layout.expanded.y })).toBe(true);
    expect(containsPoint(target, { x: layout.expanded.x - 1, y: layout.expanded.y })).toBe(false);
  });
});

describe("containsPoint", () => {
  const rect = { x: 10, y: 20, width: 30, height: 40 };

  it("includes the top-left edge and excludes the bottom-right", () => {
    expect(containsPoint(rect, { x: 10, y: 20 })).toBe(true);
    expect(containsPoint(rect, { x: 39, y: 59 })).toBe(true);
    expect(containsPoint(rect, { x: 40, y: 59 })).toBe(false);
    expect(containsPoint(rect, { x: 39, y: 60 })).toBe(false);
    expect(containsPoint(rect, { x: 9, y: 20 })).toBe(false);
  });
});

describe("unionRect", () => {
  it("spans both rects", () => {
    expect(
      unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 20, width: 10, height: 5 }),
    ).toEqual({ x: 0, y: 0, width: 15, height: 25 });
  });
});

describe("toWindowLocalRect", () => {
  it("rebases screen coordinates onto the window", () => {
    const layout = resolveNotchLayout(notchedDisplay);
    const local = toWindowLocalRect(layout.expanded, layout.window);

    expect(local).toEqual({
      x: NOTCH_PANEL_GUTTER,
      y: 38,
      width: NOTCH_PANEL_WIDTH,
      height: NOTCH_PANEL_HEIGHT,
    });
  });
});
