import { describe, expect, it, vi } from "vitest";

import {
  defaultNotchContext,
  NOTCH_CONTEXT_PANELS,
  type NotchContext,
  resolveNotchContext,
} from "./notchContext.ts";
import {
  buildNotchActivityUrl,
  createNotchRefreshScheduler,
  type DesktopProjectActivity,
  formatCompactCount,
  formatElapsed,
  formatEstimatedCost,
  NOTCH_ACTIVITY_PATH,
  type NotchActivityOutcome,
  type NotchScriptHost,
  parseNotchActivityBody,
  pendingNotchPanelView,
  readNotchActivity,
  resolveNotchCredential,
  readSignedInAccessToken,
  toNotchPanelView,
} from "./notchData.ts";
import { EM_DASH, type NotchPanelView, type NotchSlotView } from "./notchPanelDocument.ts";

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
  project: null,
};

const APP = "http://127.0.0.1:3773/";
const deploymentContext = resolveNotchContext(`${APP}#/infra/proj_1`);
const analyticsContext = resolveNotchContext(`${APP}#/analytics/proj_1`);
const threadContext = resolveNotchContext(`${APP}#/env_1/thread_1`);
const draftContext = resolveNotchContext(`${APP}#/draft/draft_1`);

/** Rows are positional in the document but named here, so a test reads. */
function slot(view: NotchPanelView, label: string): NotchSlotView {
  const found = view.slots.find((candidate) => candidate.label === label);
  if (found === undefined) {
    throw new Error(`no slot labelled ${label} in ${JSON.stringify(view.slots)}`);
  }
  return found;
}

