import { describe, expect, it } from "vitest";

import { NOTCH_CONTEXT_PANELS, NOTCH_SLOT_COUNT } from "./notchContext.ts";
import { type NotchDisplayMetrics, resolveNotchLayout } from "./notchGeometry.ts";
import {
  buildNotchCssVariables,
  buildNotchDataScript,
  buildNotchLayoutScript,
  buildNotchPanelDataUrl,
  buildNotchPanelHtml,
  buildNotchStateScript,
  NOTCH_ACTION_BUTTON_ATTRIBUTE,
  type NotchPanelView,
} from "./notchPanelDocument.ts";

const notchedDisplay: NotchDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 1728, height: 1117 },
  workArea: { x: 0, y: 38, width: 1728, height: 1079 },
};

const plainDisplay: NotchDisplayMetrics = {
  bounds: { x: 0, y: 0, width: 2560, height: 1440 },
  workArea: { x: 0, y: 25, width: 2560, height: 1415 },
};

describe("buildNotchCssVariables", () => {
  it("hands the page window-local coordinates, not screen ones", () => {
    const layout = resolveNotchLayout({
      bounds: { x: -1728, y: -200, width: 1728, height: 1117 },
      workArea: { x: -1728, y: -162, width: 1728, height: 1079 },
    });

    expect(buildNotchCssVariables(layout)["--notch-panel-top"]).toBe("38px");
  });

  it("rounds only the notch-clearing corners of the pill", () => {
    expect(buildNotchCssVariables(resolveNotchLayout(notchedDisplay))["--notch-pill-radius"]).toBe(
      "0 0 12px 12px",
    );
  });

  it("makes a standalone pill fully rounded", () => {
    expect(buildNotchCssVariables(resolveNotchLayout(plainDisplay))["--notch-pill-radius"]).toBe(
      "7px",
    );
  });

  it("keeps the grip inside the visible chin", () => {
    const layout = resolveNotchLayout(notchedDisplay);
    const bottom = Number.parseInt(buildNotchCssVariables(layout)["--notch-grip-bottom"] ?? "", 10);

    expect(bottom).toBeGreaterThan(0);
    expect(bottom).toBeLessThan(layout.chinHeight);
  });
});

describe("buildNotchPanelHtml", () => {
  const html = buildNotchPanelHtml(resolveNotchLayout(notchedDisplay));

  it("renders the default context's title and rows", () => {
    expect(html).toContain(NOTCH_CONTEXT_PANELS.default.title);
    for (const { label } of NOTCH_CONTEXT_PANELS.default.slots) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html.match(/&mdash;/g)).toHaveLength(NOTCH_SLOT_COUNT);
  });

  /*
   * The window is sized once and never resized, so a label that wrapped would
   * make the panel taller on one page than on another.
   */
  it("pins the rows and the heading to one line each", () => {
    expect(html).toMatch(/\.slot dt \{[^}]*white-space: nowrap;/);
    expect(html).toMatch(/\.panel-title \{[^}]*white-space: nowrap;/);
  });

  it("references nothing outside itself", () => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\bsrc=/i);
    expect(html).not.toMatch(/https?:/i);
    expect(html).not.toMatch(/@import/i);
  });

  it("bakes the resolved geometry into the stylesheet", () => {
    expect(html).toContain("--notch-panel-width: 380px;");
    expect(html).toContain("--notch-pill-top: 0px;");
  });
});

describe("buildNotchPanelDataUrl", () => {
  it("round-trips to the document", () => {
    const layout = resolveNotchLayout(plainDisplay);
    const url = buildNotchPanelDataUrl(layout);

    expect(url.startsWith("data:text/html;charset=utf-8,")).toBe(true);
    expect(decodeURIComponent(url.slice("data:text/html;charset=utf-8,".length))).toBe(
      buildNotchPanelHtml(layout),
    );
  });
});

describe("panel scripts", () => {
  it("sets every variable the stylesheet declares", () => {
    const layout = resolveNotchLayout(notchedDisplay);
    const script = buildNotchLayoutScript(layout);

    for (const [name, value] of Object.entries(buildNotchCssVariables(layout))) {
      expect(script).toContain(`s.setProperty("${name}","${value}")`);
    }
  });

  it("toggles the attribute the stylesheet keys off", () => {
    expect(buildNotchStateScript(true)).toBe(
      'document.documentElement.dataset.notchState="expanded";',
    );
    expect(buildNotchStateScript(false)).toBe(
      'document.documentElement.dataset.notchState="collapsed";',
    );
  });
});

