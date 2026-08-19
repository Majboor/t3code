import {
  isLiveCopyFresh,
  type CloudSyncConflict,
  type CloudSyncError,
  type CloudSyncMode,
  type CloudSyncVisitorState,
  type CloudSyncVisitorView,
  type ProjectCloudSync,
} from "@t3tools/contracts";

import { formatRelativeTimeLabel } from "../../timestampFormat";

/**
 * Everything the cloud-sync UI decides without asking a server.
 *
 * The wording is the feature. `docs/cloud-sync-spec.md` makes one promise — a
 * sync never destroys work — and the two ways a person can still lose a file
 * are both wording failures rather than mechanism failures: choosing `handoff`
 * without knowing the laptop stops being watched, and choosing `mirror`
 * believing it is a backup. Both sentences live here, once, and are asserted in
 * the tests beside this file so a tidy-up cannot quietly soften them.
 */

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const BYTES_PER_UNIT = 1024;

/**
 * Sizes for a progress line, not for an audit. Nothing in the app formatted
 * bytes before this, so this is the first one; keep it the only one.
 *
 * One decimal above kilobytes and none below, because "1.0 KB" reads as
 * precision that a directory walk does not have, while "1.4 GB" is the
 * difference between a transfer worth waiting for and one worth cancelling.
 */
export function formatSyncBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= BYTES_PER_UNIT && unitIndex < BYTE_UNITS.length - 1) {
    value /= BYTES_PER_UNIT;
    unitIndex += 1;
  }
  const unit = BYTE_UNITS[unitIndex] ?? "B";
  return unitIndex === 0 ? `${Math.round(value)} ${unit}` : `${value.toFixed(1)} ${unit}`;
}

export interface CloudSyncModeChoice {
  readonly mode: CloudSyncMode;
  /** The promise, in the words the person is choosing between. */
  readonly title: string;
  /** What it does, in one line. */
  readonly summary: string;
  /**
   * The part they would otherwise find out afterwards. Shown at the same size
   * as the summary and never behind a disclosure — a consequence a person has
   * to expand is a consequence they meet later, by surprise.
   */
  readonly consequence: string;
}

/**
 * The one question, asked once, with both answers' costs stated up front.
 *
 * `handoff` names the dormant snapshot because "move" is a product word and not
 * an `mv`: the directory stays exactly where it is, and the trap is believing
 * later edits to it still travel.
 *
 * `mirror` says it is not a backup because that misunderstanding is how the
 * spec expects someone to lose a file — deleting locally deletes in the cloud,
 * by design, and a person who thinks "sync" means "safe copy" will find out
 * from the absence.
 */
export const CLOUD_SYNC_MODE_CHOICES: readonly CloudSyncModeChoice[] = [
  {
    mode: "handoff",
    title: "Move it to the cloud, work there",
    summary:
      "Uploads the project once, then the cloud copy is the real one and the app follows it.",
    consequence:
      "Your folder on this machine is left exactly as it is and becomes a dormant snapshot — nothing is deleted, but the app stops writing to it and stops watching it. Edits you make there afterwards will not reach the cloud.",
  },
  {
    mode: "mirror",
    title: "Keep both in sync",
    summary:
      "Replicates continuously in both directions: your changes reach the cloud, and a collaborator's reach this machine.",
    consequence:
      "A mirror is not a backup. Deleting a file here deletes it in the cloud too, by design. Switching it off later leaves both copies intact and diverging.",
  },
];

export function readCloudSyncModeChoice(mode: CloudSyncMode): CloudSyncModeChoice {
  return (
    CLOUD_SYNC_MODE_CHOICES.find((choice) => choice.mode === mode) ?? CLOUD_SYNC_MODE_CHOICES[0]!
  );
}

/** Short enough for a button, used where the panel has already explained itself. */
export function cloudSyncModeLabel(mode: CloudSyncMode): string {
  return mode === "handoff" ? "Handoff" : "Mirror";
}

export type CloudSyncTone = "idle" | "busy" | "paused" | "error";

export interface CloudSyncHeadline {
  readonly tone: CloudSyncTone;
  readonly label: string;
  readonly detail: string;
}

/**
 * The one-line answer to "what is it doing".
 *
 * `paused` is a state rather than the absence of one, so it never collapses
 * into `idle`: a stopped mirror looks identical to a settled one from the
 * outside, and the difference is whether anything will pick up the next change.
 */
