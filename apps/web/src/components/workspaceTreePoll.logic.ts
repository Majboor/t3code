/**
 * Keeps the workspace tree from re-listing itself several times over.
 *
 * The tree has no server-side "give me everything on screen" call, so every
 * refresh fans out one `projects.listDirectory` per expanded folder. Four
 * separate things trigger that fan-out — the poll, the explicit refresh
 * button, a workspace or turn change, and every move of the working-tree diff
 * signature while an agent writes — and they overlap freely, so a dozen open
 * folders turn into bursts of a dozen requests several times a second.
 *
 * The gate is the same shape as the git status guard in
 * `lib/gitStatusState.ts`: drop a re-list already in flight, and drop one that
 * asks for a directory listed a moment ago.
 *
 * The durable fix is a single RPC returning the whole visible tree, which
 * would delete both the fan-out and this gate. That needs a change to the
 * `projects.listDirectory` contract, so until then this is the ceiling.
 */

/**
 * Two forced re-lists of the same folder closer together than this tell you
 * nothing the first one did not. Under the 15s poll interval, so the poll is
 * never the thing being suppressed, and high enough to be a real ceiling: with
 * a dozen folders open a live turn used to fan out 12 requests every time the
 * diff signature moved, which is as often as every 2s — 360/minute against a
 * budget of 120. Capped here at 12 per 8s.
 */
export const WORKSPACE_DIRECTORY_RELIST_MIN_INTERVAL_MS = 8_000;

export interface WorkspaceDirectoryRelistGate {
  /**
   * The subset of `keys` worth asking the server about, marked as in flight.
   * `immediate` is for a refresh someone pressed a button for: it still skips
   * what is in flight, but does not make them wait out the interval.
   */
  readonly claim: (
    keys: readonly string[],
    options: { readonly now: number; readonly immediate?: boolean },
  ) => readonly string[];
  readonly release: (keys: readonly string[]) => void;
}

export function createWorkspaceDirectoryRelistGate(options?: {
  minIntervalMs?: number;
}): WorkspaceDirectoryRelistGate {
  const minIntervalMs = options?.minIntervalMs ?? WORKSPACE_DIRECTORY_RELIST_MIN_INTERVAL_MS;
  const inFlight = new Set<string>();
  const claimedAtByKey = new Map<string, number>();

  return {
    claim: (keys, { now, immediate = false }) => {
      const claimed: string[] = [];
      for (const key of keys) {
        if (inFlight.has(key)) {
          continue;
        }
        const claimedAt = claimedAtByKey.get(key);
        if (!immediate && claimedAt !== undefined && now - claimedAt < minIntervalMs) {
          continue;
        }
        inFlight.add(key);
        claimedAtByKey.set(key, now);
        claimed.push(key);
      }
      return claimed;
    },
    release: (keys) => {
      for (const key of keys) {
        inFlight.delete(key);
      }
    },
  };
}
