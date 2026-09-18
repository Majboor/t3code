import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { resolveCanonicalThreadRef } from "./draftThreadPromotion.logic";

const environmentId = "environment-1" as EnvironmentId;
const otherEnvironmentId = "environment-2" as EnvironmentId;
const threadId = "thread-1" as ThreadId;

describe("resolveCanonicalThreadRef", () => {
  it("returns null when nothing has confirmed the thread exists yet", () => {
    expect(resolveCanonicalThreadRef({ promotedTo: null, serverThread: null })).toBeNull();
  });

  // Regression test for the reported "Thread already exists and cannot be
  // created twice" invariant failure: `promotedTo` (persisted, and so
  // available instantly after a reload) used to also require the thread's
  // full in-memory record to show it had "started" before being trusted.
  // That in-memory record can only be repopulated by a fresh network round
  // trip after a reload, so a reload landing in that gap left the draft
  // route rendering the thread as an uncreated local draft — even though
  // `promotedTo` already proved the server had created it — and a resend
  // from there re-issued `bootstrap.createThread` for an id the server
  // already had.
  it("trusts promotedTo on its own, without requiring the thread's full record to have caught up", () => {
    const promotedTo = { environmentId, threadId };

    expect(resolveCanonicalThreadRef({ promotedTo, serverThread: null })).toEqual(promotedTo);
  });

  it("prefers promotedTo over a discovered server thread when both are present", () => {
    const promotedTo = { environmentId, threadId };

    expect(
      resolveCanonicalThreadRef({
        promotedTo,
        serverThread: { environmentId: otherEnvironmentId, id: threadId },
      }),
    ).toEqual(promotedTo);
  });

  it("falls back to a discovered server thread when nothing has been marked promoted", () => {
    expect(
      resolveCanonicalThreadRef({
        promotedTo: null,
        serverThread: { environmentId, id: threadId },
      }),
    ).toEqual({ environmentId, threadId });
  });

  it("treats an undefined promotedTo the same as null", () => {
    expect(
      resolveCanonicalThreadRef({
        promotedTo: undefined,
        serverThread: { environmentId, id: threadId },
      }),
    ).toEqual({ environmentId, threadId });
  });
});