describe("slot markup", () => {
  const html = buildNotchPanelHtml(resolveNotchLayout(notchedDisplay));

  it("gives every row the hook the update script targets", () => {
    for (let index = 0; index < NOTCH_SLOT_COUNT; index += 1) {
      expect(html).toContain(`data-slot="${index}"`);
    }
    expect(html).toContain("data-panel-title");
  });

  it("starts every slot as a dash, so nothing reads as zero before a read lands", () => {
    expect(html.match(/&mdash;/g)).toHaveLength(NOTCH_SLOT_COUNT);
  });

  /*
   * The rows are numbered rather than named because what they hold depends on
   * the page. A row keyed by figure would need the document rebuilt — and the
   * window reloaded — every time someone navigated.
   */
  it("carries no figure's name in the markup itself", () => {
    expect(html).not.toContain('data-slot="shareClicks"');
  });
});

describe("sign-in action", () => {
  const html = buildNotchPanelHtml(resolveNotchLayout(notchedDisplay));

  it("carries a real button, not a sentence dressed as one", () => {
    expect(html).toContain(`<button type="button"`);
    expect(html).toContain(NOTCH_ACTION_BUTTON_ATTRIBUTE);
  });

  it("says what the button does, since it lands on the app window", () => {
    expect(html).toMatch(/<button[^>]*title="[^"]+"[^>]*aria-label="[^"]+"/);
  });

  /*
   * The window is sized once for `NOTCH_SLOT_COUNT` rows. The button takes
   * their place rather than joining them, so no state can make the panel need
   * more room than it was built with.
   */
  it("swaps the rows out rather than adding a fourth thing below them", () => {
    expect(html).toMatch(/html\[data-notch-action="sign-in"\] \.slots \{[^}]*display: none;/);
    expect(html).toMatch(/html\[data-notch-action="sign-in"\] \.action \{[^}]*display: flex;/);
    expect(html).toMatch(/\n {6}\.action \{[^}]*display: none;/);
  });

  it("starts with no action, so a button never precedes a reading", () => {
    expect(html).toContain('data-notch-action="none"');
  });

  it("keeps the rows in the document so signing in brings the figures back", () => {
    expect(html.match(/data-slot="/g)).toHaveLength(NOTCH_SLOT_COUNT);
  });
});

describe("buildNotchDataScript", () => {
  const view: NotchPanelView = {
    title: "Deployment",
    slots: [
      { label: "Live", value: "2", note: "of 3 deployments", detail: "2 of 3 are live." },
      { label: "Traffic", value: "—", note: "not wired", detail: "Nothing can report." },
      { label: "Last deploy", value: "3h ago", note: "succeeded", detail: "Ran at noon." },
    ],
    action: null,
  };

  it("switches the page to the button and back with the figures it belongs to", () => {
    expect(buildNotchDataScript({ ...view, action: "sign-in" })).toContain(
      'document.documentElement.dataset.notchAction="sign-in";',
    );
    expect(buildNotchDataScript(view)).toContain(
      'document.documentElement.dataset.notchAction="none";',
    );
  });

  it("writes label, value, note and detail for every row", () => {
    const script = buildNotchDataScript(view);

    view.slots.forEach((slot, index) => {
      expect(script).toContain(
        `w(${index},${JSON.stringify(slot.label)},${JSON.stringify(slot.value)},` +
          `${JSON.stringify(slot.note)},${JSON.stringify(slot.detail)});`,
      );
    });
  });

  it("repoints the heading, so the figures say what they are about", () => {
    expect(buildNotchDataScript(view)).toContain('t.textContent="Deployment"');
  });

  it("blanks a row the view does not fill rather than leaving the last page's", () => {
    const script = buildNotchDataScript({
      title: "Analytics",
      slots: [view.slots[0]!],
      action: null,
    });

    expect(script).toContain(`w(1,"","—","","");`);
  });

  it("encodes text that would otherwise end the literal it sits in", () => {
    const hostile = 'a" + alert(1) + "\nb';
    const script = buildNotchDataScript({
      title: hostile,
      slots: [{ label: hostile, value: hostile, note: "", detail: "x" }],
      action: null,
    });

    expect(script).toContain(JSON.stringify(hostile));
    expect(script).not.toContain("\n");
  });
});