function projectOutcome(project: Partial<DesktopProjectActivity>): NotchActivityOutcome {
  return {
    kind: "ok",
    activity: {
      workspaceCount: 1,
      partial: false,
      shareViews: null,
      tokenSpend: null,
      project: {
        deploymentCount: 0,
        liveCount: 0,
        reportingCount: 0,
        streamCount: 0,
        events: null,
        reportedEvents: null,
        lastDeployAt: null,
        lastDeployStatus: null,
        partial: false,
        ...project,
      },
    },
  };
}

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

  it("names the project in the query when the panel is on a project's page", async () => {
    const fetchImpl = stubFetch(jsonResponse(okBody));

    await readNotchActivity({
      baseUrl: "http://127.0.0.1:3773",
      accessToken: "jwt",
      projectId: "proj 1/2",
      fetchImpl,
    });

    expect(vi.mocked(fetchImpl).mock.calls[0]?.[0]).toBe(
      `http://127.0.0.1:3773${NOTCH_ACTIVITY_PATH}?projectId=proj%201%2F2`,
    );
  });

  it("keeps a project this account cannot see apart from a broken server", async () => {
    await expect(
      readNotchActivity({
        baseUrl: "http://127.0.0.1:3773",
        accessToken: "jwt",
        projectId: "proj_1",
        fetchImpl: stubFetch(jsonResponse({ error: "Unknown project." }, 404)),
      }),
    ).resolves.toEqual({ kind: "unknown-project" });
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

describe("toNotchPanelView, account figures", () => {
  const account = defaultNotchContext;
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
      project: null,
    },
  };

  const emptyAccount: NotchActivityOutcome = {
    kind: "ok",
    activity: {
      workspaceCount: 0,
      partial: false,
      shareViews: null,
      tokenSpend: null,
      project: null,
    },
  };

  it("fills every slot the document draws", () => {
    const view = toNotchPanelView(account, okOutcome);

    for (const row of view.slots) {
      expect(row.detail.length).toBeGreaterThan(0);
      expect(row.label.length).toBeGreaterThan(0);
    }
  });

  it("shows the figures when there are figures", () => {
    const view = toNotchPanelView(account, okOutcome);

    expect(slot(view, "Share clicks").value).toBe("1,284");
    expect(slot(view, "Token spend").value).toBe("$12.50");
  });

  it("never renders a missing figure as a number", () => {
    const absent: NotchActivityOutcome[] = [
      { kind: "offline" },
      { kind: "signed-out" },
      { kind: "failed" },
      emptyAccount,
    ];

    for (const outcome of absent) {
      const view = toNotchPanelView(account, outcome);
      expect(slot(view, "Share clicks").value).toBe(EM_DASH);
      expect(slot(view, "Token spend").value).toBe(EM_DASH);
      expect(slot(view, "Share clicks").note.length).toBeGreaterThan(0);
    }
  });

  it("gives each way of not knowing its own words", () => {
    const notes = (
      [
        { kind: "offline" },
        { kind: "signed-out" },
        { kind: "failed" },
        { kind: "unknown-project" },
        emptyAccount,
      ] satisfies NotchActivityOutcome[]
    ).map((outcome) => slot(toNotchPanelView(account, outcome), "Share clicks").note);

    expect(new Set(notes).size).toBe(notes.length);
  });

  it("distinguishes a genuine zero from an unknown", () => {
    const zero = toNotchPanelView(account, {
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
        project: null,
      },
    });

    expect(slot(zero, "Share clicks").value).toBe("0");
    expect(slot(zero, "Token spend").value).toBe("$0.00");
  });

  it("marks a section the server could not read as unavailable, not empty", () => {
    const view = toNotchPanelView(account, {
      kind: "ok",
      activity: {
        workspaceCount: 1,
        partial: false,
        shareViews: null,
        tokenSpend: null,
        project: null,
      },
    });

    expect(slot(view, "Share clicks").value).toBe(EM_DASH);
    expect(slot(view, "Share clicks").note).toBe("unavailable");
    expect(slot(view, "Token spend").note).toBe("unavailable");
  });

  it("labels money as an estimate and says what the estimate ignores", () => {
    const spend = slot(toNotchPanelView(account, okOutcome), "Token spend");

    expect(spend.note).toBe("est.");
    expect(spend.detail).toMatch(/not a bill/i);
    expect(spend.detail).toMatch(/plan pricing/i);
    expect(spend.detail).toContain("over the last 30 days");
  });

  it("says so when unpriced models were left out", () => {
    const view = toNotchPanelView(account, {
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
        project: null,
      },
    });

    expect(slot(view, "Token spend").detail).toMatch(/no published rate/i);
  });

  it("admits when workspaces were skipped instead of quietly under-reporting", () => {
    const view = toNotchPanelView(account, {
      kind: "ok",
      activity: {
        workspaceCount: 3,
        partial: true,
        shareViews: { total: 5, linkCount: 1, lastViewedAt: null },
        tokenSpend: null,
        project: null,
      },
    });

    expect(slot(view, "Share clicks").detail).toMatch(/floor/i);
  });

  it("keeps active syncs a dash in every state, because nothing reports it", () => {
    for (const outcome of [{ kind: "offline" } as const, okOutcome]) {
      const syncs = slot(toNotchPanelView(account, outcome), "Active syncs");
      expect(syncs.value).toBe(EM_DASH);
      expect(syncs.note).toBe("not wired");
    }
  });
});

describe("toNotchPanelView, per context", () => {
  const contexts: NotchContext[] = [
    defaultNotchContext,
    deploymentContext,
    analyticsContext,
    threadContext,
  ];

  it("draws the same number of rows whatever page the app is on", () => {
    for (const context of contexts) {
      const view = toNotchPanelView(context, { kind: "offline" });
      expect(view.slots).toHaveLength(NOTCH_CONTEXT_PANELS.default.slots.length);
    }
  });

  it("labels every row from the context, so no figure is drawn under another's name", () => {
    for (const context of contexts) {
      const view = toNotchPanelView(context, { kind: "offline" });
      expect(view.slots.map((row) => row.label)).toEqual(
        NOTCH_CONTEXT_PANELS[context.kind].slots.map((definition) => definition.label),
      );
      expect(view.title).toBe(NOTCH_CONTEXT_PANELS[context.kind].title);
    }
  });

  it("says the server is off in every context rather than only the default one", () => {
    for (const context of contexts) {
      const view = toNotchPanelView(context, { kind: "offline" });
      const serverBacked = view.slots.filter((row) => row.note === "server off");
      expect(serverBacked.length).toBeGreaterThan(0);
    }
  });

  it("starts a context's rows blank rather than carrying the last page's numbers", () => {
    const pending = pendingNotchPanelView(analyticsContext);

    expect(pending.title).toBe(NOTCH_CONTEXT_PANELS.analytics.title);
    for (const row of pending.slots) {
      expect(row.value).toBe(EM_DASH);
      expect(row.detail).toBe("Not read yet.");
    }
    expect(pending.action).toBeNull();
  });
});

