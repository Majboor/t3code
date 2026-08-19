import type {
  CollaborationActivity,
  CollaborationApprovalMode,
  CollaborationBranchClaim,
  CollaborationMember,
  CollaborationPresence,
  ProviderConnectedAccount,
  ProviderSharingOverviewResult,
  ProviderUsageRequest,
} from "@t3tools/contracts";

import { PROVIDER_LABEL, PROVIDERS, readViewerSharing } from "./providerSharing.logic";
import { readIncomingRequests, readViewerUsage } from "./providerUsageRequests.logic";

/**
 * The collaboration popover as a two-level thing: an overview of one-line
 * previews, and one section open at a time behind it.
 *
 * All of it is decided here rather than in the panel because every rule worth
 * arguing about is a sentence rather than a layout — whether a section has
 * anything to say, whether "nothing" means empty or unloaded, and what happens
 * to the reader when the section they are standing in disappears underneath
 * them.
 */

export type CollaborationSectionId =
  | "activity"
  | "people"
  | "approvals"
  | "branch"
  | "sharing"
  | "requests";

/**
 * Activity leads because it is the only row that changes while somebody
 * watches it; the two provider rows sit last because they are settings, and a
 * setting is something you go looking for rather than something you glance at.
 */
export const COLLABORATION_SECTION_ORDER: readonly CollaborationSectionId[] = [
  "activity",
  "people",
  "approvals",
  "branch",
  "sharing",
  "requests",
];

export const COLLABORATION_SECTION_TITLE: Record<CollaborationSectionId, string> = {
  activity: "Activity",
  people: "People",
  approvals: "Approvals",
  branch: "Branches",
  sharing: "Provider accounts",
  requests: "Usage requests",
};

/**
 * What to letter somebody's avatar with when only their presence is known.
 *
 * The server sends initials it worked out from the same name, so its answer
 * wins whenever it has one; deriving them again locally is only for the entries
 * that predate it. Two letters, because three is a word.
 */
export function presenceInitials(entry: {
  /** Optional in the contract, and null in older rows: both mean "work it out". */
  readonly avatarInitials?: string | null | undefined;
  readonly displayName: string;
}): string {
  const saved = entry.avatarInitials?.trim();
  if (saved) {
    return saved;
  }
  const derived = entry.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return derived || "U";
}

// ── The activity chart ──────────────────────────────────────────────────────

/** Narrow enough to read as a shape at 4rem wide, wide enough to have one. */
export const ACTIVITY_SPARKLINE_BUCKETS = 16;

export interface ActivityBucketView {
  /** Stable across renders so a bucket is never re-keyed by its own value. */
  readonly key: string;
  readonly count: number;
  /** Start of the bucket, epoch milliseconds, for the hover title. */
  readonly startedAt: number;
}

export interface ActivitySparklineView {
  readonly buckets: readonly ActivityBucketView[];
  readonly max: number;
  readonly total: number;
  /** Oldest entry to now, in milliseconds — what the axis actually covers. */
  readonly spanMs: number;
}

/**
 * Shared activity counted into equal slices of the window it covers.
 *
 * Null rather than a flat line when there is one entry or none: a single bar is
 * not a trend, and drawing an empty axis would claim the thread had been
 * measured and found quiet when in fact nothing has been measured at all. The
 * caller says that in words instead.
 */
export function buildActivitySparkline(
  activities: readonly Pick<CollaborationActivity, "createdAt">[],
  options: { readonly now: number; readonly buckets?: number },
): ActivitySparklineView | null {
  const bucketCount = Math.max(2, options.buckets ?? ACTIVITY_SPARKLINE_BUCKETS);
  const times = activities
    .map((activity) => Date.parse(activity.createdAt))
    .filter((value) => Number.isFinite(value));

  if (times.length < 2) {
    return null;
  }

  const oldest = Math.min(...times);
  // A clock that disagrees with the server must not collapse the axis to zero.
  const newest = Math.max(options.now, ...times);
  const spanMs = newest - oldest;
  if (spanMs <= 0) {
    return null;
  }

  const width = spanMs / bucketCount;
  const counts = Array.from({ length: bucketCount }, () => 0);
  for (const time of times) {
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((time - oldest) / width)));
    counts[index] = (counts[index] ?? 0) + 1;
  }

  return {
    buckets: counts.map((count, index) => ({
      key: String(index),
      count,
      startedAt: oldest + index * width,
    })),
    max: counts.reduce((max, count) => Math.max(max, count), 0),
    total: times.length,
    spanMs,
  };
}

/**
 * How long ago, in the coarsest unit that is still true. Rounded rather than
 * floored: "2h" for 118 minutes is closer than "1h", and nothing here is a
 * deadline.
 */
