import { describe, expect, it } from "vitest";

import { type NotchDisplayMetrics, resolveNotchLayout } from "./notchGeometry.ts";
import {
  buildNotchCssVariables,
  buildNotchDataScript,
  buildNotchLayoutScript,
  buildNotchPanelDataUrl,
  buildNotchPanelHtml,
  buildNotchStateScript,
  NOTCH_SLOTS,
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

  it("renders the title and the three placeholder slots", () => {
    expect(html).toContain("Live activity");
    for (const label of ["Share clicks", "Token spend", "Active syncs"]) {
      expect(html).toContain(`<dt>${label}</dt>`);
    }
    expect(html.match(/&mdash;/g)).toHaveLength(3);
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

  it("gives every slot the hook the update script targets", () => {
    for (const { key } of NOTCH_SLOTS) {
      expect(html).toContain(`data-slot="${key}"`);
    }
  });

  it("starts every slot as a dash, so nothing reads as zero before a read lands", () => {
    expect(html.match(/&mdash;/g)).toHaveLength(NOTCH_SLOTS.length);
  });
});

describe("buildNotchDataScript", () => {
  const view: NotchPanelView = {
    shareClicks: { value: "1,284", note: "", detail: "1,284 opens." },
    tokenSpend: { value: "$12.50", note: "est.", detail: "Not a bill." },
    activeSyncs: { value: "—", note: "not wired", detail: "Nothing reports this." },
  };

  it("writes value, note and detail for every slot", () => {
    const script = buildNotchDataScript(view);

    for (const { key } of NOTCH_SLOTS) {
      const slot = view[key];
      expect(script).toContain(
        `w("${key}",${JSON.stringify(slot.value)},${JSON.stringify(slot.note)},${JSON.stringify(slot.detail)});`,
      );
    }
  });

  it("encodes text that would otherwise end the literal it sits in", () => {
    const hostile = 'a" + alert(1) + "\nb';
    const script = buildNotchDataScript({
      ...view,
      shareClicks: { value: hostile, note: "", detail: "x" },
    });

    expect(script).toContain(JSON.stringify(hostile));
    expect(script).not.toContain("\n");
  });
});
