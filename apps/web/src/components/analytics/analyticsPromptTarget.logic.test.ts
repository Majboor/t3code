import { describe, expect, it } from "vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { DraftId } from "../../composerDraftStore";
import { resolveAnalyticsPromptTarget } from "./analyticsPromptTarget.logic";

const environmentId = EnvironmentId.make("env-1");

describe("resolveAnalyticsPromptTarget", () => {
  it("writes into an unsent draft rather than a thread, so nothing half-written is stranded", () => {
    const target = resolveAnalyticsPromptTarget({
      draftSession: { draftId: DraftId.make("draft-1") },
      threadIds: [ThreadId.make("thread-1")],
      environmentId,
    });

    expect(target).toEqual({ kind: "draft", draftId: "draft-1" });
  });

  it("takes the draft even before the window knows its environment", () => {
    const target = resolveAnalyticsPromptTarget({
      draftSession: { draftId: DraftId.make("draft-1") },
      threadIds: [],
      environmentId: null,
    });

    expect(target).toEqual({ kind: "draft", draftId: "draft-1" });
  });

  it("falls back to the project's thread when there is no draft", () => {
    const target = resolveAnalyticsPromptTarget({
      draftSession: null,
      threadIds: [ThreadId.make("thread-1")],
      environmentId,
    });

    expect(target).toEqual({
      kind: "thread",
      threadRef: { environmentId: "env-1", threadId: "thread-1" },
    });
  });

  it("takes the last thread it learned of when a project has several", () => {
    const target = resolveAnalyticsPromptTarget({
      draftSession: null,
      threadIds: [ThreadId.make("thread-1"), ThreadId.make("thread-2"), ThreadId.make("thread-3")],
      environmentId,
    });

    expect(target).toEqual({
      kind: "thread",
      threadRef: { environmentId: "env-1", threadId: "thread-3" },
    });
  });

  it("has nowhere to write when the project has neither a draft nor a thread", () => {
    expect(
      resolveAnalyticsPromptTarget({ draftSession: null, threadIds: [], environmentId }),
    ).toEqual({ kind: "none" });
  });

  it("cannot aim at a thread without an environment, because the ref would be half an address", () => {
    expect(
      resolveAnalyticsPromptTarget({
        draftSession: null,
        threadIds: [ThreadId.make("thread-1")],
        environmentId: null,
      }),
    ).toEqual({ kind: "none" });
  });
});