describe("toNotchPanelView, the one state with a next step", () => {
  const contexts: NotchContext[] = [
    defaultNotchContext,
    deploymentContext,
    analyticsContext,
    threadContext,
  ];

  it("offers sign-in wherever the app is, because the account is not per page", () => {
    for (const context of contexts) {
      expect(toNotchPanelView(context, { kind: "signed-out" }).action).toBe("sign-in");
    }
  });

  /*
   * A button that leads nowhere is worse than a dash. None of these are fixed
   * by clicking: the server is not answering, the read failed, the project
   * belongs to somebody else, or there is genuinely nothing yet.
   */
  it.each([
    ["server off", { kind: "offline" }],
    ["unavailable", { kind: "failed" }],
    ["unknown project", { kind: "unknown-project" }],
  ] as const)("offers nothing to press when the state is %s", (_name, outcome) => {
    for (const context of contexts) {
      expect(toNotchPanelView(context, outcome).action).toBeNull();
    }
  });

  it("offers nothing to press once a reading lands, workspace or not", () => {
    const withWorkspace: NotchActivityOutcome = {
      kind: "ok",
      activity: {
        workspaceCount: 2,
        partial: false,
        shareViews: { total: 3, linkCount: 1, lastViewedAt: null },
        tokenSpend: null,
        project: null,
      },
    };
    const withoutWorkspace: NotchActivityOutcome = {
      kind: "ok",
      activity: {
        workspaceCount: 0,
        partial: false,
        shareViews: null,
        tokenSpend: null,
        project: null,
      },
    };

    expect(toNotchPanelView(defaultNotchContext, withWorkspace).action).toBeNull();
    expect(toNotchPanelView(defaultNotchContext, withoutWorkspace).action).toBeNull();
  });

  /*
   * The rows are still built and still carry their reasons. The button replaces
   * what the panel draws, not what it knows, so the distinction the panel exists
   * for survives a state that happens to have a next step.
   */
  it("keeps the signed-out rows honest underneath the button", () => {
    const view = toNotchPanelView(defaultNotchContext, { kind: "signed-out" });

    expect(slot(view, "Share clicks").value).toBe(EM_DASH);
    expect(slot(view, "Share clicks").note).toBe("sign in");
    expect(slot(view, "Token spend").note).toBe("sign in");
  });
});

