import type { CollaborationFileTouch } from "@t3tools/contracts";

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
  const byPath = new Map<string, Map<string, { userId: string; displayName: string; touchedAt: string }>>();

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