export function describeCloudSyncHeadline(sync: ProjectCloudSync | null): CloudSyncHeadline {
  if (!sync) {
    return {
      tone: "idle",
      label: "Not shared",
      detail: "This project only exists on this machine. Nobody in the browser can open it yet.",
    };
  }
  switch (sync.status) {
    case "scanning":
      return {
        tone: "busy",
        label: "Scanning",
        detail: "Working out what differs between this machine and the cloud copy.",
      };
    case "transferring":
      return { tone: "busy", label: "Transferring", detail: "Moving the files that differ." };
    case "paused":
      return {
        tone: "paused",
        label: "Paused",
        detail:
          sync.mode === "mirror"
            ? "Both copies are intact and will drift apart until you resume."
            : "The upload stopped partway. Resume it to finish handing the project over.",
      };
    case "error":
      return {
        tone: "error",
        label: "Stopped on an error",
        // The message itself is rendered separately; nothing is lost either way,
        // and saying so is the difference between a retry and a panic.
        detail: "Nothing was deleted. The next pass that gets past this clears the error.",
      };
    case "idle":
      return sync.lastAgreedAt
        ? { tone: "idle", label: "Up to date", detail: "Both sides agree on every file." }
        : {
            tone: "idle",
            label: "Waiting to start",
            detail: "Nothing has been uploaded yet.",
          };
  }
}

export interface CloudSyncProgress {
  /** Null when this pass has nothing to do, so the panel omits the bar entirely. */
  readonly percent: number | null;
  readonly filesLabel: string;
  readonly bytesLabel: string;
  readonly filesRemaining: number;
}

/**
 * Progress for the *current pass only*.
 *
 * The contract is explicit that these four counters reset when a pass begins,
 * so nothing here accumulates them across passes; a bar that cannot reach its
 * end is a bug report waiting to be filed.
 */
export function describeCloudSyncProgress(sync: ProjectCloudSync): CloudSyncProgress {
  const filesRemaining = Math.max(0, sync.filesTotal - sync.filesDone);
  const percent =
    sync.bytesTotal > 0
      ? Math.min(100, Math.round((sync.bytesDone / sync.bytesTotal) * 100))
      : sync.filesTotal > 0
        ? Math.min(100, Math.round((sync.filesDone / sync.filesTotal) * 100))
        : null;
  return {
    percent,
    filesLabel: `${sync.filesDone} of ${sync.filesTotal} files`,
    bytesLabel: `${formatSyncBytes(sync.bytesDone)} of ${formatSyncBytes(sync.bytesTotal)}`,
    filesRemaining,
  };
}

/**
 * When the two sides last agreed in full, in plain words.
 *
 * This is the field that answers "is my work safe?", so a null is spelled out
 * rather than rendered as a dash — an empty slot reads as "loading", and a
 * person waits for a number that is never coming.
 */
export function describeLastAgreement(lastAgreedAt: string | null): string {
  return lastAgreedAt
    ? `Both sides last fully agreed ${formatRelativeTimeLabel(lastAgreedAt)}`
    : "The two sides have never fully agreed yet";
}

/**
 * Why a healthy sync can look stuck.
 *
 * Rendered as its own line rather than folded into the status, because the
 * status is what the sync is doing and this is why it is not finishing. Without
 * it, a mirror over a tree someone is typing into reads as broken and gets
 * switched off — which is the one action that actually stops the work being
 * replicated.
 */
export function describeActivelyChanging(sync: ProjectCloudSync): string | null {
  if (!sync.activelyChanging) {
    return null;
  }
  return "Files are being edited right now, so this pass will keep finding more to do. That is expected, not stuck.";
}

export interface CloudSyncConflictCopy {
  readonly title: string;
  /** One sentence a person can act on: what happened, and where their version is. */
  readonly explanation: string;
  readonly conflictedCopyPath: string;
  readonly detectedLabel: string;
}

/**
 * One conflict, explained.
 *
 * The remote version keeps the path so that everyone in the browser sees the
 * same file, and the local version was written beside it. Naming both paths is
 * the whole point: "there is a conflict" is not actionable, "your version is in
 * this file" is.
 */
export function describeConflict(conflict: CloudSyncConflict): CloudSyncConflictCopy {
  return {
    title: conflict.path,
    explanation: `Both sides changed this file, so we kept both. The cloud version is at ${conflict.path}, and your version from this machine is saved beside it as ${conflict.conflictedCopyPath}.`,
    conflictedCopyPath: conflict.conflictedCopyPath,
    detectedLabel: formatRelativeTimeLabel(conflict.detectedAt),
  };
}

