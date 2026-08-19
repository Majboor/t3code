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
 *
 * The rows are numbered rather than named, because what they hold depends on
 * what the person is looking at (`notchContext.ts`). The document lays out
 * exactly `NOTCH_SLOT_COUNT` rows once and the update script rewrites their
 * labels along with their values, so navigating swaps the *content* of a box
 * whose size was fixed at load. Nothing a context can do reflows the panel.
 */

import { NOTCH_CONTEXT_PANELS, NOTCH_SLOT_COUNT } from "./notchContext.ts";
import { type NotchLayout, toWindowLocalRect } from "./notchGeometry.ts";

export const NOTCH_STATE_ATTRIBUTE = "notchState";

/**
 * Which of the panel's states the reader can do something about.
 *
 * Only states with a next step belong here. "The server is off", "the read
 * failed" and "this account has no workspace" are not fixed by clicking, so
 * they keep their dash and their reason — a button that leads nowhere is worse
 * than an honest blank.
 */
export type NotchPanelAction = "sign-in";

export const NOTCH_ACTION_ATTRIBUTE = "notchAction";

/** Written when no state offers an action, so the switch is a plain assignment. */
const NOTCH_ACTION_NONE = "none";

/**
 * The one hook a click has to find, named here because this module writes it.
 *
 * The page carries no script of its own, so the click is recognised in
 * `notchPreload.ts` by this attribute. Sharing the constant is what stops the
 * button and the code listening for it from drifting apart silently.
 */
export const NOTCH_ACTION_BUTTON_ATTRIBUTE = "data-notch-action-button";

/**
 * The page -> main direction of the same contract the rest of this module
 * defines going the other way. Main drives the panel by evaluating the scripts
 * below; this is the single message that travels back, and it carries nothing —
 * the channel *is* the message.
 */
export const NOTCH_SIGN_IN_CHANNEL = "desktop:notch-sign-in";

export interface NotchSlotView {
  /** Drawn on the left of the row; it changes with the context. */
  readonly label: string;
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

export interface NotchPanelView {
  /** The heading, so a changed set of figures says what it is now about. */
  readonly title: string;
  /** Always `NOTCH_SLOT_COUNT` long; the page has that many rows and no more. */
  readonly slots: readonly NotchSlotView[];
  /**
   * What the reader can do about this state, or `null` when the honest answer
   * is still a row of dashes. Required rather than optional so that every place
   * that builds a view has to have decided.
   */
  readonly action: NotchPanelAction | null;
}

export const EM_DASH = "—";

/** What the page shows between being loaded and the first read landing. */
export const initialNotchPanelView: NotchPanelView = {
  title: NOTCH_CONTEXT_PANELS.default.title,
  slots: NOTCH_CONTEXT_PANELS.default.slots.map(({ label }) => ({
    label,
    value: EM_DASH,
    note: "",
    detail: "Not read yet.",
  })),
  action: null,
};

/**
 * The signed-out panel's words.
 *
 * Two lines and no more: this is a hover panel at the top of the screen, and
 * the reader has already been told the app is not signed in by the fact that
 * they are looking at this rather than at their figures. The tooltip says what
 * the button actually does, because pressing it lands on the app window rather
 * than on a form the panel could ever host itself.
 */
const SIGN_IN_LINE = "Not signed in, so there is nothing to report yet.";
const SIGN_IN_BUTTON_LABEL = "Sign in";
const SIGN_IN_BUTTON_DETAIL = "Brings the T3 Code window forward, where you can sign in.";

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
  return initialNotchPanelView.slots
    .map((slot, index) => {
      const detail = escapeHtml(slot.detail);
      // The em dash is written as an entity so the initial markup carries no
      // non-ASCII, which survives the `data:` URL round trip unambiguously.
      const value = slot.value === EM_DASH ? "&mdash;" : escapeHtml(slot.value);
      return (
        `        <div class="slot" data-slot="${index}">` +
        `<dt>${escapeHtml(slot.label)}</dt>` +
        `<dd title="${detail}" aria-label="${detail}">` +
        `<span class="value">${value}</span><span class="note">${escapeHtml(slot.note)}</span>` +
        `</dd></div>`
      );
    })
    .join("\n");
}

