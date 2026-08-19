import type { CloudSyncConflict, CloudSyncVisitorView, ProjectCloudSync } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CLOUD_SYNC_MODE_CHOICES,
  cloudSyncWaitBadgeLabel,
  describeActivelyChanging,
  describeCloudSyncFailure,
  describeCloudSyncHeadline,
  describeCloudSyncProgress,
  describeCloudSyncWait,
  deriveVisitorView,
  describeConflict,
  describeConflictCount,
  formatSyncBytes,
  readCloudSyncErrorCode,
  readCloudSyncModeChoice,
} from "./cloudSync.logic";

function makeSync(overrides: Partial<ProjectCloudSync> = {}): ProjectCloudSync {
  return {
    projectId: "project-1",
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    mode: "mirror",
    status: "idle",
    lastAgreedAt: null,
    lastError: null,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    activelyChanging: false,
    conflictCount: 0,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  } as ProjectCloudSync;
}

describe("mode wording", () => {
  it("offers exactly the two modes the contract has", () => {
    expect(CLOUD_SYNC_MODE_CHOICES.map((choice) => choice.mode)).toEqual(["handoff", "mirror"]);
  });

  it("warns that handoff stops watching the local folder without deleting it", () => {
    const handoff = readCloudSyncModeChoice("handoff");
    expect(handoff.consequence).toMatch(/left exactly as it is/i);
    expect(handoff.consequence).toMatch(/stops writing/i);
    expect(handoff.consequence).toMatch(/will not reach the cloud/i);
  });

  it("says in as many words that a mirror is not a backup", () => {
    const mirror = readCloudSyncModeChoice("mirror");
    expect(mirror.consequence).toContain("A mirror is not a backup");
    expect(mirror.consequence).toMatch(/deletes it in the cloud/i);
  });
});