export function formatActivitySpan(milliseconds: number): string {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes === 1) return "1 min";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  const days = Math.round(hours / 24);
  return `${days} days`;
}

// ── Overview rows ───────────────────────────────────────────────────────────

export interface CollaborationOverviewRow {
  readonly id: CollaborationSectionId;
  readonly title: string;
  /** One line of live state. Never blank, never a bare zero. */
  readonly summary: string;
  /** Nothing is happening in this section. Drawn quieter, still openable. */
  readonly quiet: boolean;
  /** Something in here is waiting on the person reading it. */
  readonly attention: boolean;
  readonly badge: number | null;
  /** Only activity has a series worth plotting; every other row is a sentence. */
  readonly sparkline: ActivitySparklineView | null;
}

export interface CollaborationOverviewGovernance {
  /** False until the first governance read lands — "no rules yet" is not a rule. */
  readonly loaded: boolean;
  readonly approvalMode: CollaborationApprovalMode | null;
  readonly pendingApprovalCount: number;
  readonly canDecide: boolean;
  readonly contendedCount: number;
  readonly branchClaims: readonly CollaborationBranchClaim[];
  readonly myBranchClaim: CollaborationBranchClaim | null;
}

export interface CollaborationOverviewRequests {
  readonly requests: readonly ProviderUsageRequest[];
  readonly canRespond: boolean;
  readonly viewerUserId: string;
  readonly viewerAccounts: readonly ProviderConnectedAccount[];
}

export interface CollaborationOverviewInput {
  readonly now: number;
  readonly activities: readonly CollaborationActivity[];
  readonly presence: readonly CollaborationPresence[];
  /**
   * Null until the roster answers. An empty roster and an unanswered one look
   * identical in an array, and only one of them is worth a row.
   */
  readonly members: readonly CollaborationMember[] | null;
  readonly governance: CollaborationOverviewGovernance;
  /** Null when sharing has not loaded, or this server does not answer it. */
  readonly sharing: ProviderSharingOverviewResult | null;
  /** Null until the request list answers, for the same reason as the roster. */
  readonly requests: CollaborationOverviewRequests | null;
}

/**
 * The overview, in order, with unavailable sections left out entirely.
 *
 * Leaving a section out is not the same as saying it is empty: a row that has
 * loaded and found nothing says so in words, and a row that has not loaded is
 * simply not drawn, because a panel that told somebody "nobody has asked you
 * for anything" before the request list arrived would be guessing.
 */
export function buildCollaborationOverview(
  input: CollaborationOverviewInput,
): readonly CollaborationOverviewRow[] {
  const rows: CollaborationOverviewRow[] = [];
  for (const id of COLLABORATION_SECTION_ORDER) {
    const row = buildRow(id, input);
    if (row) {
      rows.push(row);
    }
  }
  return rows;
}

function buildRow(
  id: CollaborationSectionId,
  input: CollaborationOverviewInput,
): CollaborationOverviewRow | null {
  switch (id) {
    case "activity":
      return activityRow(input);
    case "people":
      return peopleRow(input);
    case "approvals":
      return approvalsRow(input);
    case "branch":
      return branchRow(input);
    case "sharing":
      return sharingRow(input);
    case "requests":
      return requestsRow(input);
  }
}

function row(
  id: CollaborationSectionId,
  patch: Omit<CollaborationOverviewRow, "id" | "title">,
): CollaborationOverviewRow {
  return { id, title: COLLABORATION_SECTION_TITLE[id], ...patch };
}

const QUIET: Pick<CollaborationOverviewRow, "quiet" | "attention" | "badge" | "sparkline"> = {
  quiet: true,
  attention: false,
  badge: null,
  sparkline: null,
};

const LIVE: Pick<CollaborationOverviewRow, "quiet" | "attention" | "badge" | "sparkline"> = {
  quiet: false,
  attention: false,
  badge: null,
  sparkline: null,
};

function activityRow(input: CollaborationOverviewInput): CollaborationOverviewRow {
  const sparkline = buildActivitySparkline(input.activities, { now: input.now });
  if (sparkline) {
    return row("activity", {
      ...LIVE,
      summary: `${sparkline.total} updates over ${formatActivitySpan(sparkline.spanMs)}`,
      sparkline,
    });
  }

  const only = input.activities[0];
  if (input.activities.length === 1 && only) {
    const age = input.now - Date.parse(only.createdAt);
    return row("activity", {
      ...LIVE,
      summary: Number.isFinite(age) ? `1 update, ${formatActivitySpan(age)} ago` : "1 update",
    });
  }

  return row("activity", { ...QUIET, summary: "Nothing shared in this thread yet" });
}