export function buildNotchPanelHtml(layout: NotchLayout): string {
  return `<!doctype html>
<html lang="en" data-notch-state="collapsed" data-notch-action="${NOTCH_ACTION_NONE}">
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

      /*
       * Single-line, clipped rather than wrapped: the heading changes with the
       * context, and a two-line heading would push the rows below it down.
       */
      .panel-title {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.09em;
        text-transform: uppercase;
        color: rgba(255, 255, 255, 0.42);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

      /*
       * Labels are rewritten as the context changes, so they are pinned to one
       * line. A label allowed to wrap would make the panel taller on some pages
       * than on others, inside a window whose height was fixed at load.
       */
      .slot dt {
        font-size: 13px;
        color: rgba(255, 255, 255, 0.55);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
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

      /*
       * The one state the panel can do something about takes the rows' place
       * rather than joining them: the rows are laid out to fill the panel, and
       * a fourth thing below them would not fit a box whose height was fixed at
       * load. The rows stay in the document and keep being rewritten, so
       * signing in brings the figures back without rebuilding the page.
       */
      .action {
        display: none;
        flex-direction: column;
        align-items: flex-start;
        gap: 12px;
      }

      html[data-notch-action="sign-in"] .slots {
        display: none;
      }

      html[data-notch-action="sign-in"] .action {
        display: flex;
      }

      .action-line {
        font-size: 13px;
        line-height: 1.35;
        color: rgba(255, 255, 255, 0.55);
      }

      /*
       * Quiet on purpose. It is the only thing on this surface anyone can press,
       * so it has to read as pressable — but a hover panel over the menu bar is
       * not a login form, and a filled accent button here would be shouting.
       */
      .action-button {
        font-family: inherit;
        font-size: 12px;
        font-weight: 600;
        color: rgba(255, 255, 255, 0.92);
        background-color: rgba(255, 255, 255, 0.12);
        border: 1px solid rgba(255, 255, 255, 0.16);
        border-radius: 8px;
        padding: 6px 14px;
        cursor: pointer;
        transition: background-color 120ms ease;
      }

      .action-button:hover {
        background-color: rgba(255, 255, 255, 0.2);
      }

      .action-button:active {
        background-color: rgba(255, 255, 255, 0.26);
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
        <div class="panel-title" data-panel-title>${escapeHtml(initialNotchPanelView.title)}</div>
        <dl class="slots">
${renderSlots()}
        </dl>
        <div class="action">
          <p class="action-line">${escapeHtml(SIGN_IN_LINE)}</p>
          <button type="button" class="action-button" ${NOTCH_ACTION_BUTTON_ATTRIBUTE} title="${escapeHtml(SIGN_IN_BUTTON_DETAIL)}" aria-label="${escapeHtml(SIGN_IN_BUTTON_DETAIL)}">${escapeHtml(SIGN_IN_BUTTON_LABEL)}</button>
        </div>
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
 * Every row is rewritten, even the ones that did not move, and the label is
 * rewritten with the value: the alternative is tracking what the page currently
 * shows in a second place, and a panel that disagrees with itself about which
 * figure is stale — or worse, draws a deployment count under a label saying
 * "Share clicks" — is far worse than one that repaints a handful of short
 * strings. Rows the view does not fill are blanked for the same reason.
 *
 * The action travels with the figures rather than in a script of its own, so
 * the page can never be showing a sign-in button beside a reading that came
 * back signed in — the two are decided by one outcome and applied in one go.
 */
export function buildNotchDataScript(view: NotchPanelView): string {
  const action = JSON.stringify(view.action ?? NOTCH_ACTION_NONE);
  const calls = Array.from({ length: NOTCH_SLOT_COUNT }, (_unused, index) => {
    const slot = view.slots[index] ?? { label: "", value: EM_DASH, note: "", detail: "" };
    return (
      `w(${index},${JSON.stringify(slot.label)},${JSON.stringify(slot.value)},` +
      `${JSON.stringify(slot.note)},${JSON.stringify(slot.detail)});`
    );
  }).join("");
  return (
    `(()=>{document.documentElement.dataset.${NOTCH_ACTION_ATTRIBUTE}=${action};` +
    `const t=document.querySelector("[data-panel-title]");` +
    `if(t)t.textContent=${JSON.stringify(view.title)};` +
    `const w=(k,l,v,n,d)=>{` +
    `const e=document.querySelector('[data-slot="'+k+'"]');if(!e)return;` +
    `const c=e.children[1];e.children[0].textContent=l;` +
    `c.children[0].textContent=v;c.children[1].textContent=n;` +
    `c.title=d;c.setAttribute("aria-label",d);};${calls}})();`
  );
}