describe("formatSyncBytes", () => {
  it("rounds whole bytes and never shows a misleading decimal below a kilobyte", () => {
    expect(formatSyncBytes(0)).toBe("0 B");
    expect(formatSyncBytes(512)).toBe("512 B");
  });

  it("climbs units with one decimal", () => {
    expect(formatSyncBytes(1024)).toBe("1.0 KB");
    expect(formatSyncBytes(1024 * 1024 * 1.5)).toBe("1.5 MB");
    expect(formatSyncBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("treats nonsense as nothing rather than rendering NaN", () => {
    expect(formatSyncBytes(Number.NaN)).toBe("0 B");
    expect(formatSyncBytes(-5)).toBe("0 B");
  });
});

describe("describeCloudSyncHeadline", () => {
  it("says a project nobody shared is not shared, rather than idle", () => {
    const headline = describeCloudSyncHeadline(null);
    expect(headline.label).toBe("Not shared");
    expect(headline.tone).toBe("idle");
  });

  it("separates scanning from transferring", () => {
    expect(describeCloudSyncHeadline(makeSync({ status: "scanning" })).label).toBe("Scanning");
    expect(describeCloudSyncHeadline(makeSync({ status: "transferring" })).label).toBe(
      "Transferring",
    );
  });

  it("never lets a paused mirror read as settled", () => {
    const paused = describeCloudSyncHeadline(makeSync({ status: "paused", mode: "mirror" }));
    expect(paused.tone).toBe("paused");
    expect(paused.detail).toMatch(/drift apart/i);
  });

  it("promises nothing was deleted when a pass errored", () => {
    const errored = describeCloudSyncHeadline(
      makeSync({ status: "error", lastError: "disk full" }),
    );
    expect(errored.tone).toBe("error");
    expect(errored.detail).toMatch(/nothing was deleted/i);
  });

  it("distinguishes idle-and-agreed from idle-and-never-run", () => {
    expect(
      describeCloudSyncHeadline(makeSync({ status: "idle", lastAgreedAt: "2026-08-01T00:00:00Z" }))
        .label,
    ).toBe("Up to date");
    expect(describeCloudSyncHeadline(makeSync({ status: "idle" })).label).toBe("Waiting to start");
  });
});

describe("describeCloudSyncProgress", () => {
  it("reports the current pass only and prefers bytes for the bar", () => {
    const progress = describeCloudSyncProgress(
      makeSync({ filesDone: 3, filesTotal: 10, bytesDone: 512, bytesTotal: 1024 }),
    );
    expect(progress.filesLabel).toBe("3 of 10 files");
    expect(progress.bytesLabel).toBe("512 B of 1.0 KB");
    expect(progress.percent).toBe(50);
    expect(progress.filesRemaining).toBe(7);
  });

  it("falls back to file counts when no byte total is known yet", () => {
    expect(describeCloudSyncProgress(makeSync({ filesDone: 1, filesTotal: 4 })).percent).toBe(25);
  });

  it("has no percentage at all when the pass has nothing to do", () => {
    expect(describeCloudSyncProgress(makeSync()).percent).toBeNull();
  });
});

describe("describeActivelyChanging", () => {
  it("is silent unless the watcher saw a write", () => {
    expect(describeActivelyChanging(makeSync())).toBeNull();
  });

  it("explains that a moving target is expected rather than stuck", () => {
    const line = describeActivelyChanging(makeSync({ activelyChanging: true }));
    expect(line).toMatch(/expected, not stuck/i);
  });
});

describe("conflicts", () => {
  const conflict = {
    id: "conflict-1",
    projectId: "project-1",
    path: "src/index.ts",
    conflictedCopyPath: "src/index (conflicted copy 2026-08-16).ts",
    detectedAt: "2026-08-16T00:00:00.000Z",
    resolvedAt: null,
  } as CloudSyncConflict;

  it("names both files, so the person knows where their version went", () => {
    const copy = describeConflict(conflict);
    expect(copy.explanation).toContain("src/index.ts");
    expect(copy.explanation).toContain("src/index (conflicted copy 2026-08-16).ts");
    expect(copy.explanation).toMatch(/kept both/i);
  });

  it("counts only what is waiting, and says nothing at zero", () => {
    expect(describeConflictCount(0)).toBeNull();
    expect(describeConflictCount(1)).toBe("1 file needs you");
    expect(describeConflictCount(4)).toBe("4 files need you");
  });
});

describe("describeCloudSyncFailure", () => {
  it("reads every code the contract defines", () => {
    expect(readCloudSyncErrorCode({ code: "mode-locked" })).toBe("mode-locked");
    expect(readCloudSyncErrorCode({ code: "storage" })).toBe("storage");
    expect(readCloudSyncErrorCode({ code: "nonsense" })).toBeNull();
    expect(readCloudSyncErrorCode(null)).toBeNull();
  });

  it("tells a non-member to ask somebody rather than to retry", () => {
    const notice = describeCloudSyncFailure({ code: "forbidden" }, { fallbackTitle: "x" });
    expect(notice.tone).toBe("error");
    expect(notice.description).toMatch(/not a member/i);
    expect(notice.refetch).toBe(false);
  });

  it("explains that changing mode means stop then start", () => {
    const notice = describeCloudSyncFailure({ code: "mode-locked" }, { fallbackTitle: "x" });
    expect(notice.description).toMatch(/stop it first/i);
    expect(notice.description).toMatch(/which copy is the real one/i);
  });

  it("keeps a stale conflict apart from an unsynced project", () => {
    const stale = describeCloudSyncFailure({ code: "conflict-not-found" }, { fallbackTitle: "x" });
    const missing = describeCloudSyncFailure({ code: "not-found" }, { fallbackTitle: "x" });
    expect(stale.title).not.toBe(missing.title);
    expect(missing.description).toMatch(/nobody has shared it/i);
  });

  it("refuses an address that would become a redirect somewhere else", () => {
    const notice = describeCloudSyncFailure({ code: "unusable-url" }, { fallbackTitle: "x" });
    expect(notice.description).toMatch(/https/i);
    expect(notice.description).toMatch(/nothing was published/i);
  });

  it("promises a storage refusal was not counted as synced", () => {
    const notice = describeCloudSyncFailure({ code: "storage" }, { fallbackTitle: "x" });
    expect(notice.description).toMatch(/nothing local was touched/i);
  });

  it("falls back to the caller's title when the error is not ours", () => {
    const notice = describeCloudSyncFailure(new Error("socket closed"), {
      fallbackTitle: "Could not start the sync",
    });
    expect(notice.title).toBe("Could not start the sync");
    expect(notice.description).toBe("socket closed");
  });
});

describe("deriveVisitorView", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");
  const fresh = "2026-08-16T11:59:50.000Z";
  const stale = "2026-08-16T11:50:00.000Z";

  it("lets an unsynced project run turns — it is simply a local project", () => {
    const view = deriveVisitorView(null, now);
    expect(view.state).toBe("not-syncing");
    expect(view.turnsAllowed).toBe(true);
  });

  it("unblocks the moment the two sides have agreed once, even mid-pass", () => {
    const view = deriveVisitorView(
      makeSync({
        status: "transferring",
        lastAgreedAt: "2026-08-15T00:00:00.000Z",
        updatedAt: fresh,
      }),
      now,
    );
    expect(view.state).toBe("synced");
    expect(view.turnsAllowed).toBe(true);
  });

  it("keeps a first pass that is still reporting in as a first pass", () => {
    const view = deriveVisitorView(makeSync({ status: "transferring", updatedAt: fresh }), now);
    expect(view.state).toBe("first-pass");
    expect(view.turnsAllowed).toBe(false);
  });

  it("does not degrade a paused first pass into a missing sharer", () => {
    // The contract is explicit: `sharer-away` is earned by a stopped heartbeat,
    // never guessed from a status that simply is not moving.
    expect(deriveVisitorView(makeSync({ status: "paused", updatedAt: fresh }), now).state).toBe(
      "first-pass",
    );
    expect(deriveVisitorView(makeSync({ status: "error", updatedAt: fresh }), now).state).toBe(
      "first-pass",
    );
  });

  it("calls the sharer away only once nothing has touched the sync for three heartbeats", () => {
    const view = deriveVisitorView(makeSync({ status: "transferring", updatedAt: stale }), now);
    expect(view.state).toBe("sharer-away");
    expect(view.turnsAllowed).toBe(false);
  });

  it("never invents a live copy it was not given an address for", () => {
    expect(deriveVisitorView(makeSync({ updatedAt: fresh }), now).liveCopy).toBeNull();
  });
});

describe("describeCloudSyncWait", () => {
  const view = (overrides: Partial<CloudSyncVisitorView>): CloudSyncVisitorView => ({
    state: "first-pass",
    sync: makeSync(),
    liveCopy: null,
    turnsAllowed: false,
    ...overrides,
  });

  it("takes turnsAllowed from the view rather than recomputing it", () => {
    // The contract states this rule once so that no client derives it wrongly.
    expect(describeCloudSyncWait(view({ state: "first-pass", turnsAllowed: true })).blocked).toBe(
      false,
    );
    expect(describeCloudSyncWait(view({ state: "synced", turnsAllowed: false })).blocked).toBe(
      true,
    );
  });

  it("counts the files left while the first upload is moving", () => {
    const wait = describeCloudSyncWait(
      view({ sync: makeSync({ status: "transferring", filesTotal: 12, filesDone: 9 }) }),
    );
    expect(wait.blocked).toBe(true);
    expect(wait.detail).toContain("3 files left to upload");
    expect(wait.detail).toMatch(/truncated file/i);
  });

  it("does not pretend to count files it has not finished scanning for", () => {
    const wait = describeCloudSyncWait(view({ sync: makeSync({ status: "scanning" }) }));
    expect(wait.detail).toMatch(/working out what to send/i);
  });

  it("gives the reason a first pass is not moving, without changing the state", () => {
    expect(describeCloudSyncWait(view({ sync: makeSync({ status: "paused" }) })).detail).toMatch(
      /resumed from the machine that shared it/i,
    );
    const errored = describeCloudSyncWait(
      view({ sync: makeSync({ status: "error", lastError: "disk full" }) }),
    );
    expect(errored.detail).toContain("disk full");
    expect(errored.detail).toMatch(/nothing was lost/i);
  });

  it("leads with the live copy rather than the progress bar when there is one", () => {
    const wait = describeCloudSyncWait(
      view({
        state: "first-pass-live",
        liveCopy: {
          url: "https://example.trycloudflare.com",
          confirmedAt: "2026-08-16T12:00:00.000Z",
          staleAfterMs: 90_000,
        } as CloudSyncVisitorView["liveCopy"],
      }),
    );
    expect(wait.title).toMatch(/you can work on the live copy now/i);
    expect(wait.liveCopyUrl).toBe("https://example.trycloudflare.com");
  });

  it("says the sharer closed their laptop only in the state that earned it", () => {
    const wait = describeCloudSyncWait(view({ state: "sharer-away" }));
    expect(wait.title).toMatch(/closed their laptop/i);
    expect(wait.detail).toMatch(/nothing was lost/i);
    expect(cloudSyncWaitBadgeLabel(wait)).toBe("Sharer away");
  });

  it("badges only the states a visitor has to act on", () => {
    expect(cloudSyncWaitBadgeLabel(describeCloudSyncWait(view({ state: "synced" })))).toBeNull();
    expect(
      cloudSyncWaitBadgeLabel(describeCloudSyncWait(view({ state: "not-syncing", sync: null }))),
    ).toBeNull();
    expect(cloudSyncWaitBadgeLabel(describeCloudSyncWait(view({})))).toBe("Uploading");
  });
});