function peopleRow(input: CollaborationOverviewInput): CollaborationOverviewRow | null {
  const here = input.presence.filter((entry) => entry.status !== "offline");
  const working = here.filter((entry) => entry.status === "active").length;
  const memberCount = input.members?.length ?? 0;

  // Presence and the roster arrive on different calls, and either one alone is
  // still something to say about who is in the workspace.
  if (here.length === 0 && memberCount === 0) {
    return input.members === null
      ? null
      : row("people", { ...QUIET, summary: "Nobody is in this workspace yet" });
  }

  const tokens = sumSharedTokens(input.members);
  const parts: string[] = [];
  if (here.length === 0) {
    parts.push(memberCount === 1 ? "1 member, none here now" : `${memberCount} members, none here`);
    // "3 of 2 here" is the roster lagging behind presence, not a fact. Whoever
    // is in the thread is still worth counting; the denominator is not.
  } else if (memberCount >= here.length) {
    parts.push(`${here.length} of ${memberCount} here`);
  } else {
    parts.push(here.length === 1 ? "1 person here" : `${here.length} people here`);
  }
  if (working > 0) {
    parts.push(`${working} working`);
  }
  if (tokens !== null) {
    parts.push(`${formatCompactTokens(tokens)} tokens`);
  }

  return row("people", { ...LIVE, quiet: here.length === 0, summary: parts.join(" · ") });
}

/**
 * Tokens across everyone who agreed to be counted, or null when nobody has.
 * Zero is a real answer here and is reported as one; null is the absence of
 * consent, which is not a number at all.
 */
function sumSharedTokens(members: readonly CollaborationMember[] | null): number | null {
  if (!members || members.length === 0) return null;
  const shared = members.filter((member) => member.tokensUsed !== null);
  if (shared.length === 0) return null;
  return shared.reduce((sum, member) => sum + (member.tokensUsed ?? 0), 0);
}

/** The roster's own token figures, at the width a preview line can afford. */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const rounded = Math.round(tokens);
  if (rounded < 1_000) return String(rounded);
  if (rounded < 1_000_000) return `${trimTrailingZero(rounded / 1_000)}K`;
  if (rounded < 1_000_000_000) return `${trimTrailingZero(rounded / 1_000_000)}M`;
  return `${trimTrailingZero(rounded / 1_000_000_000)}B`;
}

function trimTrailingZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

const APPROVAL_MODE_SUMMARY: Record<CollaborationApprovalMode, string> = {
  open: "Anyone here can prompt the agent",
  blocking: "Prompts wait for a lead",
  staged: "Prompts run on their author's branch",
};

function approvalsRow(input: CollaborationOverviewInput): CollaborationOverviewRow | null {
  const { governance } = input;
  if (!governance.loaded) {
    return null;
  }

  const pending = governance.pendingApprovalCount;
  if (pending > 0) {
    const noun = pending === 1 ? "1 prompt" : `${pending} prompts`;
    const who = governance.canDecide ? "you" : "a lead";
    return row("approvals", {
      ...LIVE,
      summary: `${noun} waiting for ${who}`,
      attention: governance.canDecide,
      badge: pending,
    });
  }

  const contended = governance.contendedCount;
  if (contended > 0) {
    return row("approvals", {
      ...LIVE,
      summary:
        contended === 1
          ? "Two people are in the same file"
          : `${contended} files have two people in them`,
      attention: true,
    });
  }

  const mode = governance.approvalMode;
  return row("approvals", {
    ...QUIET,
    summary: mode === null ? "Nothing waiting for a decision" : APPROVAL_MODE_SUMMARY[mode],
  });
}

function branchRow(input: CollaborationOverviewInput): CollaborationOverviewRow | null {
  const { governance } = input;
  if (!governance.loaded) {
    return null;
  }

  const others = governance.branchClaims.filter(
    (claim) => claim.userId !== governance.myBranchClaim?.userId,
  ).length;

  const mine = governance.myBranchClaim;
  if (mine) {
    const own = `${mine.branch} from ${mine.baseBranch}`;
    return row("branch", {
      ...LIVE,
      summary: others > 0 ? `${own} · ${others} other${others === 1 ? "" : "s"}` : own,
    });
  }

  // The one mode that expects a branch is the one where not having one matters.
  if (governance.approvalMode === "staged") {
    return row("branch", {
      ...LIVE,
      summary: "This workspace reviews work on merge — you have no branch",
      attention: true,
    });
  }

  if (others > 0) {
    return row("branch", {
      ...LIVE,
      summary:
        others === 1 ? "1 person is on their own branch" : `${others} people are on branches`,
    });
  }

  return row("branch", { ...QUIET, summary: "Everyone is on the shared branch" });
}

