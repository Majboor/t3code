/**
 * Whether the provider-status banner is about the person reading it.
 *
 * The status it draws comes from the provider registry, which health-checks the
 * server's own global provider home — on a hosted box that is `/root/.codex`, a
 * path belonging to no user at all. Three credential locations exist per
 * install: the per-user default store, the per-project pinned copy that turns
 * actually resolve, and this global one, which only this banner reads.
 *
 * When the global one was unauthenticated every signed-in person saw a red
 * "provider is unavailable" over sessions that were working perfectly, and
 * nothing could clear it — it is a live value, so neither a successful turn nor
 * a hard reload dismissed it. Diagnosing that cost hours, twice, because the
 * banner names a problem the server has and the reader assumes it is theirs.
 */
export function shouldShowProviderStatus(input: {
  /** The process-wide registry verdict. */
  readonly status: "ready" | "warning" | "error" | "disabled";
  /**
   * How many accounts this viewer has connected, or null while the per-account
   * list is still loading — during which the global answer is all there is.
   */
  readonly viewerConnectedAccounts: number | null;
  /** The viewer has none of their own and a turn would be refused. */
  readonly noAccountForMe: boolean;
}): boolean {
  if (input.status === "disabled") {
    return false;
  }
  if (input.noAccountForMe) {
    return true;
  }
  if (input.status === "ready") {
    return false;
  }
  // Their own turns resolve their own account, so the global verdict is noise
  // to them. Somebody with nothing connected still sees it, because for them
  // the global home really is what a turn would fall back to.
  return input.viewerConnectedAccounts === null || input.viewerConnectedAccounts === 0;
}
