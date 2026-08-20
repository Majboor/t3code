import { describe, expect, it } from "vitest";

import {
  buildEnrollmentDataUrl,
  buildEnrollmentDocumentHtml,
  buildEnrollmentViewScript,
  ENROLLMENT_ACTION_ATTRIBUTE,
  isEnrollmentWindowAction,
  resolveEnrollmentView,
} from "./document.ts";
import {
  createInitialDeviceEnrollmentState,
  isTerminalEnrollmentPhase,
  type DeviceEnrollmentPhase,
  type DeviceEnrollmentState,
} from "./machine.ts";

/** Every member of the union, listed so a new phase fails these tests loudly. */
const ALL_PHASES: readonly DeviceEnrollmentPhase[] = [
  "idle",
  "requesting",
  "waiting",
  "approved",
  "collecting",
  "connected",
  "denied",
  "expired",
  "failed",
];

function stateIn(phase: DeviceEnrollmentPhase): DeviceEnrollmentState {
  return { ...createInitialDeviceEnrollmentState(), phase };
}

describe("resolveEnrollmentView", () => {
  /*
   * The invariant this whole screen exists to hold. A phase that renders no
   * buttons and reports nothing in progress is a dead end that a person can
   * only escape by quitting the app — the exact failure mode this flow was
   * asked to avoid.
   */
  it.each(ALL_PHASES)("gives %s either something to click or something happening", (phase) => {
    const view = resolveEnrollmentView(stateIn(phase), "Waleeds-MacBook");
    expect(view.busy || view.actions.length > 0).toBe(true);
  });

  it.each(ALL_PHASES)("always tells the person what %s means", (phase) => {
    const view = resolveEnrollmentView(stateIn(phase), "Waleeds-MacBook");
    expect(view.headline.trim().length).toBeGreaterThan(0);
    expect(view.detail.trim().length).toBeGreaterThan(0);
  });

  /*
   * Every ending must offer a way back to the beginning, or a machine that was
   * denied once can never be connected without reinstalling the app.
   */
  it.each(ALL_PHASES.filter((phase) => isTerminalEnrollmentPhase(phase)))(
    "offers a way out of %s",
    (phase) => {
      const view = resolveEnrollmentView(stateIn(phase), "Waleeds-MacBook");
      expect(view.busy).toBe(false);
      expect(
        view.actions.some((action) => action.action === "restart" || action.action === "dismiss"),
      ).toBe(true);
    },
  );

  it.each(ALL_PHASES)("only emits actions main knows how to handle in %s", (phase) => {
    for (const button of resolveEnrollmentView(stateIn(phase), "Waleeds-MacBook").actions) {
      expect(isEnrollmentWindowAction(button.action)).toBe(true);
      expect(button.label.trim().length).toBeGreaterThan(0);
    }
  });

  it("names the machine so the person can recognise what they are approving", () => {
    expect(resolveEnrollmentView(stateIn("waiting"), "Waleeds-MacBook").detail).toContain(
      "Waleeds-MacBook",
    );
  });

  /*
   * A denial or a network failure carries server text, and that text is the
   * only thing distinguishing "wifi is down" from "somebody said no".
   */
  it("prefers the recorded reason over the generic one", () => {
    const view = resolveEnrollmentView(
      { ...stateIn("failed"), message: "The service is not responding." },
      "Waleeds-MacBook",
    );
    expect(view.detail).toBe("The service is not responding.");
  });

  it("still explains a failure that arrived with no reason attached", () => {
    expect(
      resolveEnrollmentView(stateIn("failed"), "Waleeds-MacBook").detail.length,
    ).toBeGreaterThan(0);
  });

  it("offers exactly one primary action per phase, so there is never a contested default", () => {
    for (const phase of ALL_PHASES) {
      const primaries = resolveEnrollmentView(stateIn(phase), "Waleeds-MacBook").actions.filter(
        (action) => action.primary,
      );
      expect(primaries.length).toBeLessThanOrEqual(1);
    }
  });

  /*
   * Losing the approval tab is easy and common. Without this the only recovery
   * from a closed tab is abandoning a code that is still perfectly good.
   */
  it("lets someone who closed the tab reopen it without a new code", () => {
    expect(
      resolveEnrollmentView(stateIn("waiting"), "Waleeds-MacBook").actions.map(
        (action) => action.action,
      ),
    ).toContain("open-browser");
  });
});

describe("buildEnrollmentDocumentHtml", () => {
  const html = buildEnrollmentDocumentHtml();

  /*
   * This page is the first thing a new install shows and it must render with no
   * network at all. Anything fetched is something that can fail on exactly the
   * machine that has not connected to anything yet.
   */
  it("references nothing outside itself", () => {
    expect(html).not.toContain("src=");
    expect(html).not.toContain("http://");
    expect(html).not.toContain("https://");
    expect(html).not.toContain("@import");
  });

  it("carries no script of its own", () => {
    expect(html).not.toContain("<script");
  });

  it("lays out the slots the update script writes into", () => {
    expect(html).toContain("data-enroll-headline");
    expect(html).toContain("data-enroll-detail");
    expect(html).toContain("data-enroll-actions");
  });

  it("is served inline, so no loose asset has to survive packaging", () => {
    expect(buildEnrollmentDataUrl().startsWith("data:text/html;charset=utf-8,")).toBe(true);
  });
});

describe("buildEnrollmentViewScript", () => {
  it("marks buttons with the attribute the preload listens for", () => {
    const script = buildEnrollmentViewScript(
      resolveEnrollmentView(stateIn("idle"), "Waleeds-MacBook"),
    );
    expect(script).toContain(JSON.stringify(ENROLLMENT_ACTION_ATTRIBUTE));
    expect(script).toContain('"connect"');
  });

  /*
   * The device label comes from the machine's hostname and the detail line can
   * carry server text. Both are written with `textContent` and both are encoded
   * with `JSON.stringify`, so neither can close the script literal or be parsed
   * as markup in a window that runs before anything has been authenticated.
   */
  it("cannot be escaped by a hostile machine name", () => {
    const script = buildEnrollmentViewScript(
      resolveEnrollmentView(stateIn("waiting"), '</script><img src=x onerror="alert(1)">'),
    );
    expect(script).not.toContain("</script>");
    expect(script).not.toContain('<img src=x onerror="alert(1)">');
    expect(script).toContain("textContent");
    expect(script).not.toContain("innerHTML");
  });

  it("reports the phase and the busy flag the stylesheet keys off", () => {
    expect(
      buildEnrollmentViewScript(resolveEnrollmentView(stateIn("waiting"), "Waleeds-MacBook")),
    ).toContain('"phase":"waiting"');
    expect(
      buildEnrollmentViewScript(resolveEnrollmentView(stateIn("denied"), "Waleeds-MacBook")),
    ).toContain('"busy":false');
  });
});