function sharingRow(input: CollaborationOverviewInput): CollaborationOverviewRow | null {
  const overview = input.sharing;
  if (!overview) {
    return null;
  }

  const views = PROVIDERS.map((provider) => readViewerSharing(overview, provider));
  const missing = views.filter((view) => view.sharedAccountMissing);
  if (missing.length > 0) {
    const label = PROVIDER_LABEL[missing[0]?.provider ?? "claude"];
    return row("sharing", {
      ...LIVE,
      summary: `${label} is shared, but that account is gone`,
      attention: true,
    });
  }

  const shared = views.filter((view) => view.isSharing);
  const connected = views.filter((view) => view.accounts.length > 0);
  if (shared.length > 0) {
    const on = joinNames(shared.map((view) => PROVIDER_LABEL[view.provider]));
    const off = joinNames(
      connected.filter((view) => !view.isSharing).map((view) => PROVIDER_LABEL[view.provider]),
    );
    return row("sharing", {
      ...LIVE,
      summary: off.length > 0 ? `Sharing ${on} · ${off} not shared` : `Sharing ${on}`,
    });
  }

  if (connected.length === 0) {
    return row("sharing", { ...QUIET, summary: "No provider account connected" });
  }

  return row("sharing", {
    ...QUIET,
    summary: `${joinNames(connected.map((view) => PROVIDER_LABEL[view.provider]))} connected, nothing shared`,
  });
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function requestsRow(input: CollaborationOverviewInput): CollaborationOverviewRow | null {
  const usage = input.requests;
  if (!usage) {
    return null;
  }

  const incoming = readIncomingRequests({
    requests: usage.requests,
    viewerUserId: usage.viewerUserId,
    viewerAccounts: usage.viewerAccounts,
  });
  if (incoming.length > 0) {
    const first = incoming[0]?.request.requesterDisplayName ?? "Somebody";
    return row("requests", {
      ...LIVE,
      summary:
        incoming.length === 1
          ? `${first} is asking to use your account`
          : `${incoming.length} people are asking for your accounts`,
      attention: true,
      badge: incoming.length,
    });
  }

  const views = PROVIDERS.map((provider) =>
    readViewerUsage({
      requests: usage.requests,
      viewerUserId: usage.viewerUserId,
      provider,
      hasOwnAccount: usage.viewerAccounts.some((account) => account.provider === provider),
    }),
  );

  const pending = views.find((view) => view.state === "pending");
  if (pending) {
    return row("requests", {
      ...LIVE,
      summary: `Waiting on ${PROVIDER_LABEL[pending.provider]}`,
    });
  }

  // Being unable to run a turn outranks a stale answer about one you can.
  const blocked = views.find((view) => !view.hasOwnAccount && view.state !== "granted");
  if (blocked) {
    return row("requests", {
      ...LIVE,
      summary: `No ${PROVIDER_LABEL[blocked.provider]} account — those turns are refused`,
      attention: true,
    });
  }

  const granted = views.find((view) => view.state === "granted");
  if (granted) {
    return row("requests", {
      ...LIVE,
      summary: `${PROVIDER_LABEL[granted.provider]} was lent to you`,
    });
  }

  const declined = views.find((view) => view.state === "declined");
  if (declined) {
    return row("requests", {
      ...LIVE,
      summary: `Your ${PROVIDER_LABEL[declined.provider]} request was declined`,
    });
  }

  return row("requests", {
    ...QUIET,
    summary: usage.canRespond ? "Nobody has asked to use your accounts" : "Nothing to ask for",
  });
}

// ── Navigation ──────────────────────────────────────────────────────────────

/**
 * Which section is open, if any. A record rather than a bare id so the panel
 * has one thing to hold and one thing to reset when the popover closes.
 */
export interface CollaborationPanelNav {
  readonly section: CollaborationSectionId | null;
}

export const COLLABORATION_PANEL_ROOT: CollaborationPanelNav = { section: null };

export function openCollaborationSection(id: CollaborationSectionId): CollaborationPanelNav {
  return { section: id };
}

export function closeCollaborationSection(): CollaborationPanelNav {
  return COLLABORATION_PANEL_ROOT;
}

/**
 * The section actually worth drawing.
 *
 * Sections come and go while somebody is standing in one — a request list can
 * empty, a roster can fail to load on a reconnect — and a drill-down whose row
 * has vanished is a blank panel with a back button. Falling back to the
 * overview puts the reader somewhere real instead.
 */
export function resolveVisibleSection(
  nav: CollaborationPanelNav,
  rows: readonly CollaborationOverviewRow[],
): CollaborationSectionId | null {
  if (nav.section === null) {
    return null;
  }
  return rows.some((entry) => entry.id === nav.section) ? nav.section : null;
}