describe("toNotchPanelView, deployment", () => {
  it("counts what is live against what is registered", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({ deploymentCount: 3, liveCount: 2 }),
    );

    expect(slot(view, "Live").value).toBe("2");
    expect(slot(view, "Live").note).toBe("of 3 deployments");
    // The registry was told this; nothing probed it, and the tooltip has to say so.
    expect(slot(view, "Live").detail).toMatch(/not a probe/i);
  });

  it("reports a project with nothing deployed as a real zero", () => {
    const view = toNotchPanelView(deploymentContext, projectOutcome({ deploymentCount: 0 }));

    expect(slot(view, "Live").value).toBe("0");
    expect(slot(view, "Live").note).toBe("none registered");
  });

  it("refuses to call unmeasurable traffic zero", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({ deploymentCount: 2, liveCount: 2, reportingCount: 0 }),
    );

    expect(slot(view, "Traffic").value).toBe(EM_DASH);
    expect(slot(view, "Traffic").note).toBe("not wired");
  });

  it("keeps a failed count apart from a deployment that cannot report", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({ deploymentCount: 1, reportingCount: 1, reportedEvents: null }),
    );

    expect(slot(view, "Traffic").note).toBe("unavailable");
  });

  it("shows a stream that genuinely saw nothing as zero", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({ deploymentCount: 1, reportingCount: 1, reportedEvents: 0, streamCount: 1 }),
    );

    expect(slot(view, "Traffic").value).toBe("0");
    expect(slot(view, "Traffic").note).toBe("");
  });

  it("calls a floor a floor when a stream was skipped", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({
        deploymentCount: 1,
        reportingCount: 1,
        reportedEvents: 40,
        streamCount: 2,
        partial: true,
      }),
    );

    expect(slot(view, "Traffic").note).toBe("floor");
  });

  it("says no deploy was ever run instead of showing an epoch", () => {
    const view = toNotchPanelView(deploymentContext, projectOutcome({ deploymentCount: 1 }));

    expect(slot(view, "Last deploy").value).toBe(EM_DASH);
    expect(slot(view, "Last deploy").note).toBe("never");
  });

  it("carries the run's outcome beside how long ago it was", () => {
    const view = toNotchPanelView(
      deploymentContext,
      projectOutcome({
        deploymentCount: 1,
        lastDeployAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastDeployStatus: "succeeded",
      }),
    );

    expect(slot(view, "Last deploy").value).toBe("3h ago");
    expect(slot(view, "Last deploy").note).toBe("succeeded");
  });

  it("blames neither the project nor the server when the page names one we cannot see", () => {
    const view = toNotchPanelView(deploymentContext, { kind: "unknown-project" });

    for (const row of view.slots) {
      expect(row.value).toBe(EM_DASH);
      expect(row.note).toBe("unknown project");
    }
  });
});

describe("toNotchPanelView, analytics", () => {
  it("counts declared streams, and says when none are", () => {
    expect(slot(toNotchPanelView(analyticsContext, projectOutcome({})), "Streams").note).toBe(
      "none declared",
    );
    expect(
      slot(toNotchPanelView(analyticsContext, projectOutcome({ streamCount: 4 })), "Streams").value,
    ).toBe("4");
  });

  it("will not count events for streams that do not exist", () => {
    const view = toNotchPanelView(analyticsContext, projectOutcome({ streamCount: 0 }));

    expect(slot(view, "Events").value).toBe(EM_DASH);
    expect(slot(view, "Events").note).toBe("no streams");
  });

  it("keeps a stream that saw nothing apart from one nobody could count", () => {
    const real = toNotchPanelView(analyticsContext, projectOutcome({ streamCount: 1, events: 0 }));
    const unknown = toNotchPanelView(
      analyticsContext,
      projectOutcome({ streamCount: 1, events: null }),
    );

    expect(slot(real, "Events").value).toBe("0");
    expect(slot(unknown, "Events").value).toBe(EM_DASH);
    expect(slot(unknown, "Events").note).toBe("unavailable");
  });

  it("names the deployments that are blind spots", () => {
    const view = toNotchPanelView(
      analyticsContext,
      projectOutcome({ deploymentCount: 3, reportingCount: 1, streamCount: 2 }),
    );

    expect(slot(view, "Reporting").value).toBe("1");
    expect(slot(view, "Reporting").detail).toMatch(/other 2 cannot report/i);
  });
});

describe("toNotchPanelView, prompting", () => {
  it("says what the route says and no more", () => {
    expect(slot(toNotchPanelView(threadContext, { kind: "offline" }), "Thread").value).toBe("open");
    expect(slot(toNotchPanelView(draftContext, { kind: "offline" }), "Thread").value).toBe("draft");
  });

  /*
   * The point of the whole context: main can see the URL, not the thread. A
   * running spinner here would be a drawing of something nobody measured.
   */
  it("never claims to see a turn it cannot see", () => {
    for (const outcome of [
      { kind: "offline" } as const,
      { kind: "signed-out" } as const,
      projectOutcome({ deploymentCount: 9 }),
    ]) {
      const view = toNotchPanelView(threadContext, outcome);
      expect(slot(view, "Turn").value).toBe(EM_DASH);
      expect(slot(view, "Turn").note).toBe("not visible");
    }
  });

  it("still shows what the account has spent, which is the real figure it has", () => {
    const view = toNotchPanelView(threadContext, {
      kind: "ok",
      activity: {
        workspaceCount: 1,
        partial: false,
        shareViews: null,
        tokenSpend: {
          estimatedUsd: 3.25,
          totalTokens: 1000,
          unpricedTokens: 0,
          since: null,
          until: null,
        },
        project: null,
      },
    });

    expect(slot(view, "Token spend").value).toBe("$3.25");
  });
});

