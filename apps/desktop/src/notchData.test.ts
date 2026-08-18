import { describe, expect, it, vi } from "vitest";

import {
  createNotchRefreshScheduler,
  formatCompactCount,
  formatEstimatedCost,
  NOTCH_ACTIVITY_PATH,
  type NotchActivityOutcome,
  type NotchScriptHost,
  parseNotchActivityBody,
  readNotchActivity,
  readSignedInAccessToken,
  toNotchPanelView,
} from "./notchData.ts";
import { EM_DASH, NOTCH_SLOTS } from "./notchPanelDocument.ts";

const okBody = {
  signedIn: true,
  workspaceCount: 2,
  partial: false,
  shareViews: { total: 1284, linkCount: 3, lastViewedAt: "2026-08-16T10:00:00.000Z" },
  tokenSpend: {
    estimatedUsd: 12.5,
    totalTokens: 2_400_000,
    unpricedTokens: 0,
    since: "2026-07-17T00:00:00.000Z",
    until: "2026-08-16T00:00:00.000Z",
  },
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function stubFetch(response: Response | (() => never)) {
  return vi.fn(async () =>
    typeof response === "function" ? response() : response,
  ) as unknown as typeof globalThis.fetch;
}

describe("readNotchActivity", () => {
  it("reports a missing backend as offline rather than asking", async () => {
    const fetchImpl = stubFetch(jsonResponse(okBody));

    await expect(
      readNotchActivity({ baseUrl: null, accessToken: "token", fetchImpl }),
    ).resolves.toEqual({ kind: "offline" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports a missing token as signed out without a round trip", async () => {
    const fetchImpl = stubFetch(jsonResponse(okBody));

    await expect(
      readNotchActivity({ baseUrl: "http://127.0.0.1:3773", accessToken: null, fetchImpl }),
    ).resolves.toEqual({ kind: "signed-out" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("presents the account's token as a bearer credential", async () => {
    const fetchImpl = stubFetch(jsonResponse(okBody));

    await readNotchActivity({
      baseUrl: "http://127.0.0.1:3773",
      accessToken: "jwt-value",
      fetchImpl,
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(`http://127.0.0.1:3773${NOTCH_ACTIVITY_PATH}`);
    expect((init as RequestInit).headers).toEqual({ authorization: "Bearer jwt-value" });
  });

  it.each([401, 403])("treats a rejected credential (%i) as signed out", async (status) => {
    await expect(
      readNotchActivity({
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "jwt",
        fetchImpl: stubFetch(jsonResponse({ error: "no" }, status)),
      }),
    ).resolves.toEqual({ kind: "signed-out" });
  });

  it("keeps a server error apart from an empty reading", async () => {
    await expect(
      readNotchActivity({
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "jwt",
        fetchImpl: stubFetch(jsonResponse({ error: "boom" }, 500)),
      }),
    ).resolves.toEqual({ kind: "failed" });
  });

  it("treats a refused connection as offline", async () => {
    await expect(
      readNotchActivity({
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "jwt",
        fetchImpl: stubFetch(() => {
          throw new Error("ECONNREFUSED");
        }),
      }),
    ).resolves.toEqual({ kind: "offline" });
  });

  it("parses a real reading", async () => {
    await expect(
      readNotchActivity({
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "jwt",
        fetchImpl: stubFetch(jsonResponse(okBody)),
      }),
    ).resolves.toMatchObject({
      kind: "ok",
      activity: { workspaceCount: 2, shareViews: { total: 1284 } },
    });
  });
});

describe("parseNotchActivityBody", () => {
  it("calls an unrecognisable body a failure, never an empty reading", () => {
    expect(parseNotchActivityBody(null)).toEqual({ kind: "failed" });
    expect(parseNotchActivityBody("nope")).toEqual({ kind: "failed" });
    expect(parseNotchActivityBody({ signedIn: true })).toEqual({ kind: "failed" });
  });

  it("takes the server's word for a session with no account behind it", () => {
    expect(parseNotchActivityBody({ signedIn: false })).toEqual({ kind: "signed-out" });
  });

  it("keeps a section the server could not read as null", () => {
    const outcome = parseNotchActivityBody({
      signedIn: true,
      workspaceCount: 1,
      partial: true,
      shareViews: null,
      tokenSpend: { estimatedUsd: 1, totalTokens: 10 },
    });

    expect(outcome).toMatchObject({
      kind: "ok",
      activity: { partial: true, shareViews: null, tokenSpend: { unpricedTokens: 0 } },
    });
  });
});

function host(result: () => Promise<unknown>, destroyed = false): NotchScriptHost {
  return { isDestroyed: () => destroyed, executeJavaScript: result };
}

/**
 * The scheduler's in-flight guard only clears on a microtask, so every test that
 * expects a *second* read has to let the first one settle first.
 */
async function settle(): Promise<void> {
  for (let hop = 0; hop < 10; hop += 1) {
    await Promise.resolve();
  }
}

describe("readSignedInAccessToken", () => {
  it("has no token without a window", async () => {
    await expect(readSignedInAccessToken(null)).resolves.toBeNull();
  });

  it("has no token from a torn-down window", async () => {
    await expect(readSignedInAccessToken(host(async () => "value", true))).resolves.toBeNull();
  });

  it("trims what it finds", async () => {
    await expect(readSignedInAccessToken(host(async () => "  jwt  "))).resolves.toBe("jwt");
  });

  it.each([
    ["absent", async () => null],
    ["blank", async () => "   "],
    ["not a string", async () => 42],
  ])("reads %s storage as signed out", async (_label, result) => {
    await expect(readSignedInAccessToken(host(result))).resolves.toBeNull();
  });

  it("survives a page that refuses to run the read", async () => {
    await expect(
      readSignedInAccessToken(host(() => Promise.reject(new Error("navigation in progress")))),
    ).resolves.toBeNull();
  });
});

describe("toNotchPanelView", () => {
  const okOutcome: NotchActivityOutcome = {
    kind: "ok",
    activity: {
      workspaceCount: 2,
      partial: false,
      shareViews: { total: 1284, linkCount: 3, lastViewedAt: null },
      tokenSpend: {
        estimatedUsd: 12.5,
        totalTokens: 2_400_000,
        unpricedTokens: 0,
        since: "2026-07-17T00:00:00.000Z",
        until: "2026-08-16T00:00:00.000Z",
      },
    },
  };

  it("fills every slot the document draws", () => {
    const view = toNotchPanelView(okOutcome);

    for (const { key } of NOTCH_SLOTS) {
      expect(view[key].detail.length).toBeGreaterThan(0);
    }
  });

  it("shows the figures when there are figures", () => {
    const view = toNotchPanelView(okOutcome);

    expect(view.shareClicks.value).toBe("1,284");
    expect(view.tokenSpend.value).toBe("$12.50");
  });

  it("never renders a missing figure as a number", () => {
    const absent: NotchActivityOutcome[] = [
      { kind: "offline" },
      { kind: "signed-out" },
      { kind: "failed" },
      {
        kind: "ok",
        activity: { workspaceCount: 0, partial: false, shareViews: null, tokenSpend: null },
      },
    ];

    for (const outcome of absent) {
      const view = toNotchPanelView(outcome);
      expect(view.shareClicks.value).toBe(EM_DASH);
      expect(view.tokenSpend.value).toBe(EM_DASH);
      expect(view.shareClicks.note.length).toBeGreaterThan(0);
    }
  });

  it("gives each way of not knowing its own words", () => {
    const notes = (
      [
        { kind: "offline" },
        { kind: "signed-out" },
        { kind: "failed" },
        {
          kind: "ok",
          activity: { workspaceCount: 0, partial: false, shareViews: null, tokenSpend: null },
        },
      ] satisfies NotchActivityOutcome[]
    ).map((outcome) => toNotchPanelView(outcome).shareClicks.note);

    expect(new Set(notes).size).toBe(notes.length);
  });

  it("distinguishes a genuine zero from an unknown", () => {
    const zero = toNotchPanelView({
      kind: "ok",
      activity: {
        workspaceCount: 1,
        partial: false,
        shareViews: { total: 0, linkCount: 0, lastViewedAt: null },
        tokenSpend: {
          estimatedUsd: 0,
          totalTokens: 0,
          unpricedTokens: 0,
          since: null,
          until: null,
        },
      },
    });

    expect(zero.shareClicks.value).toBe("0");
    expect(zero.tokenSpend.value).toBe("$0.00");
  });

  it("marks a section the server could not read as unavailable, not empty", () => {
    const view = toNotchPanelView({
      kind: "ok",
      activity: { workspaceCount: 1, partial: false, shareViews: null, tokenSpend: null },
    });

    expect(view.shareClicks.value).toBe(EM_DASH);
    expect(view.shareClicks.note).toBe("unavailable");
    expect(view.tokenSpend.note).toBe("unavailable");
  });

  it("labels money as an estimate and says what the estimate ignores", () => {
    const view = toNotchPanelView(okOutcome);

    expect(view.tokenSpend.note).toBe("est.");
    expect(view.tokenSpend.detail).toMatch(/not a bill/i);
    expect(view.tokenSpend.detail).toMatch(/plan pricing/i);
    expect(view.tokenSpend.detail).toContain("over the last 30 days");
  });

  it("says so when unpriced models were left out", () => {
    const view = toNotchPanelView({
      kind: "ok",
      activity: {
        workspaceCount: 1,
        partial: false,
        shareViews: null,
        tokenSpend: {
          estimatedUsd: 4,
          totalTokens: 900,
          unpricedTokens: 400,
          since: null,
          until: null,
        },
      },
    });

    expect(view.tokenSpend.detail).toMatch(/no published rate/i);
  });

  it("admits when workspaces were skipped instead of quietly under-reporting", () => {
    const view = toNotchPanelView({
      kind: "ok",
      activity: {
        workspaceCount: 3,
        partial: true,
        shareViews: { total: 5, linkCount: 1, lastViewedAt: null },
        tokenSpend: null,
      },
    });

    expect(view.shareClicks.detail).toMatch(/floor/i);
  });

  it("keeps active syncs a dash in every state, because nothing reports it", () => {
    for (const outcome of [{ kind: "offline" } as const, okOutcome]) {
      const view = toNotchPanelView(outcome);
      expect(view.activeSyncs.value).toBe(EM_DASH);
      expect(view.activeSyncs.note).toBe("not wired");
    }
  });
});

describe("createNotchRefreshScheduler", () => {
  function harness(readView?: () => Promise<never>) {
    const applied: unknown[] = [];
    let tick: (() => void) | null = null;
    const cancelled: unknown[] = [];
    const view = toNotchPanelView({ kind: "offline" });
    const read = vi.fn(readView ?? (async () => view));

    const scheduler = createNotchRefreshScheduler({
      readView: read as unknown as () => Promise<typeof view>,
      apply: (next) => applied.push(next),
      intervalMs: 15_000,
      schedule: (handler) => {
        tick = handler;
        return "handle";
      },
      cancel: (handle) => cancelled.push(handle),
    });

    return { scheduler, read, applied, cancelled, fire: () => tick?.() };
  }

  it("does not schedule anything while the panel is collapsed", () => {
    const { scheduler, read, fire } = harness();

    scheduler.readOnce();
    fire();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads the moment it expands, then on the interval", async () => {
    const { scheduler, read, fire } = harness();

    scheduler.setExpanded(true);
    expect(read).toHaveBeenCalledTimes(1);

    await settle();
    fire();
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("stops asking the moment it collapses", () => {
    const { scheduler, read, cancelled, fire } = harness();

    scheduler.setExpanded(true);
    scheduler.setExpanded(false);
    fire();

    expect(cancelled).toEqual(["handle"]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps one request in flight at a time", () => {
    const { scheduler, read } = harness(() => new Promise<never>(() => {}));

    scheduler.setExpanded(true);
    scheduler.readOnce();
    scheduler.readOnce();

    expect(read).toHaveBeenCalledTimes(1);
  });

  it("hands the reading straight to the page", async () => {
    const { scheduler, applied } = harness();

    scheduler.readOnce();
    await settle();

    expect(applied).toHaveLength(1);
  });

  it("asks for nothing more once stopped", () => {
    const { scheduler, read, fire } = harness();

    scheduler.stop();
    scheduler.readOnce();
    scheduler.setExpanded(true);
    fire();

    expect(read).not.toHaveBeenCalled();
  });

  it("survives a reader that rejects", async () => {
    const { scheduler, read } = harness(() => Promise.reject(new Error("boom")));

    scheduler.readOnce();
    await settle();
    scheduler.readOnce();

    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("formatters", () => {
  it("keeps every digit where the digits are the point", () => {
    expect(formatCompactCount(1284)).toBe("1,284");
    expect(formatCompactCount(24_000)).toBe("24K");
    expect(formatCompactCount(2_400_000)).toBe("2.4M");
  });

  it("never rounds a real cost down to nothing", () => {
    expect(formatEstimatedCost(0)).toBe("$0.00");
    expect(formatEstimatedCost(0.004)).toBe("<$0.01");
    expect(formatEstimatedCost(12.5)).toBe("$12.50");
  });
});
