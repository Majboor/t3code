import type { CollaborationFileTouch } from "@t3tools/contracts";
import {
  decideFilePresenceAcross,
  type FilePresenceEntry,
  type FilePresenceOutcome,
  type FilePresenceSeverity,
} from "@t3tools/shared/filePresence";

/**
 * Two people working on the same file at the same time.
 *
 * The workspace already records who last touched each path, but reducing to
 * "last" is exactly what throws this away: the interesting fact is that two
 * people touched it, and the last writer is the one least likely to notice.
 * Nothing here prevents anything — the file is shared and both writes land.
 * What it can do is say so while both are still working, which is the only
 * moment the information is worth having.
 */
export interface FileContention {
  readonly path: string;
  /** Everyone who touched it inside the window, most recent first. */
  readonly people: ReadonlyArray<{ userId: string; displayName: string; touchedAt: string }>;
}

/** Long enough to catch two people in one sitting, short enough that yesterday does not count. */
export const CONTENTION_WINDOW_MS = 15 * 60 * 1000;

export function findContention(
  touches: ReadonlyArray<CollaborationFileTouch>,
  options: { readonly now: number; readonly windowMs?: number },
): ReadonlyArray<FileContention> {
  const windowMs = options.windowMs ?? CONTENTION_WINDOW_MS;
  const byPath = new Map<
    string,
    Map<string, { userId: string; displayName: string; touchedAt: string }>
  >();

  for (const touch of touches) {
    const touchedAt = Date.parse(touch.touchedAt);
    if (Number.isNaN(touchedAt) || options.now - touchedAt > windowMs) continue;

    const people = byPath.get(touch.path) ?? new Map();
    const existing = people.get(touch.userId);
    // One person touching a file ten times is one person, and the most recent
    // time is the one worth showing.
    if (!existing || existing.touchedAt < touch.touchedAt) {
      people.set(touch.userId, {
        userId: touch.userId,
        displayName: touch.displayName,
        touchedAt: touch.touchedAt,
      });
    }
    byPath.set(touch.path, people);
  }

  const contested: FileContention[] = [];
  for (const [path, people] of byPath) {
    if (people.size < 2) continue;
    contested.push({
      path,
      people: [...people.values()].toSorted((left, right) =>
        left.touchedAt < right.touchedAt ? 1 : -1,
      ),
    });
  }

  // Most recently contested first: that is the one somebody is still typing in.
  return contested.toSorted((left, right) =>
    (left.people[0]?.touchedAt ?? "") < (right.people[0]?.touchedAt ?? "") ? 1 : -1,
  );
}

/**
 * One row of "somebody else is in here", from either of the two things that can
 * say so.
 *
 * `live` rows come from presence — what is in the file at this moment — and are
 * the only ones that can tell a person from an agent. `recent` rows come from
 * the touch history above, which knows that two people were both in a file
 * lately but not whether either is still there, and cannot tell whose hand
 * wrote it. Keeping the two apart in the type is deliberate: collapsing them
 * would turn "we cannot know" into "nobody is there", which is the failure this
 * whole feature exists to stop repeating.
 */
export interface WorkspaceContention {
  readonly path: string;
  readonly source: "live" | "recent";
  readonly severity: FilePresenceSeverity;
  readonly outcome: FilePresenceOutcome | "recent-touches";
  readonly headline: string;
  readonly suggestion: string;
  readonly names: ReadonlyArray<string>;
}

/**
 * Everything worth warning about in one workspace, worst first.
 *
 * Presence wins wherever both have an opinion about a file. A file an agent is
 * writing into while somebody has it open is not "two people edited this
 * lately"; it is a rewrite about to land on an open buffer, and the older,
 * vaguer sentence must not be the one shown.
 */
export function findWorkspaceContention(input: {
  readonly touches: ReadonlyArray<CollaborationFileTouch>;
  readonly presence: ReadonlyArray<FilePresenceEntry>;
  readonly nowMs: number;
  readonly viewerHasOwnBranch?: boolean;
  readonly windowMs?: number;
}): ReadonlyArray<WorkspaceContention> {
  const live = decideFilePresenceAcross({
    entries: input.presence,
    nowMs: input.nowMs,
    ...(input.viewerHasOwnBranch === undefined
      ? {}
      : { viewerHasOwnBranch: input.viewerHasOwnBranch }),
  }).map(
    (verdict): WorkspaceContention => ({
      path: verdict.path,
      source: "live",
      severity: verdict.severity,
      outcome: verdict.outcome,
      headline: verdict.headline,
      suggestion: verdict.suggestion,
      names: [...new Set([...verdict.agents, ...verdict.people].map((entry) => entry.displayName))],
    }),
  );

  const spokenFor = new Set(live.map((entry) => entry.path));
  const recent = findContention(input.touches, {
    now: input.nowMs,
    ...(input.windowMs === undefined ? {} : { windowMs: input.windowMs }),
  })
    .filter((entry) => !spokenFor.has(entry.path))
    .map((entry): WorkspaceContention => {
      const names = entry.people.map((person) => person.displayName);
      return {
        path: entry.path,
        source: "recent",
        severity: "warn",
        outcome: "recent-touches",
        headline: `${names.join(" and ")} both changed this file recently`,
        // Said as history, because that is all a touch is. Nothing here knows
        // whether either of them still has the file open, and a file changed by
        // a script outside the app carries no author at all — so this deliberately
        // stops short of claiming anybody is in it now.
        suggestion: input.viewerHasOwnBranch
          ? "You are on your own branch, so your edits are not landing on top of theirs."
          : "Both sets of edits land in the same file, and the last one written wins. Your own branch keeps them apart until somebody merges.",
        names,
      };
    });

  const rank: Record<FilePresenceSeverity, number> = { urgent: 0, warn: 1, none: 2 };
  return [...live, ...recent].toSorted((left, right) => {
    if (rank[left.severity] !== rank[right.severity]) {
      return rank[left.severity] - rank[right.severity];
    }
    // Live before recent at equal severity: one of them is happening now.
    if (left.source !== right.source) {
      return left.source === "live" ? -1 : 1;
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}