describe("buildNotchActivityUrl", () => {
  it("asks about the account when no project was named", () => {
    expect(buildNotchActivityUrl("http://host")).toBe(`http://host${NOTCH_ACTIVITY_PATH}`);
    expect(buildNotchActivityUrl("http://host", null)).toBe(`http://host${NOTCH_ACTIVITY_PATH}`);
    expect(buildNotchActivityUrl("http://host", "")).toBe(`http://host${NOTCH_ACTIVITY_PATH}`);
  });

  it("escapes the id rather than pasting it in", () => {
    expect(buildNotchActivityUrl("http://host", "a&b")).toBe(
      `http://host${NOTCH_ACTIVITY_PATH}?projectId=a%26b`,
    );
  });
});

describe("formatElapsed", () => {
  const now = Date.parse("2026-08-19T12:00:00.000Z");

  it("answers the question a glance is asking", () => {
    expect(formatElapsed("2026-08-19T11:58:00.000Z", now)).toBe("2m ago");
    expect(formatElapsed("2026-08-19T09:00:00.000Z", now)).toBe("3h ago");
    expect(formatElapsed("2026-08-17T12:00:00.000Z", now)).toBe("2d ago");
  });

  it("does not look into the future when the clocks disagree", () => {
    expect(formatElapsed("2026-08-19T12:05:00.000Z", now)).toBe("just now");
  });

  it("is a dash rather than an epoch when the date will not parse", () => {
    expect(formatElapsed("not a date", now)).toBe(EM_DASH);
  });
});

describe("createNotchRefreshScheduler", () => {
  function harness(readView?: () => Promise<never>) {
    const applied: unknown[] = [];
    let tick: (() => void) | null = null;
    const cancelled: unknown[] = [];
    const view = toNotchPanelView(defaultNotchContext, { kind: "offline" });
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

/**
 * The desktop owner signs in locally and never receives a Supabase token, so a
 * panel that only looked for one told a signed-in person they were signed out
 * and offered them a button whose only act was to raise a window already in
 * front of them.
 */
describe("resolveNotchCredential", () => {
  it("prefers a bearer token when there is one", () => {
    expect(resolveNotchCredential({ accessToken: "abc", sessionCookie: "t3_session=x" })).toEqual({
      authorization: "Bearer abc",
    });
  });

  it("falls back to the session cookie a local sign-in leaves behind", () => {
    expect(resolveNotchCredential({ accessToken: null, sessionCookie: "t3_session=x" })).toEqual({
      cookie: "t3_session=x",
    });
  });

  it("treats blank as absent, so a stray empty string is not a credential", () => {
    expect(resolveNotchCredential({ accessToken: "   ", sessionCookie: "  " })).toBeNull();
    expect(resolveNotchCredential({ accessToken: null, sessionCookie: null })).toBeNull();
  });
});

describe("readNotchActivity with only a cookie", () => {
  it("asks the server rather than reporting signed-out", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ signedIn: true, workspaceCount: 1, shareClicks: 2, tokenSpendUsd: 0 }),
          { status: 200 },
        ),
    ) as unknown as typeof globalThis.fetch;

    const outcome = await readNotchActivity({
      baseUrl: "http://127.0.0.1:3773",
      accessToken: null,
      sessionCookie: "t3_session_3773=abc",
      fetchImpl,
    });

    expect(outcome.kind).not.toBe("signed-out");
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect((call?.[1] as { headers: Record<string, string> }).headers).toEqual({
      cookie: "t3_session_3773=abc",
    });
  });

  it("still reports signed-out when it holds neither", async () => {
    const outcome = await readNotchActivity({
      baseUrl: "http://127.0.0.1:3773",
      accessToken: null,
      sessionCookie: null,
    });
    expect(outcome.kind).toBe("signed-out");
  });
});
