import type { CollaborationMember, CollaborationPresence } from "@t3tools/contracts";

/**
 * The colour wheel a person is drawn with, anywhere in the app.
 *
 * It lives here rather than in the roster component because the usage report
 * needs the same eight: someone whose avatar is orange in the roster and green
 * in the leaderboard reads as two different people, which is the one thing a
 * colour is supposed to prevent.
 */
export const MEMBER_COLORS = [
  "hsl(4 74% 58%)",
  "hsl(28 82% 55%)",
  "hsl(45 85% 50%)",
  "hsl(142 55% 45%)",
  "hsl(190 70% 45%)",
  "hsl(215 80% 58%)",
  "hsl(265 65% 62%)",
  "hsl(320 60% 58%)",
] as const;

/**
 * Long enough to swallow a burst of heartbeats from several people at once,
 * short enough that somebody who has just joined shows up while they are still
 * looking at the panel.
 */
export const ROSTER_REFRESH_DEBOUNCE_MS = 1_500;

export interface RosterPresenceOutcome {
  readonly members: readonly CollaborationMember[];
  /**
   * Whether the roster already knew this person. When it did, the heartbeat is
   * not a roster change and there is nothing to ask the server for.
   */
  readonly isKnownMember: boolean;
}

/**
 * A presence heartbeat is not a roster change.
 *
 * Every participant emits one roughly every 30 seconds, so re-listing the
 * whole roster on each of them costs people x tabs requests a minute for an
 * answer that almost never differs. The event already carries the presence it
 * is announcing, so a known person's dot moves without a request; only an
 * unfamiliar person means the roster itself has actually moved.
 */
export function applyPresenceToRoster(
  members: readonly CollaborationMember[],
  presence: Pick<CollaborationPresence, "userId" | "status" | "lastSeenAt">,
): RosterPresenceOutcome {
  let isKnownMember = false;
  let changed = false;

  const next = members.map((member) => {
    if (member.userId !== presence.userId) {
      return member;
    }
    isKnownMember = true;
    if (member.status === presence.status && member.lastSeenAt === presence.lastSeenAt) {
      return member;
    }
    changed = true;
    return { ...member, status: presence.status, lastSeenAt: presence.lastSeenAt };
  });

  return { members: changed ? next : members, isKnownMember };
}
