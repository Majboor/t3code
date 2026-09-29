import { describe, expect, it } from "vitest";

import { appendActivity } from "./Layers/CollaborationService.ts";

type State = Parameters<typeof appendActivity>[0];
type Activity = Parameters<typeof appendActivity>[1];

const activityFor = (tenantId: string, summary: string): Activity =>
  ({
    id: `activity:${tenantId}:${summary}`,
    tenantId,
    workspaceId: null,
    threadId: null,
    userId: "user-1",
    kind: "accepted-invite",
    hiddenAt: null,
    summary,
    createdAt: "2026-01-01T00:00:00.000Z",
  }) as unknown as Activity;

const emptyState = { activities: [] } as unknown as State;

describe("appendActivity", () => {
  // The cap used to be the newest 999 rows on the whole instance, whoever they
  // belonged to — and persistence rewrites the table from this state, so a busy
  // workspace did not merely crowd another tenant out of memory, it deleted
  // their audit trail from disk with activity they cannot see and did not cause.
  it("does not let one tenant's activity evict another tenant's", () => {
    let state = appendActivity(emptyState, activityFor("tenant-quiet", "the quiet tenant was here"));

    for (let index = 0; index < 2_000; index += 1) {
      state = appendActivity(state, activityFor("tenant-noisy", `noise-${index}`));
    }

    expect(
      state.activities.some((entry) => entry.summary === "the quiet tenant was here"),
    ).toBe(true);
  });

  it("still bounds a single tenant", () => {
    let state = emptyState;
    for (let index = 0; index < 2_000; index += 1) {
      state = appendActivity(state, activityFor("tenant-noisy", `noise-${index}`));
    }

    const own = state.activities.filter((entry) => entry.tenantId === "tenant-noisy");
    expect(own.length).toBeLessThanOrEqual(200);
    // Newest kept, oldest dropped.
    expect(own.at(-1)?.summary).toBe("noise-1999");
  });

  it("keeps a hard ceiling across many tenants", () => {
    let state = emptyState;
    for (let tenant = 0; tenant < 200; tenant += 1) {
      for (let index = 0; index < 100; index += 1) {
        state = appendActivity(state, activityFor(`tenant-${tenant}`, `row-${index}`));
      }
    }
    expect(state.activities.length).toBeLessThanOrEqual(10_000);
  });
});
