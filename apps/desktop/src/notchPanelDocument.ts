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
 * script and means the morph runs on the compositor rather than over IPC. The
 * numbers arrive the same way: `buildNotchDataScript` writes text into slots
 * the document already laid out, so the page never has to know where a figure
 * came from or how to ask for it.
 */

import { type NotchLayout, toWindowLocalRect } from "./notchGeometry.ts";

export const NOTCH_STATE_ATTRIBUTE = "notchState";

/**
 * The slots, in the order they are drawn. The keys are also the selector the
 * update script targets, so adding a row here is the only edit a fourth figure
 * would need on this side.
 */
export const NOTCH_SLOTS = [
  { key: "shareClicks", label: "Share clicks" },
  { key: "tokenSpend", label: "Token spend" },
  { key: "activeSyncs", label: "Active syncs" },
] as const;

export type NotchSlotKey = (typeof NOTCH_SLOTS)[number]["key"];

export interface NotchSlotView {
  /** Display-ready. An em dash whenever there is no number worth showing. */
  readonly value: string;
  /**
   * A word or two set beside the value: a caveat on a real figure, or — when
   * the value is a dash — the reason it is one. Carried next to the value
   * rather than only in the tooltip, because a click-through overlay is a poor
   * place to hide the difference between "nothing happened" and "we don't know".
   */
  readonly note: string;
  /** The long form, for the tooltip and for assistive technology. */
  readonly detail: string;
}

export type NotchPanelView = Readonly<Record<NotchSlotKey, NotchSlotView>>;

export const EM_DASH = "—";

/** What the page shows between being loaded and the first read landing. */
export const initialNotchPanelView: NotchPanelView = {
  shareClicks: { value: EM_DASH, note: "", detail: "Not read yet." },
  tokenSpend: { value: EM_DASH, note: "", detail: "Not read yet." },
  activeSyncs: { value: EM_DASH, note: "", detail: "Not read yet." },
};

/** Corner radius of the expanded panel, in CSS pixels. */
const PANEL_RADIUS = 22;

/** Radius on the two corners of the collapsed pill that are actually visible. */
const PILL_RADIUS = 12;

const MORPH_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";
const MORPH_DURATION_MS = 260;

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

/**
 * Values and details are generated here, but they still pass through this on
 * the way into a template string — the day one of them starts carrying a
 * server-supplied name, the escaping has to already be in place.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSlots(): string {
  return NOTCH_SLOTS.map(({ key, label }) => {
    const slot = initialNotchPanelView[key];
    const detail = escapeHtml(slot.detail);
    // The em dash is written as an entity so the initial markup carries no
    // non-ASCII, which survives the `data:` URL round trip unambiguously.
    const value = slot.value === EM_DASH ? "&mdash;" : escapeHtml(slot.value);
    return (
      `        <div class="slot"><dt>${label}</dt>` +
      `<dd data-slot="${key}" title="${detail}" aria-label="${detail}">` +
      `<span class="value">${value}</span><span class="note">${escapeHtml(slot.note)}</span>` +
      `</dd></div>`
    );
  }).join("\n");
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
        display: flex;
        align-items: baseline;
        gap: 6px;
        min-width: 0;
      }

      .slot dd .value {
        font-size: 15px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        color: rgba(255, 255, 255, 0.9);
      }

      /*
       * Deliberately quiet. It qualifies the number beside it — or explains a
       * dash — and must never compete with the figure for the half-second of
       * attention a hover panel gets.
       */
      .slot dd .note {
        font-size: 11px;
        font-weight: 500;
        color: rgba(255, 255, 255, 0.38);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .slot dd .note:empty {
        display: none;
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

/**
 * Writes a whole reading into the page in one evaluation.
 *
 * All three slots are always rewritten, even the ones that did not move: the
 * alternative is tracking what the page currently shows in a second place, and
 * a panel that disagrees with itself about which figure is stale is worse than
 * one that repaints three short strings.
 */
export function buildNotchDataScript(view: NotchPanelView): string {
  const calls = NOTCH_SLOTS.map(({ key }) => {
    const slot = view[key];
    return `w(${JSON.stringify(key)},${JSON.stringify(slot.value)},${JSON.stringify(slot.note)},${JSON.stringify(slot.detail)});`;
  }).join("");
  return (
    `(()=>{const w=(k,v,n,d)=>{` +
    `const e=document.querySelector('[data-slot="'+k+'"]');if(!e)return;` +
    `e.children[0].textContent=v;e.children[1].textContent=n;` +
    `e.title=d;e.setAttribute("aria-label",d);};${calls}})();`
  );
}
