/**
 * The notch panel's document, generated in-process.
 *
 * It is built as a string and handed to the renderer as a `data:` URL instead
 * of shipping an HTML file, because the desktop bundler only emits
 * `main.cjs`/`preload.cjs` — a loose asset under `src/` would exist in the repo
 * and be missing from every packaged build. Keeping it here also guarantees the
 * "no external assets, no network" property by construction: there is nothing
 * for the page to reference.
 *
 * Collapsed/expanded state is driven from the main process by assigning a data
 * attribute on `<html>`; everything else is CSS. That keeps the page free of
 * script and means the morph runs on the compositor rather than over IPC.
 */

import { type NotchLayout, toWindowLocalRect } from "./notchGeometry.ts";

export const NOTCH_STATE_ATTRIBUTE = "notchState";

/** Corner radius of the expanded panel, in CSS pixels. */
const PANEL_RADIUS = 22;

/** Radius on the two corners of the collapsed pill that are actually visible. */
const PILL_RADIUS = 12;

const MORPH_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MORPH_DURATION_MS = 260;

const PLACEHOLDER_SLOTS = ["Share clicks", "Token spend", "Active syncs"] as const;

/** Width of the small handle drawn on the collapsed pill. */
const GRIP_WIDTH = 26;
const GRIP_HEIGHT = 3;

export function buildNotchCssVariables(layout: NotchLayout): Record<string, string> {
  const collapsed = toWindowLocalRect(layout.collapsed, layout.window);
  const expanded = toWindowLocalRect(layout.expanded, layout.window);

  return {
    "--notch-pill-top": `${collapsed.y}px`,
    "--notch-pill-width": `${collapsed.width}px`,
    "--notch-pill-height": `${collapsed.height}px`,
    // Only the bottom corners clear the notch on a notched Mac; a standalone
    // pill sits in open space and should be rounded all the way round.
    "--notch-pill-radius": layout.hasNotch
      ? `0 0 ${PILL_RADIUS}px ${PILL_RADIUS}px`
      : `${Math.round(collapsed.height / 2)}px`,
    // Centre the grip inside the sliver of pill that is not behind the notch.
    "--notch-grip-bottom": `${Math.max(2, Math.round((layout.chinHeight - GRIP_HEIGHT) / 2))}px`,
    "--notch-panel-top": `${expanded.y}px`,
    "--notch-panel-width": `${expanded.width}px`,
    "--notch-panel-height": `${expanded.height}px`,
  };
}

function renderCssVariableBlock(layout: NotchLayout): string {
  return Object.entries(buildNotchCssVariables(layout))
    .map(([name, value]) => `      ${name}: ${value};`)
    .join("\n");
}

function renderSlots(): string {
  return PLACEHOLDER_SLOTS.map(
    (label) =>
      `        <div class="slot"><dt>${label}</dt><dd aria-label="no data yet">&mdash;</dd></div>`,
  ).join("\n");
}

export function buildNotchPanelHtml(layout: NotchLayout): string {
  return `<!doctype html>
<html lang="en" data-notch-state="collapsed">
  <head>
    <meta charset="utf-8" />
    <title>Live activity</title>
    <style>
      :root {
${renderCssVariableBlock(layout)}
      }

      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      html,
      body {
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: transparent;
      }

      body {
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
        -webkit-font-smoothing: antialiased;
        color: rgba(255, 255, 255, 0.92);
        cursor: default;
        user-select: none;
      }

      /*
       * One element morphs between the two shapes. Animating the box rather
       * than swapping two elements is what keeps the expansion continuous:
       * the pill visibly grows into the panel instead of being replaced by it.
       */
      .surface {
        position: absolute;
        left: 50%;
        top: var(--notch-pill-top);
        width: var(--notch-pill-width);
        height: var(--notch-pill-height);
        transform: translateX(-50%);
        border-radius: var(--notch-pill-radius);
        background-color: rgba(12, 12, 14, 0.94);
        box-shadow: 0 8px 22px rgba(0, 0, 0, 0.32);
        overflow: hidden;
        transition:
          top ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          width ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          height ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          border-radius ${MORPH_DURATION_MS}ms ${MORPH_EASING},
          background-color ${MORPH_DURATION_MS}ms ease,
          box-shadow ${MORPH_DURATION_MS}ms ease;
      }

      html[data-notch-state="expanded"] .surface {
        top: var(--notch-panel-top);
        width: var(--notch-panel-width);
        height: var(--notch-panel-height);
        border-radius: ${PANEL_RADIUS}px;
        /*
         * Real macOS vibrancy is a window-level effect and would tint the whole
         * host window, including the transparent gutter, so the panel settles
         * for straight alpha over the desktop instead.
         */
        background-color: rgba(20, 20, 23, 0.86);
        box-shadow:
          0 18px 44px rgba(0, 0, 0, 0.45),
          inset 0 1px 0 rgba(255, 255, 255, 0.09);
      }

      .grip {
        position: absolute;
        left: 50%;
        bottom: var(--notch-grip-bottom);
        width: ${GRIP_WIDTH}px;
        height: ${GRIP_HEIGHT}px;
        transform: translateX(-50%);
        border-radius: 999px;
        background-color: rgba(255, 255, 255, 0.28);
        transition: opacity 140ms ease;
      }

      html[data-notch-state="expanded"] .grip {
        opacity: 0;
      }

      /*
       * Pinned to the panel's final size so the text does not reflow while the
       * surface is still growing; the surface clips it until there is room.
       */
      .panel {
        position: absolute;
        left: 0;
        top: 0;
        width: var(--notch-panel-width);
        height: var(--notch-panel-height);
        padding: 20px 24px;
        display: flex;
        flex-direction: column;
        gap: 16px;
        opacity: 0;
        transform: translateY(-6px);
        transition:
          opacity 140ms ease,
          transform 200ms ${MORPH_EASING};
      }

      html[data-notch-state="expanded"] .panel {
        opacity: 1;
        transform: none;
        /* Let the box finish most of its travel before the content arrives. */
        transition-delay: 90ms;
      }

      .panel-title {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.42);
      }

      .slots {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .slot {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 16px;
      }

      .slot dt {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.55);
      }

      .slot dd {
        font-size: 15px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.9);
      }

      @media (prefers-reduced-motion: reduce) {
        .surface,
        .grip,
        .panel {
          transition-duration: 1ms;
        }
      }
    </style>
  </head>
  <body>
    <div class="surface">
      <div class="grip"></div>
      <div class="panel">
        <div class="panel-title">Live activity</div>
        <dl class="slots">
${renderSlots()}
        </dl>
      </div>
    </div>
  </body>
</html>
`;
}

export function buildNotchPanelDataUrl(layout: NotchLayout): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(buildNotchPanelHtml(layout))}`;
}

/**
 * Re-points the page at a new display without reloading it, so a monitor being
 * plugged in does not flash the panel.
 */
export function buildNotchLayoutScript(layout: NotchLayout): string {
  const assignments = Object.entries(buildNotchCssVariables(layout))
    .map(([name, value]) => `s.setProperty(${JSON.stringify(name)},${JSON.stringify(value)});`)
    .join("");
  return `(()=>{const s=document.documentElement.style;${assignments}})();`;
}

export function buildNotchStateScript(expanded: boolean): string {
  const state = JSON.stringify(expanded ? "expanded" : "collapsed");
  return `document.documentElement.dataset.${NOTCH_STATE_ATTRIBUTE}=${state};`;
}