export function describeConflictCount(count: number): string | null {
  if (count <= 0) {
    return null;
  }
  return count === 1 ? "1 file needs you" : `${count} files need you`;
}

/**
 * Marking a conflict resolved deletes nothing, and the button has to say so —
 * every other "resolve" control in every other app throws one side away.
 */
export const CLOUD_SYNC_RESOLVE_HINT =
  "Marking it done only clears it from this list. Both files stay on disk.";

export type CloudSyncErrorCode = CloudSyncError["code"];

export function readCloudSyncErrorCode(error: unknown): CloudSyncErrorCode | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  switch ((error as { code: unknown }).code) {
    case "forbidden":
      return "forbidden";
    case "not-found":
      return "not-found";
    case "conflict-not-found":
      return "conflict-not-found";
    case "mode-locked":
      return "mode-locked";
    case "unusable-url":
      return "unusable-url";
    case "storage":
      return "storage";
    default:
      return null;
  }
}

export interface CloudSyncFailureNotice {
  readonly tone: "error" | "info";
  readonly title: string;
  readonly description: string;
  /** True when the list or status on screen is known to be behind the server. */
  readonly refetch: boolean;
}

export function describeCloudSyncFailure(
  error: unknown,
  context: { readonly fallbackTitle: string },
): CloudSyncFailureNotice {
  switch (readCloudSyncErrorCode(error)) {
    case "forbidden":
      return {
        tone: "error",
        title: "You cannot change this project's sync",
        description:
          "You are not a member of the workspace this project belongs to. Ask someone who is to start or stop it.",
        refetch: false,
      };
    case "not-found":
      return {
        tone: "info",
        title: "This project is not synced",
        description: "Nobody has shared it to the cloud yet, so there is nothing to change.",
        refetch: true,
      };
    case "conflict-not-found":
      return {
        tone: "info",
        title: "Somebody already dealt with that one",
        // Distinct from `not-found` precisely because the next move differs:
        // there is nothing to start here, only a stale list to reload.
        description: "The list was out of date. Reloading it now.",
        refetch: true,
      };
    case "mode-locked":
      return {
        tone: "info",
        title: "Stop the sync before changing how it works",
        description:
          "Switching between handoff and mirror changes which copy is the real one, and doing that under a transfer already in flight is not safe. Stop it first, then start it again in the other mode.",
        refetch: true,
      };
    case "unusable-url":
      return {
        tone: "error",
        title: "That address will not be handed to anyone",
        // Refused at the door rather than stored, because a stored one becomes
        // a `Location` header pointed wherever it says.
        description:
          "A live copy has to be reachable over https, and cannot carry a username or password. Nothing was published.",
        refetch: true,
      };
    case "storage":
      return {
        tone: "error",
        title: "The cloud copy refused the write",
        description:
          "Nothing was reported as synced that was not, and nothing local was touched. Try again in a moment.",
        refetch: true,
      };
    default:
      return {
        tone: "error",
        title: context.fallbackTitle,
        description: error instanceof Error ? error.message : "The server did not say why.",
        refetch: true,
      };
  }
}

export interface CloudSyncWaitState {
  readonly kind: CloudSyncVisitorState;
  /** Turns are refused while this is true. */
  readonly blocked: boolean;
  readonly title: string;
  readonly detail: string;
  /** Where a visitor can go while they wait, when a live copy is being published. */
  readonly liveCopyUrl: string | null;
}

/**
 * Why a first pass is not moving, from the sync that travels beside the state.
 *
 * The visitor states deliberately do not encode this — `scanning`, a slow
 * `transferring` and a `paused` first pass all leave a visitor the same two
 * options — so the reason is read off `sync` and appended rather than branching
 * the state machine a second time.
 */
function describeFirstPassProgress(sync: ProjectCloudSync | null): string {
  if (!sync) {
    return "Still working out what to send.";
  }
  switch (sync.status) {
    case "scanning":
      return "Still working out what to send.";
    case "transferring": {
      const remaining = Math.max(0, sync.filesTotal - sync.filesDone);
      return remaining === 1 ? "1 file left to upload." : `${remaining} files left to upload.`;
    }
    case "paused":
      return "The upload is paused partway, and has to be resumed from the machine that shared it.";
    case "error":
      return `The upload stopped on an error${sync.lastError ? `: ${sync.lastError}` : ""}. Nothing was lost, but it has to be restarted from the machine that shared it.`;
    case "idle":
      return "The upload has not started moving yet.";
  }
}

