import { type EnvironmentId, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";

/**
 * Resolves the "real" thread a draft route should navigate to, once one
 * exists — see `_chat.draft.$draftId.tsx`.
 *
 * `promotedTo` and a discovered `serverThread` are both only ever populated
 * from a server-confirmed event (a live `thread.created`/`thread-upserted`
 * push, or a bootstrap/recovery sync that already found the thread) — never
 * optimistically, before the server has actually created anything. So either
 * one being present is already sufficient proof the thread exists; this used
 * to additionally require the *`promotedTo`* case to show the thread had
 * "started" (a user message, a session, or a turn), which the other case
 * never required for the same underlying guarantee.
 *
 * That extra bar mattered exactly once it stopped being free: `promotedTo`
 * lives in `composerDraftStore`, which persists to localStorage and so
 * rehydrates instantly on a page reload, while the thread's full record
 * (messages/session/turn, needed to satisfy "started") lives in the
 * in-memory `AppState` store and can only be repopulated by a fresh network
 * round trip after the reload. A reload landing in that gap kept the route on
 * `/draft/$draftId` — with `ChatView` still treating it as a local,
 * uncreated draft — even though the thread already existed on the server. If
 * the person then sent again from there, the composer would bundle
 * `bootstrap.createThread` for a thread id the server already had, tripping
 * its "already exists and cannot be created twice" invariant.
 *
 * Treating the two cases the same closes that gap: a promoted thread is
 * trusted as soon as it is known, regardless of which of the two sources
 * learned about it first.
 */
export function resolveCanonicalThreadRef(input: {
  readonly promotedTo: ScopedThreadRef | null | undefined;
  readonly serverThread:
    | { readonly environmentId: EnvironmentId; readonly id: ThreadId }
    | null
    | undefined;
}): ScopedThreadRef | null {
  if (input.promotedTo) {
    return input.promotedTo;
  }
  if (input.serverThread) {
    return { environmentId: input.serverThread.environmentId, threadId: input.serverThread.id };
  }
  return null;
}
