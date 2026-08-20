/**
 * What is in a file *right now* — a person, an agent, or both.
 *
 * The workspace already records that a file was touched and by whom. That is
 * history: it answers "who changed this", it never expires, and it is exactly
 * as true an hour later. Presence is the other question, and the useful one
 * while work is happening: is somebody in this file at this moment, and is the
 * thing in it a human hand or a turn about to rewrite the whole file.
 *
 * The distinction earns its keep because the advice differs. Two people in one
 * file is an ordinary collision and the answer is a branch each. An agent
 * writing a file a person has open is not a collision — the agent does not
 * merge, it replaces, and the person's unsaved buffer loses. That one is worth
 * interrupting somebody for; the other is not.
 *
 * Pure and total, and shared by the server and the browser on purpose. The
 * browser has to re-decide on every render — the answer is a function of *now*,
 * so a memoised or server-cached verdict is a claim that ages into a lie, and a
 * stale "someone is editing this" that never clears is worse than never having
 * said it. The server has to decide too, before it lets a turn start. One set
 * of rules, one place, or the two ends disagree about the same file.
 *
 * @module FilePresence
 */

/** A hand on a keyboard, or a turn running on somebody's behalf. */
export type FilePresenceKind = "person" | "agent";

export interface FilePresenceEntry {
  readonly path: string;
  /**
   * Whose presence this is. An agent has no account of its own, so an agent
   * entry carries the id of whoever asked for the turn — the same attribution
   * the file-touch marks use, so a person and their agent are never two
   * strangers.
   */
  readonly userId: string;
  readonly displayName: string;
  readonly kind: FilePresenceKind;
  /**
   * What is holding the presence: a thread for an agent, one browser page for a
   * person. Two turns by the same person are two agents in the file; two tabs
   * are still one person, which is why people are counted by `userId` below and
   * agents by this.
   */
  readonly sourceId: string;
  /** ISO-8601. The last heartbeat, not the first — presence is a live claim. */
  readonly refreshedAt: string;
}

/**
 * How long a claim outlives its last heartbeat.
 *
 * A person's browser can be closed, crash, or lose its socket without ever
 * saying goodbye, so their claim has to die on its own; three missed beats of a
 * fifteen-second heartbeat is short enough that a closed laptop stops warning
 * anybody within a minute.
 *
 * An agent gets longer because its heartbeat is not a timer but a consequence:
 * a turn refreshes its claim when it produces a diff, and a turn can think for
 * a while between writes. Expiring it on the person's clock would clear the
 * warning in the middle of the very turn it is warning about.
 */
export const PERSON_PRESENCE_TTL_MS = 45_000;
export const AGENT_PRESENCE_TTL_MS = 180_000;

export interface FilePresenceTtl {
  readonly personMs?: number;
  readonly agentMs?: number;
}

export function filePresenceTtlMs(kind: FilePresenceKind, ttl?: FilePresenceTtl): number {
  return kind === "agent"
    ? (ttl?.agentMs ?? AGENT_PRESENCE_TTL_MS)
    : (ttl?.personMs ?? PERSON_PRESENCE_TTL_MS);
}

/**
 * Whether a claim is still worth believing.
 *
 * A refresh timestamp in the future is treated as live rather than discarded:
 * the two ends are different machines and a second of clock skew must not make
 * a colleague vanish. It is only ever a claim about the recent past that is
 * being tested here.
 */
export function isFilePresenceLive(
  entry: FilePresenceEntry,
  nowMs: number,
  ttl?: FilePresenceTtl,
): boolean {
  const refreshedAt = Date.parse(entry.refreshedAt);
  if (Number.isNaN(refreshedAt)) {
    return false;
  }
  return nowMs - refreshedAt <= filePresenceTtlMs(entry.kind, ttl);
}

/** Everything still in a file, oldest claims dropped. */
export function liveFilePresence(
  entries: ReadonlyArray<FilePresenceEntry>,
  nowMs: number,
  ttl?: FilePresenceTtl,
): ReadonlyArray<FilePresenceEntry> {
  return entries.filter((entry) => isFilePresenceLive(entry, nowMs, ttl));
}

