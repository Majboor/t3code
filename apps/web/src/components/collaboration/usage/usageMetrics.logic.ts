import type {
  CollaborationPresenceStatus,
  CollaborationUsageCostEstimate,
  CollaborationUsageDayBucket,
  CollaborationUsageHourBucket,
  CollaborationUsageLeaderboardEntry,
  CollaborationUsageProviderBreakdown,
} from "@t3tools/contracts";

// The same wheel the roster draws from, so a person keeps one colour across
// both. Someone only lands on it here when the usage report is the first place
// the app has met them; anywhere the roster is loaded, its own colour wins.
import { MEMBER_COLORS } from "../collaborationRoster.logic";

const MILLISECONDS_PER_DAY = 86_400_000;

/** How many days of the trend count as "this week" on either side of the delta. */
export const TREND_WEEK_LENGTH = 7;

/**
 * Compact enough for a stat tile, exact enough to be worth reading. Values
 * under ten thousand keep every digit because that is the range where the
 * difference between 1,284 and 1,842 is the whole point.
 */
export function formatTokenCount(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  const rounded = Math.round(tokens);
  if (rounded < 10_000) return rounded.toLocaleString();
  if (rounded < 1_000_000) return `${trimZero(rounded / 1_000)}K`;
  if (rounded < 1_000_000_000) return `${trimZero(rounded / 1_000_000)}M`;
  return `${trimZero(rounded / 1_000_000_000)}B`;
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/**
 * Money, to the cent. A non-zero amount never rounds down to `$0.00`, because
 * "free" and "too small to show" are different claims and only one of them is
 * true.
 */
export function formatEstimatedCost(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export interface UnpricedNote {
  readonly tokens: number;
  readonly models: readonly string[];
  readonly summary: string;
}

/**
 * What the cost estimate is missing. Tokens from a model the rate table has
 * never heard of are excluded from the figure entirely, so leaving this silent
 * would present a partial number as a whole one.
 */
export function describeUnpricedTokens(
  estimate: Pick<CollaborationUsageCostEstimate, "unpricedTokens" | "unpricedModels">,
): UnpricedNote | null {
  if (estimate.unpricedTokens <= 0) return null;
  const models = [...estimate.unpricedModels];
  const named = models.slice(0, 3).join(", ");
  const rest = models.length - 3;
  const from = models.length === 0 ? "" : ` from ${named}${rest > 0 ? ` and ${rest} more` : ""}`;
  return {
    tokens: estimate.unpricedTokens,
    models,
    summary: `${formatTokenCount(estimate.unpricedTokens)} tokens${from} have no published rate, so they are not in this estimate.`,
  };
}

export interface HourBucketView {
  /** Position on the axis, 0-23, in whichever zone `zone` names. */
  readonly hour: number;
  readonly utcHour: number;
  readonly tokens: number;
  readonly label: string;
}

export interface HourOfDayView {
  readonly buckets: readonly HourBucketView[];
  readonly zone: "local" | "utc";
  /** How to name the zone in the caption, e.g. "UTC+2". */
  readonly zoneLabel: string;
  readonly maxTokens: number;
  /** Index into `buckets`, or null when nothing was recorded at all. */
  readonly peakIndex: number | null;
  /** The peak hour's share of the window, 0..1. */
  readonly peakShare: number;
}

/**
 * The server buckets by UTC hour because it cannot know where the reader is.
 * A whole-hour offset re-labels exactly, so the shift is safe; a half-hour zone
 * would split every UTC hour across two local ones, and rather than smear the
 * data across a boundary the labels stay in UTC and say so.
 */
export function buildHourOfDayView(
  byHourOfDay: readonly CollaborationUsageHourBucket[],
  offsetMinutes: number,
): HourOfDayView {
  const byUtcHour = new Map(byHourOfDay.map((bucket) => [bucket.hour, bucket.totals.totalTokens]));
  const wholeHourZone = Number.isInteger(offsetMinutes / 60);
  const offsetHours = wholeHourZone ? offsetMinutes / 60 : 0;

  const buckets: HourBucketView[] = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const utcHour = (((hour - offsetHours) % 24) + 24) % 24;
    buckets.push({
      hour,
      utcHour,
      tokens: byUtcHour.get(utcHour) ?? 0,
      label: `${String(hour).padStart(2, "0")}:00`,
    });
  }

  const total = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  const maxTokens = buckets.reduce((max, bucket) => Math.max(max, bucket.tokens), 0);
  const peakIndex = maxTokens > 0 ? buckets.findIndex((bucket) => bucket.tokens === maxTokens) : -1;

  return {
    buckets,
    zone: wholeHourZone ? "local" : "utc",
    zoneLabel: wholeHourZone ? formatUtcOffset(offsetMinutes) : "UTC",
    maxTokens,
    peakIndex: peakIndex >= 0 ? peakIndex : null,
    peakShare: total > 0 ? maxTokens / total : 0,
  };
}

export function formatUtcOffset(offsetMinutes: number): string {
  if (offsetMinutes === 0) return "UTC";
  const sign = offsetMinutes > 0 ? "+" : "−";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return minutes === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(minutes).padStart(2, "0")}`;
}

/** Minutes east of UTC, the sign people actually expect. */
export function viewerUtcOffsetMinutes(now: Date = new Date()): number {
  return -now.getTimezoneOffset();
}

export interface DayPointView {
  /** The `YYYY-MM-DD` UTC key, kept so the label can never be mistaken for it. */
  readonly day: string;
  readonly label: string;
  readonly tokens: number;
  readonly cost: number;
}

export interface DayTrendView {
  readonly points: readonly DayPointView[];
  readonly maxTokens: number;
  readonly peakIndex: number | null;
  readonly thisWeekTokens: number;
  readonly previousWeekTokens: number;
  /**
   * Fractional change against the previous seven days. Null when the previous
   * week recorded nothing — every ratio against zero is infinity, and "up ∞%"
   * says less than "nothing last week".
   */
  readonly weekChange: number | null;
}

/**
 * The day series, labelled in the reader's locale but still cut on UTC
 * midnights. Formatting the label in local time would slide every bucket by
 * the offset and quietly re-date the whole chart.
 */
export function buildDayTrendView(
  byDay: readonly CollaborationUsageDayBucket[],
  locale?: string,
): DayTrendView {
  const points = byDay.map((bucket) => ({
    day: bucket.day,
    label: formatUtcDayLabel(bucket.day, locale),
    tokens: bucket.totals.totalTokens,
    cost: bucket.estimatedCost.estimatedTotalCost,
  }));

  const maxTokens = points.reduce((max, point) => Math.max(max, point.tokens), 0);
  const peakIndex = maxTokens > 0 ? points.findIndex((point) => point.tokens === maxTokens) : -1;

  const thisWeek = points.slice(-TREND_WEEK_LENGTH);
  const previousWeek = points.slice(-TREND_WEEK_LENGTH * 2, -TREND_WEEK_LENGTH);
  const thisWeekTokens = sumTokens(thisWeek);
  const previousWeekTokens = sumTokens(previousWeek);

  return {
    points,
    maxTokens,
    peakIndex: peakIndex >= 0 ? peakIndex : null,
    thisWeekTokens,
    previousWeekTokens,
    weekChange:
      previousWeekTokens > 0 ? (thisWeekTokens - previousWeekTokens) / previousWeekTokens : null,
  };
}

function sumTokens(points: readonly DayPointView[]): number {
  return points.reduce((sum, point) => sum + point.tokens, 0);
}

export function formatUtcDayLabel(day: string, locale?: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return day;
  return date.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatWeekChange(change: number | null): string | null {
  if (change === null) return null;
  const percent = Math.round(Math.abs(change) * 100);
  if (percent === 0) return "level with the week before";
  return `${change > 0 ? "+" : "−"}${percent}% vs the week before`;
}

/** Where a provider's colour comes from, resolved by the panel's own palette. */
export type UsageProviderKey = "codex" | "claudeAgent" | "unrecorded";

export interface ProviderSliceView {
  readonly key: UsageProviderKey;
  readonly label: string;
  readonly tokens: number;
  readonly cost: number;
  /** Share of the recorded window, 0..1. */
  readonly share: number;
  /** False for the bucket the server could not attribute to any runtime. */
  readonly recorded: boolean;
}

export interface ProviderSplitView {
  readonly slices: readonly ProviderSliceView[];
  readonly totalTokens: number;
  readonly unrecordedShare: number;
}

/**
 * Which runtime spent the tokens. `null` is its own labelled slice rather than
 * a dropped row: every sample taken before the server started recording the
 * provider lands there, so hiding it would shrink the totals people came to
 * read.
 */
export function buildProviderSplit(
  byProvider: readonly CollaborationUsageProviderBreakdown[],
): ProviderSplitView {
  const totalTokens = byProvider.reduce((sum, row) => sum + row.totals.totalTokens, 0);

  const slices = byProvider
    .filter((row) => row.totals.totalTokens > 0)
    .map((row): ProviderSliceView => {
      const key: UsageProviderKey = row.provider ?? "unrecorded";
      return {
        key,
        label: providerLabel(row.provider),
        tokens: row.totals.totalTokens,
        cost: row.estimatedCost.estimatedTotalCost,
        share: totalTokens > 0 ? row.totals.totalTokens / totalTokens : 0,
        recorded: row.provider !== null,
      };
    })
    // Colour is keyed to the runtime, so ordering never repaints a slice. The
    // unattributed remainder sits last because it is the residue, not a rival.
    .toSorted((left, right) => {
      if (left.recorded !== right.recorded) return left.recorded ? -1 : 1;
      return right.tokens - left.tokens;
    });

  const unrecorded = slices.find((slice) => !slice.recorded);

  return { slices, totalTokens, unrecordedShare: unrecorded?.share ?? 0 };
}

export function providerLabel(provider: string | null): string {
  if (provider === "codex") return "Codex";
  if (provider === "claudeAgent") return "Claude";
  return "Not recorded";
}

export interface UsageAvatarMember {
  readonly displayName: string;
  readonly avatarInitials: string;
  readonly color: string;
  readonly status: CollaborationPresenceStatus;
}

export interface LeaderboardRowView {
  readonly userId: string;
  readonly displayName: string;
  readonly tokens: number;
  readonly cost: number;
  readonly isViewer: boolean;
  /** Length of the row's bar against the heaviest user, 0..1. */
  readonly share: number;
  readonly member: UsageAvatarMember;
}

export function buildLeaderboardRows(
  leaderboard: readonly CollaborationUsageLeaderboardEntry[],
): readonly LeaderboardRowView[] {
  const top = leaderboard.reduce((max, entry) => Math.max(max, entry.totals.totalTokens), 0);
  return leaderboard.map((entry) => ({
    userId: entry.userId,
    displayName: entry.displayName,
    tokens: entry.totals.totalTokens,
    cost: entry.estimatedCost.estimatedTotalCost,
    isViewer: entry.isViewer,
    share: top > 0 ? entry.totals.totalTokens / top : 0,
    member: usageAvatarMember(entry),
  }));
}

/**
 * A stand-in roster entry so the leaderboard can draw people with the same
 * avatar as the rest of the app. The report carries a name and an id and
 * nothing else, and fetching the roster to colour eight rows would double what
 * opening the panel costs.
 */
export function usageAvatarMember(entry: {
  readonly userId: string;
  readonly displayName: string;
}): UsageAvatarMember {
  return {
    displayName: entry.displayName,
    avatarInitials: usageAvatarInitials(entry.displayName),
    color: MEMBER_COLORS[hashToIndex(entry.userId, MEMBER_COLORS.length)] ?? "",
    // Never rendered here: the avatar is drawn without its status dot, because
    // a report about last month says nothing about who is online now.
    status: "offline",
  };
}

/** Mirrors the server's own rule so a person's initials do not change per screen. */
export function usageAvatarInitials(displayName: string): string {
  const parts = displayName
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : displayName.trim().slice(0, 2);
  return initials.toUpperCase() || "U";
}

function hashToIndex(value: string, buckets: number): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % buckets;
}

/**
 * How many members chose not to be counted. Said as a count and never as
 * names, and never as an error: the totals are partial by consent, which the
 * reader has to know to trust them.
 */
export function describeHiddenMembers(hiddenMemberCount: number): string | null {
  if (hiddenMemberCount <= 0) return null;
  return hiddenMemberCount === 1
    ? "1 member keeps their usage private, so these totals are partial."
    : `${hiddenMemberCount} members keep their usage private, so these totals are partial.`;
}

/** "30 days · Jul 16 – Aug 15 UTC" — the window the whole panel is drawn over. */
export function formatWindowLabel(since: string, until: string, locale?: string): string {
  const start = new Date(since);
  const end = new Date(until);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Selected window";
  const days = Math.max(1, Math.round((end.getTime() - start.getTime()) / MILLISECONDS_PER_DAY));
  const startLabel = start.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  // `until` is exclusive, so the last day people can see is the one before it.
  const lastDay = new Date(end.getTime() - MILLISECONDS_PER_DAY);
  const endLabel = lastDay.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
  return `${days} days · ${startLabel} – ${endLabel} UTC`;
}

/**
 * What the panel says when the query fails.
 *
 * The permission refusal is the one worth translating. The server answers with
 * `Forbidden: authenticated session does not have workspace.view.`, which is
 * true and useless: it reads as a bug in the panel when it is actually a
 * statement about which workspace this project belongs to. A project registered
 * under a different local user sits in that user's personal tenant, and usage is
 * a workspace-scoped question, so there is genuinely nothing here to show.
 */
export function describeUsageError(error: Error | null): {
  readonly summary: string;
  readonly detail: string | null;
} | null {
  if (!error) return null;
  if (/does not have workspace\.view/i.test(error.message)) {
    return {
      summary: "This project belongs to a workspace you are not a member of.",
      detail:
        "Usage is reported per workspace. Open a project in your own workspace, or sign in as the account that owns this one.",
    };
  }
  return { summary: error.message, detail: null };
}
