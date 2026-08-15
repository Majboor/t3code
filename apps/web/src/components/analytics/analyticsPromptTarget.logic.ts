/**
 * Which composer a prompt raised from the analytics page should land in.
 *
 * This page is not a thread, so a prompt written here has to be aimed at one.
 * The decision is separated from the component because it is the part with
 * cases: a project can have an unsent draft, or threads, or nothing at all, and
 * only the first two can be written into.
 *
 * @module components/analytics/analyticsPromptTarget.logic
 */
import { scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import type { DraftId } from "../../composerDraftStore";

export type AnalyticsPromptTarget =
  | { readonly kind: "draft"; readonly draftId: DraftId }
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "none" };

/**
 * An unsent draft beats a server thread. Somebody who has a half-written
 * message for this project is mid-thought, and starting a second place to type
 * would strand it. A draft is addressed by its own id, so it stands even before
 * this window knows which environment it is connected to.
 */
export function resolveAnalyticsPromptTarget(input: {
  readonly draftSession: { readonly draftId: DraftId } | null;
  readonly threadIds: ReadonlyArray<ThreadId>;
  readonly environmentId: EnvironmentId | null;
}): AnalyticsPromptTarget {
  const { draftSession, environmentId, threadIds } = input;

  if (draftSession !== null) {
    return { kind: "draft", draftId: draftSession.draftId };
  }

  // The store appends thread ids as it learns of them, so the last one is the
  // most recently opened — the thread somebody was working in.
  const threadId = threadIds[threadIds.length - 1];
  if (environmentId === null || threadId === undefined) {
    return { kind: "none" };
  }

  return { kind: "thread", threadRef: scopeThreadRef(environmentId, threadId) };
}