/**
 * What is in one file, reduced to the fact that changes what to say.
 *
 * `agent-over-person` deliberately does not care whether the person and the
 * agent are the same human. Your own turn overwriting your own unsaved buffer
 * is the commonest way this happens and loses just as much work as a
 * colleague's would.
 */
export type FilePresenceOutcome =
  /** Nobody, one person alone, or one agent alone. Nothing to say. */
  | "quiet"
  /** Two or more people, no agent. The ordinary collision. */
  | "people-collide"
  /** At least one agent and at least one person. The urgent one. */
  | "agent-over-person"
  /** Two or more separate turns, nobody watching. */
  | "agents-collide";

export type FilePresenceSeverity = "none" | "warn" | "urgent";

export interface FilePresenceOccupants {
  /** Distinct humans with the file open, most recently seen first. */
  readonly people: ReadonlyArray<FilePresenceEntry>;
  /** Distinct turns writing the file, most recently seen first. */
  readonly agents: ReadonlyArray<FilePresenceEntry>;
}

export interface FilePresenceVerdict extends FilePresenceOccupants {
  readonly path: string;
  readonly outcome: FilePresenceOutcome;
  readonly severity: FilePresenceSeverity;
  /** One line naming what is happening. Empty when the outcome is `quiet`. */
  readonly headline: string;
  /** What to do about it. Empty when the outcome is `quiet`. */
  readonly suggestion: string;
}

/** Most recent first, with a stable tiebreak so two ends order a file alike. */
function byFreshness(left: FilePresenceEntry, right: FilePresenceEntry): number {
  if (left.refreshedAt !== right.refreshedAt) {
    return left.refreshedAt < right.refreshedAt ? 1 : -1;
  }
  return left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0;
}

/** Keeps one entry per key, the freshest, so a heartbeat is not a second body. */
function dedupe(
  entries: ReadonlyArray<FilePresenceEntry>,
  keyOf: (entry: FilePresenceEntry) => string,
): ReadonlyArray<FilePresenceEntry> {
  const best = new Map<string, FilePresenceEntry>();
  for (const entry of entries) {
    const key = keyOf(entry);
    const existing = best.get(key);
    if (!existing || byFreshness(entry, existing) < 0) {
      best.set(key, entry);
    }
  }
  return [...best.values()].toSorted(byFreshness);
}

/**
 * Splits live claims into the two populations the decision turns on.
 *
 * People are counted per account and agents per turn, which is the asymmetry
 * that makes both counts mean something: one person with the file open in two
 * tabs is one person, and one person running two turns into the same file is
 * two writers racing each other.
 */
export function occupantsOfFile(entries: ReadonlyArray<FilePresenceEntry>): FilePresenceOccupants {
  return {
    people: dedupe(
      entries.filter((entry) => entry.kind === "person"),
      (entry) => entry.userId,
    ),
    agents: dedupe(
      entries.filter((entry) => entry.kind === "agent"),
      (entry) => entry.sourceId,
    ),
  };
}