const TURNS_HELD_BECAUSE =
  "An agent let loose on a half-uploaded project will read a truncated file, decide the code is broken, and confidently fix it — so turns are held until the first sync finishes.";

/**
 * What to tell a visitor, and whether they may drive an agent yet.
 *
 * `turnsAllowed` is taken from the view and never recomputed here. The contract
 * is explicit about why: refusing turns until the first pass completes is one
 * rule, and a rule re-derived in every client is a rule that will eventually be
 * derived wrongly in one of them.
 *
 * `sharer-away` is likewise never inferred from a status. It means the laptop's
 * heartbeat stopped and nothing else — a genuinely slow first pass over a
 * genuinely slow link keeps saying so, and must never decay into telling
 * somebody the sharer left.
 */
export function describeCloudSyncWait(view: CloudSyncVisitorView): CloudSyncWaitState {
  const blocked = !view.turnsAllowed;
  const liveCopyUrl = view.liveCopy?.url ?? null;

  switch (view.state) {
    case "not-syncing":
      return {
        kind: view.state,
        blocked,
        title: "This project is not shared",
        detail: "It only exists on the machine it was opened from.",
        liveCopyUrl: null,
      };
    case "synced":
      return {
        kind: view.state,
        blocked,
        title: "Synced",
        detail: "The cloud copy is complete and is the one being served.",
        liveCopyUrl,
      };
    case "first-pass":
      return {
        kind: view.state,
        blocked,
        title: "Still uploading — hold on",
        detail: `${describeFirstPassProgress(view.sync)} ${TURNS_HELD_BECAUSE}`,
        liveCopyUrl: null,
      };
    case "first-pass-live":
      return {
        kind: view.state,
        blocked,
        // Nobody came here to watch a bar: the live copy is the answer, and the
        // progress is the footnote.
        title: "Still uploading — but you can work on the live copy now",
        detail: `${describeFirstPassProgress(view.sync)} ${TURNS_HELD_BECAUSE}`,
        liveCopyUrl,
      };
    case "sharer-away":
      return {
        kind: view.state,
        blocked,
        title: "The person sharing this closed their laptop",
        detail:
          "The upload stopped partway and the machine holding the project is no longer answering. Nothing was lost. Ask them to reopen it, and this page picks up where it left off.",
        liveCopyUrl: null,
      };
  }
}

/** The short form for a header badge, where the panel has the full explanation. */
export function cloudSyncWaitBadgeLabel(wait: CloudSyncWaitState): string | null {
  switch (wait.kind) {
    case "first-pass":
    case "first-pass-live":
      return "Uploading";
    case "sharer-away":
      return "Sharer away";
    case "not-syncing":
    case "synced":
      return null;
  }
}

/**
 * A visitor view assembled from `cloudSync.status.get`.
 *
 * A stopgap, and deliberately a conservative one. The contract defines
 * `CloudSyncVisitorView` and states `turnsAllowed` on it precisely so no client
 * has to do this, but the `visit` RPC that returns one is not registered yet;
 * until it is, this is the only status a browser can ask for.
 *
 * Two things it cannot honestly produce, and does not pretend to:
 *
 * `first-pass-live` — a live copy's address is only known to the call that
 * carries it, so this never offers one and a visitor is never sent anywhere.
 *
 * `sharer-away` — the real signal is a stopped heartbeat. The nearest honest
 * substitute is the sync row's own freshness under the same staleness rule: a
 * first pass whose row has not been touched in three heartbeats has nothing
 * driving it. That is a weaker claim than a missed heartbeat, so it is checked
 * with the contract's own helper rather than a second threshold invented here,
 * and it is the first thing to delete when `visit` lands.
 */
export function deriveVisitorView(
  sync: ProjectCloudSync | null,
  now: Date = new Date(),
): CloudSyncVisitorView {
  if (!sync) {
    return { state: "not-syncing", sync: null, liveCopy: null, turnsAllowed: true };
  }
  if (sync.lastAgreedAt !== null) {
    // Agreed once means the tree is whole. A later pass only means some files
    // are newer, which is ordinary and blocks nobody.
    return { state: "synced", sync, liveCopy: null, turnsAllowed: true };
  }
  const state: CloudSyncVisitorState = isLiveCopyFresh(sync.updatedAt, now)
    ? "first-pass"
    : "sharer-away";
  return { state, sync, liveCopy: null, turnsAllowed: false };
}