function joinNames(entries: ReadonlyArray<FilePresenceEntry>): string {
  const names = [...new Set(entries.map((entry) => entry.displayName))];
  if (names.length <= 1) {
    return names[0] ?? "someone";
  }
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export interface DecideFilePresenceInput {
  readonly path: string;
  /** Every claim on this path, live or not; expiry is applied here. */
  readonly entries: ReadonlyArray<FilePresenceEntry>;
  readonly nowMs: number;
  readonly ttl?: FilePresenceTtl;
  /**
   * Whether the reader already has a branch of their own. It changes only the
   * people-collide suggestion, because a branch is the answer to that one and
   * is no answer at all to an agent overwriting an open buffer — the turn runs
   * in the same worktree the file is open in either way.
   */
  readonly viewerHasOwnBranch?: boolean;
}

/**
 * The whole rule, stated once.
 *
 * Order matters and is the point: an agent in the room outranks a crowd of
 * people, because losing unsaved work to a rewrite is worse and sooner than two
 * people editing around each other. A file with two people *and* an agent gets
 * the agent warning, not a branch suggestion.
 */
export function decideFilePresence(input: DecideFilePresenceInput): FilePresenceVerdict {
  const { people, agents } = occupantsOfFile(
    liveFilePresence(input.entries, input.nowMs, input.ttl).filter(
      (entry) => entry.path === input.path,
    ),
  );
  const base = { path: input.path, people, agents } as const;

  if (agents.length > 0 && people.length > 0) {
    return {
      ...base,
      outcome: "agent-over-person",
      severity: "urgent",
      headline: `${joinNames(agents)}'s agent is writing a file ${joinNames(people)} has open`,
      // Said as an instruction rather than an observation: this is the one case
      // where waiting costs somebody their work.
      suggestion:
        "An agent replaces a file rather than merging into it, so unsaved edits will be lost. Stop the turn, or save and close the file before it finishes.",
    };
  }

  if (agents.length > 1) {
    return {
      ...base,
      outcome: "agents-collide",
      severity: "warn",
      headline: `${agents.length} agent turns are writing the same file`,
      suggestion:
        "Whichever finishes last wins the whole file. Let one finish before starting the next, or run each on its own branch.",
    };
  }

  if (people.length > 1) {
    return {
      ...base,
      outcome: "people-collide",
      severity: "warn",
      headline: `${joinNames(people)} are in the same file`,
      suggestion: input.viewerHasOwnBranch
        ? "You are on your own branch, so your edits are not landing on top of theirs."
        : "Both sets of edits land in the same file, and the last one written wins. Your own branch keeps them apart until somebody merges.",
    };
  }

  return { ...base, outcome: "quiet", severity: "none", headline: "", suggestion: "" };
}

/**
 * Every file worth saying something about, worst first.
 *
 * `quiet` files are dropped rather than returned with an empty headline: a
 * caller that wants the occupants of a specific path asks `decideFilePresence`
 * for it, and a caller that wants a list wants only the list of problems.
 */
export function decideFilePresenceAcross(input: {
  readonly entries: ReadonlyArray<FilePresenceEntry>;
  readonly nowMs: number;
  readonly ttl?: FilePresenceTtl;
  readonly viewerHasOwnBranch?: boolean;
}): ReadonlyArray<FilePresenceVerdict> {
  const live = liveFilePresence(input.entries, input.nowMs, input.ttl);
  const paths = [...new Set(live.map((entry) => entry.path))];
  const verdicts = paths
    .map((path) =>
      decideFilePresence({
        path,
        entries: live,
        nowMs: input.nowMs,
        ...(input.ttl ? { ttl: input.ttl } : {}),
        ...(input.viewerHasOwnBranch === undefined
          ? {}
          : { viewerHasOwnBranch: input.viewerHasOwnBranch }),
      }),
    )
    .filter((verdict) => verdict.outcome !== "quiet");

  const rank: Record<FilePresenceSeverity, number> = { urgent: 0, warn: 1, none: 2 };
  return verdicts.toSorted((left, right) => {
    if (rank[left.severity] !== rank[right.severity]) {
      return rank[left.severity] - rank[right.severity];
    }
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  });
}

/**
 * What a person has open, right now, anywhere in the workspace.
 *
 * This is the question asked at the moment a turn is about to start, which is
 * the only moment a warning can still be acted on. It deliberately says nothing
 * about which files the turn will write: nothing in the model knows that before
 * the turn runs, and inventing a prediction would be worse than naming the real
 * risk, which is that somebody has unsaved work in this workspace at all.
 */
export function peopleHoldingFiles(input: {
  readonly entries: ReadonlyArray<FilePresenceEntry>;
  readonly nowMs: number;
  readonly ttl?: FilePresenceTtl;
}): ReadonlyArray<FilePresenceEntry> {
  return dedupe(
    liveFilePresence(input.entries, input.nowMs, input.ttl).filter(
      (entry) => entry.kind === "person",
    ),
    (entry) => `${entry.userId}:${entry.path}`,
  );
}
