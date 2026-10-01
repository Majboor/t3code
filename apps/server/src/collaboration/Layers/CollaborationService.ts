import {
  CollaborationActivityId,
  CollaborationApprovalId,
  CollaborationError,
  InviteId,
  MembershipId,
  type CollaborationBranchClaim,
  type CollaborationFilePresence,
  type CollaborationFilePresenceRelease,
  type CollaborationFileTouch,
  type CollaborationMember,
  type CollaborationPresence,
  type CollaborationPromptApproval,
  type CollaborationStreamEvent,
  type CollaborationStreamInput,
  type CollaborationUsageCostEstimate,
  type CollaborationUsageQueryResult,
  type CollaborationUsageTotals,
  type CollaborationViewPreferences,
  type CollaborationWorkspaceSettings,
  type ProviderKind,
  TenantId,
  type TenantInvite,
  type TenantMembership,
  type TenantRole,
  ThreadId,
  TurnId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import {
  isFilePresenceLive,
  peopleHoldingFiles,
  type FilePresenceEntry,
} from "@t3tools/shared/filePresence";
import { DateTime, Effect, Layer, PubSub, Ref, Stream } from "effect";

import {
  type CollaborationActor,
  CollaborationService,
  type CollaborationServiceShape,
  type CollaborationState,
} from "../Services/CollaborationService.ts";
import {
  type CollaborationMemberUsageRecord,
  type CollaborationUsageBucketRecord,
  TenancyRepository,
} from "../../persistence/Services/Tenancy.ts";
import {
  ActivityNoteRepository,
  SharedPromptRepository,
  type ActivityNoteRecord,
  type SharedPromptRecord,
} from "../../persistence/Services/ActivityNotes.ts";

const DEFAULT_ACTIVITY_LIMIT = 100;
const MAX_ACTIVITY_LIMIT = 500;

/** How far back `queryUsage` looks when the caller does not say. */
const DEFAULT_USAGE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * The widest window anyone may ask for. The daily series has one entry per day
 * whether or not anything happened, so an unbounded window is an unbounded
 * response; a year is more history than any panel draws.
 */
const MAX_USAGE_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * An email address is personal, so it stays private until someone offers it.
 * Usage is the opposite, and deliberately so: a shared workspace that cannot
 * see what it is collectively spending cannot manage it, so an undecided member
 * shares and the settings toggle is how you stop. These two defaults disagree
 * on purpose — do not "tidy" them into one flag.
 */
const DEFAULT_SHARE_PROFILE = false;
const DEFAULT_SHARE_USAGE = true;

/**
 * Read-only is the absence of any role that grants writing, which is what
 * `checkWriteAccessForTurn` already tests for. Restoring write access returns
 * the member to `developer` rather than whatever they held before, because the
 * roles they came in with are not recorded once they are replaced.
 */
const READ_ONLY_ROLES = ["viewer"] as const satisfies ReadonlyArray<TenantRole>;
const WRITE_ROLES = ["developer"] as const satisfies ReadonlyArray<TenantRole>;

function nowIso(): string {
  return new Date().toISOString();
}

function presenceKey(input: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly threadId: string | null;
  readonly userId: string;
}): string {
  return [input.tenantId, input.workspaceId, input.threadId ?? "", input.userId].join(":");
}

function workspaceKey(tenantId: string, workspaceId: string): string {
  return `${tenantId}:${workspaceId}`;
}

function scopedKey(tenantId: string, workspaceId: string, suffix: string): string {
  return `${tenantId}:${workspaceId}:${suffix}`;
}

function usageKey(tenantId: string, workspaceId: string, userId: string, threadId: string): string {
  return `${tenantId}:${workspaceId}:${userId}:${threadId}`;
}

export interface ModelTokenRate {
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
}

/**
 * List prices per million tokens, in USD, keyed by the canonical model ids in
 * `contracts/model.ts`.
 *
 * Sources, both read on 2026-09-16:
 *   - platform.claude.com/docs/en/pricing (the `claude-*` rows)
 *   - developers.openai.com/api/docs/pricing (the `gpt-*` and `o3` rows),
 *     cross-checked against LiteLLM's community-maintained rate table
 *     (github.com/BerriAI/litellm, model_prices_and_context_window.json) —
 *     the same source upstream (github.com/pingdotgg/t3code) prices against.
 *
 * This is a snapshot and it will go stale. It exists so the panel can show an
 * order of magnitude, not an invoice: it knows nothing about negotiated rates,
 * subscription plans, batch or flex tiers, or the fast-mode premium, and every
 * field computed from it is named an estimate for that reason. A model missing
 * from this table is reported as unpriced rather than free — see `priceBucket`.
 * When adding a model, add the rate here or accept that it shows as unpriced;
 * do not guess.
 */
export const MODEL_TOKEN_RATES_USD: Readonly<Record<string, ModelTokenRate>> = {
  // Anthropic
  "claude-fable-5-1": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-fable-5": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-mythos-5-1": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-mythos-5": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "claude-opus-5": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-8": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-7": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-6": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  "claude-opus-4-5": { inputPerMillionUsd: 5, outputPerMillionUsd: 25 },
  // Sonnet 5.5 is the same $2/$10 as Sonnet 5, not the $3/$15 the 4.6
  // generation charges — without a rate here the cost panel reports every
  // Sonnet 5.5 turn as unpriced instead of cheaper than Sonnet 4.6.
  "claude-sonnet-5-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  // Was priced at the Sonnet 4.6 rate ($3/$15) — Sonnet 5 is actually $2/$10;
  // confirmed against both the pricing page and LiteLLM's table 2026-09-16.
  "claude-sonnet-5": { inputPerMillionUsd: 2, outputPerMillionUsd: 10 },
  "claude-sonnet-4-6": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "claude-sonnet-4-5": { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  "claude-haiku-4-5": { inputPerMillionUsd: 1, outputPerMillionUsd: 5 },
  // OpenAI
  // The Codex CLI's only accepted model with a ChatGPT-account login (see
  // BUILT_IN_MODELS in provider/Layers/CodexProvider.ts) — every thread's
  // Codex usage was reported unpriced until this was added.
  "gpt-6-astra": { inputPerMillionUsd: 10, outputPerMillionUsd: 50 },
  "gpt-5.6": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
  "gpt-5.6-sol": { inputPerMillionUsd: 4, outputPerMillionUsd: 20 },
  "gpt-5.6-terra": { inputPerMillionUsd: 2, outputPerMillionUsd: 12 },
  "gpt-5.6-luna": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.2 },
  "gpt-5.4": { inputPerMillionUsd: 2.5, outputPerMillionUsd: 15 },
  "gpt-5.4-mini": { inputPerMillionUsd: 0.75, outputPerMillionUsd: 4.5 },
  "gpt-5.4-nano": { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.25 },
  "gpt-5.3-codex": { inputPerMillionUsd: 1.75, outputPerMillionUsd: 14 },
  "gpt-5.2": { inputPerMillionUsd: 1.75, outputPerMillionUsd: 14 },
  "gpt-5.1": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 },
  "gpt-5": { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 },
  "gpt-5-mini": { inputPerMillionUsd: 0.25, outputPerMillionUsd: 2 },
  "gpt-5-nano": { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.4 },
  o3: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  "o3-mini": { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 },
};

/** Both providers bill a cache read at roughly a tenth of the input rate. */
const CACHED_INPUT_RATE_MULTIPLIER = 0.1;

/** A running total while buckets are folded together. */
interface UsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  estimatedInputCost: number;
  estimatedOutputCost: number;
  unpricedTokens: number;
  readonly unpricedModels: Set<string>;
}

function emptyUsage(): UsageAccumulator {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedInputCost: 0,
    estimatedOutputCost: 0,
    unpricedTokens: 0,
    unpricedModels: new Set(),
  };
}

/**
 * Adds one grouped row to a running total, pricing it where that is possible.
 *
 * Two things make a row unpriceable, and both land in `unpricedTokens` rather
 * than quietly costing nothing: a model the rate table has never heard of, and
 * a provider that reported a total but no input/output split, which leaves
 * nothing to multiply a rate by.
 */
function addBucket(accumulator: UsageAccumulator, bucket: CollaborationUsageBucketRecord): void {
  accumulator.inputTokens += bucket.inputTokens;
  accumulator.cachedInputTokens += bucket.cachedInputTokens;
  accumulator.outputTokens += bucket.outputTokens;
  accumulator.reasoningOutputTokens += bucket.reasoningOutputTokens;
  accumulator.totalTokens += bucket.totalTokens;

  const rate = bucket.model === null ? undefined : MODEL_TOKEN_RATES_USD[bucket.model];
  const hasSplit = bucket.inputTokens > 0 || bucket.outputTokens > 0;
  if (rate === undefined || !hasSplit) {
    accumulator.unpricedTokens += Math.max(
      bucket.totalTokens,
      bucket.inputTokens + bucket.outputTokens,
    );
    if (bucket.model !== null && rate === undefined) {
      accumulator.unpricedModels.add(bucket.model);
    }
    return;
  }

  // Cached input is a subset of input, charged at a discount. Clamped because
  // a provider that reports them independently would otherwise make the
  // uncached remainder negative.
  const uncachedInput = Math.max(0, bucket.inputTokens - bucket.cachedInputTokens);
  accumulator.estimatedInputCost +=
    (uncachedInput * rate.inputPerMillionUsd +
      bucket.cachedInputTokens * rate.inputPerMillionUsd * CACHED_INPUT_RATE_MULTIPLIER) /
    1_000_000;
  accumulator.estimatedOutputCost += (bucket.outputTokens * rate.outputPerMillionUsd) / 1_000_000;
}

/** Fractions of a cent are noise; six places is past anything meaningful. */
function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toTotals(accumulator: UsageAccumulator): CollaborationUsageTotals {
  return {
    inputTokens: accumulator.inputTokens,
    cachedInputTokens: accumulator.cachedInputTokens,
    outputTokens: accumulator.outputTokens,
    reasoningOutputTokens: accumulator.reasoningOutputTokens,
    totalTokens: accumulator.totalTokens,
  };
}

function toCostEstimate(accumulator: UsageAccumulator): CollaborationUsageCostEstimate {
  return {
    currency: "USD",
    estimatedInputCost: roundUsd(accumulator.estimatedInputCost),
    estimatedOutputCost: roundUsd(accumulator.estimatedOutputCost),
    estimatedTotalCost: roundUsd(accumulator.estimatedInputCost + accumulator.estimatedOutputCost),
    unpricedTokens: accumulator.unpricedTokens,
    unpricedModels: [...accumulator.unpricedModels].toSorted(),
  };
}

/** Only these two runtimes exist; anything else was written by an older build. */
function toProviderKind(value: string | null): ProviderKind | null {
  return value === "codex" || value === "claudeAgent" ? value : null;
}

/** The cumulative figures a provider reports for one thread. */
export interface ThreadTokenSnapshot {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}

export interface UsageObservation {
  /** What to append to the series, or null when this report adds nothing. */
  readonly delta: ThreadTokenSnapshot | null;
  /** Whether the stored record moved and therefore has to be written. */
  readonly changed: boolean;
  /** The figures to store back: a high-water total plus the new baseline. */
  readonly highWaterTotal: number;
  readonly baseline: ThreadTokenSnapshot;
}

/**
 * Turns one cumulative report into the change since the last one.
 *
 * Providers re-send a thread's running total many times per turn, so storing
 * what arrives would count the same tokens once per report and make every trend
 * chart meaningless. Every case below is a real thing providers do:
 *
 *   - No record at all — a thread's first report. The whole snapshot is the
 *     first sample; there is nothing earlier for it to be relative to.
 *   - A record with no baseline. Only rows written before migration 050 look
 *     like this. Their accumulated total is real but has no history behind it,
 *     so the report is adopted as the baseline and nothing is emitted: one
 *     skipped observation per existing thread, rather than months of spend
 *     arriving as a single spike on the day this ships.
 *   - An identical report. Emits nothing and touches nothing — this is the
 *     common case, several times a turn.
 *   - A lower figure. Compaction drops the reported total, and a provider that
 *     restarts drops it to near zero. Never a negative sample: the baseline
 *     follows the provider down so growth is measured from where it actually
 *     resumed, and the tokens spent climbing back are counted as they are
 *     reported, because re-processing that context does cost them again.
 *   - Anything else — the positive difference on each axis independently.
 *
 * The axes are not required to add up to `totalTokens`. `totalTokens` follows
 * the provider's headline figure, which is context occupancy for some runtimes
 * and cumulative spend for others; the split follows its own counters.
 *
 * The high-water total only ever climbs, which is what `buildMembers` sums, so
 * a member's displayed total can never go backwards.
 */
export function deriveUsageObservation(
  previous: CollaborationMemberUsageRecord | undefined,
  snapshot: ThreadTokenSnapshot,
): UsageObservation {
  if (previous === undefined) {
    const hasAny =
      snapshot.totalTokens > 0 || snapshot.inputTokens > 0 || snapshot.outputTokens > 0;
    return {
      delta: hasAny ? snapshot : null,
      changed: true,
      highWaterTotal: snapshot.totalTokens,
      baseline: snapshot,
    };
  }

  const highWaterTotal = Math.max(previous.totalTokens, snapshot.totalTokens);

  if (previous.lastTotalTokens === undefined || previous.lastTotalTokens === null) {
    return { delta: null, changed: true, highWaterTotal, baseline: snapshot };
  }

  const baseline: ThreadTokenSnapshot = {
    totalTokens: previous.lastTotalTokens,
    inputTokens: previous.lastInputTokens ?? 0,
    cachedInputTokens: previous.lastCachedInputTokens ?? 0,
    outputTokens: previous.lastOutputTokens ?? 0,
    reasoningOutputTokens: previous.lastReasoningOutputTokens ?? 0,
  };

  const isIdentical =
    snapshot.totalTokens === baseline.totalTokens &&
    snapshot.inputTokens === baseline.inputTokens &&
    snapshot.cachedInputTokens === baseline.cachedInputTokens &&
    snapshot.outputTokens === baseline.outputTokens &&
    snapshot.reasoningOutputTokens === baseline.reasoningOutputTokens;
  if (isIdentical) {
    return { delta: null, changed: false, highWaterTotal, baseline };
  }

  if (snapshot.totalTokens < baseline.totalTokens) {
    return { delta: null, changed: true, highWaterTotal, baseline: snapshot };
  }

  const delta: ThreadTokenSnapshot = {
    totalTokens: Math.max(0, snapshot.totalTokens - baseline.totalTokens),
    inputTokens: Math.max(0, snapshot.inputTokens - baseline.inputTokens),
    cachedInputTokens: Math.max(0, snapshot.cachedInputTokens - baseline.cachedInputTokens),
    outputTokens: Math.max(0, snapshot.outputTokens - baseline.outputTokens),
    reasoningOutputTokens: Math.max(
      0,
      snapshot.reasoningOutputTokens - baseline.reasoningOutputTokens,
    ),
  };
  const isEmpty =
    delta.totalTokens === 0 &&
    delta.inputTokens === 0 &&
    delta.cachedInputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.reasoningOutputTokens === 0;

  return {
    delta: isEmpty ? null : delta,
    changed: true,
    highWaterTotal,
    baseline: snapshot,
  };
}

/** `YYYY-MM-DD` in UTC, matching how the SQL rollup slices `observed_at`. */
function utcDay(instant: number): string {
  return new Date(instant).toISOString().slice(0, 10);
}

/** Every UTC day the window touches, so a quiet day is a zero and not a gap. */
function enumerateDays(sinceMs: number, untilMs: number): ReadonlyArray<string> {
  const days: string[] = [];
  const dayMs = 24 * 60 * 60 * 1000;
  let cursor = Date.parse(`${utcDay(sinceMs)}T00:00:00.000Z`);
  while (cursor < untilMs) {
    days.push(utcDay(cursor));
    cursor += dayMs;
  }
  return days.length > 0 ? days : [utcDay(sinceMs)];
}

const DEFAULT_APPROVAL_MODE = "open" as const;

/**
 * Settings a workspace has never been configured with. The lead is filled in
 * from whoever the workspace belongs to, and until someone changes the mode,
 * nothing is gated.
 */
function defaultSettings(input: {
  readonly tenantId: CollaborationWorkspaceSettings["tenantId"];
  readonly workspaceId: CollaborationWorkspaceSettings["workspaceId"];
  readonly leadUserId: UserId | null;
  readonly updatedAt: string;
}): CollaborationWorkspaceSettings {
  return {
    tenantId: input.tenantId,
    workspaceId: input.workspaceId,
    leadUserId: input.leadUserId,
    approvalMode: DEFAULT_APPROVAL_MODE,
    approverUserIds: [],
    updatedAt: input.updatedAt,
  };
}

/**
 * A stable colour per person, derived from the id so every client agrees
 * without the server handing out a palette. Hues are spread far enough apart
 * that neighbouring members stay tellable apart.
 *
 * The web app keeps its own copy of this — `memberColorForUserId` in
 * apps/web/src/components/collaboration/collaborationRoster.logic.ts — so that
 * a transcript can still colour a message whose author the roster no longer
 * lists. A test on each side pins the same two values; change one and the
 * other fails.
 */
export function defaultMemberColor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 70% 55%)`;
}

/** Initials for an avatar, from a name or failing that an email address. */
export function toAvatarInitials(displayName: string): string {
  const nameSource = displayName.includes("@")
    ? (displayName.split("@")[0] ?? displayName)
    : displayName;
  const parts = nameSource.split(/[\s._-]+/).filter((part) => part.length > 0);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return initials.length > 0 ? initials : "?";
}

/**
 * The workspaces one tenant membership actually reaches, or `null` when it
 * reaches the whole tenant.
 *
 * `TenantMembership` records a tenant, a user and roles, and nothing
 * narrower. So the membership `acceptInvite` mints for an invite that named
 * exactly one workspace is byte-for-byte the same thing as one minted for the
 * whole tenant, and every read below filters on the `workspaceId` the CALLER
 * asked for. A contractor invited to workspace A therefore asked for
 * workspace B and was answered: B's held approvals carry the full prompt
 * text, and the roster, activity feed, shared prompts and per-member token
 * spend all came with it.
 *
 * The invite is the record of what was actually offered, and invites are
 * persisted alongside the memberships, so the scope is recovered from them
 * rather than from a column the repository schema would have to grow.
 *
 * `null` — reaches everything — is returned in two cases, and they are
 * different on purpose:
 *   - an accepted invite named no workspace, which is what a tenant-scoped
 *     invite is;
 *   - there is no accepted invite at all, so this membership was not minted
 *     here. The tenant owner's own bootstrap row is the case that matters,
 *     and narrowing it to nothing would lock an owner out of their own
 *     tenant. It also keeps the single-user desktop install working, where
 *     nobody was ever invited to anything.
 */
function membershipWorkspaceReach(
  state: CollaborationState,
  tenantId: string,
  userId: string,
): ReadonlySet<string> | null {
  const accepted = Array.from(state.invites.values()).filter(
    (invite) =>
      invite.tenantId === tenantId &&
      invite.acceptedAt !== null &&
      invite.acceptedByUserId === userId,
  );
  if (accepted.length === 0) {
    return null;
  }
  const reach = new Set<string>();
  for (const invite of accepted) {
    if (invite.workspaceId === null) {
      return null;
    }
    reach.add(invite.workspaceId);
  }
  return reach;
}

/**
 * How much of one tenant a caller may read, as the reads below need it.
 *
 * `membershipWorkspaceReach` answers "which workspaces was this person
 * invited to", which is one half of the question. The other half is whether
 * the membership that invite minted is still there and still enabled, because
 * `removeMember` deletes the row and leaves the invite behind. Both halves had
 * to be re-derived at every call site that wanted them, so they live here once:
 *
 *   - `everything` — a tenant-scoped invite, the owner's bootstrap row, or a
 *     desktop install where nobody was invited to anything.
 *   - `nothing` — an invited collaborator whose membership is gone or disabled.
 *   - `workspaces` — exactly the workspaces their invites named.
 */
type TenantReadReach =
  | { readonly _tag: "everything" }
  | { readonly _tag: "nothing" }
  | { readonly _tag: "workspaces"; readonly workspaceIds: ReadonlySet<string> };

function tenantReadReach(
  state: CollaborationState,
  tenantId: string,
  userId: string,
): TenantReadReach {
  const reach = membershipWorkspaceReach(state, tenantId, userId);
  if (reach === null) {
    return { _tag: "everything" };
  }
  const membership = Array.from(state.memberships.values()).find(
    (candidate) =>
      candidate.tenantId === tenantId &&
      candidate.userId === userId &&
      candidate.disabledAt === null,
  );
  return membership === undefined
    ? { _tag: "nothing" }
    : { _tag: "workspaces", workspaceIds: reach };
}

/** The lead approves by definition; everyone else has to be named. */
function isApprover(settings: CollaborationWorkspaceSettings, userId: UserId): boolean {
  if (settings.leadUserId === userId) {
    return true;
  }
  return settings.approverUserIds.includes(userId);
}

/**
 * Whether anyone OTHER than the requester could ever decide a queued
 * approval. A solo workspace, or one where the lead removed themselves
 * without naming a replacement, has none — queuing a prompt there would
 * block its author forever with nobody able to help them.
 */
function hasEligibleApprover(
  settings: CollaborationWorkspaceSettings,
  requesterId: UserId,
): boolean {
  if (settings.leadUserId !== null && settings.leadUserId !== requesterId) {
    return true;
  }
  return settings.approverUserIds.some((id) => id !== requesterId);
}

function inviteAcceptUrlPath(inviteId: string): string {
  const search = new URLSearchParams([["invite", inviteId]]);
  return `/invite?${search.toString()}`;
}

function validateInviteScope(input: {
  readonly scope: "tenant" | "workspace" | "project";
  readonly workspaceId: string | null;
}) {
  if ((input.scope === "workspace" || input.scope === "project") && input.workspaceId === null) {
    return Effect.fail(
      new CollaborationError({
        code: "invalid-membership-rule",
        message: "Workspace-scoped collaboration invites must include a workspace.",
      }),
    );
  }
  return Effect.void;
}

function toPromptSummary(actor: CollaborationActor, prompt: string): string {
  const normalizedPrompt = prompt.trim().replace(/\s+/g, " ");
  const excerpt =
    normalizedPrompt.length > 96
      ? `${normalizedPrompt.slice(0, 93).trimEnd()}...`
      : normalizedPrompt;
  return `${actor.displayName} shared a prompt: ${excerpt}`;
}

function newActivityId() {
  return CollaborationActivityId.make(`activity:${crypto.randomUUID()}`);
}

/**
 * How much shared history one tenant keeps in memory.
 *
 * Per tenant, because the cap used to be global: the newest 999 rows on the
 * whole instance, whoever they belonged to. One busy workspace therefore
 * pushed every other workspace's history out, and since persistence rewrites
 * the table from this state, what fell out of memory was deleted from disk —
 * another tenant's audit trail destroyed by activity they cannot see and did
 * not cause.
 */
const ACTIVITIES_PER_TENANT_LIMIT = 200;

/**
 * And how much the instance keeps in total, whatever the split.
 *
 * A per-tenant cap alone is not a bound: the number of tenants is not bounded,
 * and every mutation persists the whole array, so "200 each" on a thousand
 * tenants is a two-hundred-thousand-row write on every keystroke of presence.
 * This is the backstop that keeps that arithmetic finite. It is deliberately
 * far above the per-tenant limit so that in ordinary use it never binds and the
 * per-tenant rule is what people actually experience.
 */
const ACTIVITIES_TOTAL_LIMIT = 10_000;

export function appendActivity(
  state: CollaborationState,
  activity: CollaborationState["activities"][number],
): CollaborationState {
  const appended = [...state.activities, activity];

  // Only the tenant that just grew can be over its limit, so only its rows are
  // considered. Oldest-first within that tenant; identity comparison is safe
  // because these are the very objects held in state.
  const ownRows = appended.filter((entry) => entry.tenantId === activity.tenantId);
  const excess = ownRows.length - ACTIVITIES_PER_TENANT_LIMIT;
  const dropped = excess > 0 ? new Set(ownRows.slice(0, excess)) : null;
  const trimmed = dropped ? appended.filter((entry) => !dropped.has(entry)) : appended;

  return {
    ...state,
    activities:
      trimmed.length > ACTIVITIES_TOTAL_LIMIT ? trimmed.slice(-ACTIVITIES_TOTAL_LIMIT) : trimmed,
  };
}

/**
 * The key a live claim is filed under.
 *
 * `kind` and `sourceId` are in it deliberately. Somebody with a file open while
 * their own turn writes it is two rows, and that pair *is* the warning; keyed
 * on the person alone the second claim would overwrite the first and the file
 * would look quietly occupied by one thing.
 */
function filePresenceKey(entry: {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly path: string;
  readonly userId: string;
  readonly kind: string;
  readonly sourceId: string;
}): string {
  return [
    entry.tenantId,
    entry.workspaceId,
    entry.path,
    entry.userId,
    entry.kind,
    entry.sourceId,
  ].join(":");
}

/** The shape the shared rules read. Nothing tenancy-specific reaches them. */
function toPresenceEntry(presence: CollaborationFilePresence): FilePresenceEntry {
  return {
    path: presence.path,
    userId: presence.userId,
    displayName: presence.displayName,
    kind: presence.kind,
    sourceId: presence.sourceId,
    refreshedAt: presence.refreshedAt,
  };
}

/** Enough to take one row out of a browser's copy without re-reading the lot. */
function toRelease(entry: CollaborationFilePresence): CollaborationFilePresenceRelease {
  return {
    path: entry.path,
    userId: entry.userId,
    kind: entry.kind,
    sourceId: entry.sourceId,
  };
}

/** A browser has no id of its own to offer, so its session stands in. */
function sourceOf(input: { readonly sourceId?: string | undefined }, fallback: string): string {
  return input.sourceId ?? fallback;
}

const makeCollaborationService = Effect.gen(function* () {
  const repository = yield* TenancyRepository;
  const activityNotes = yield* ActivityNoteRepository;
  const sharedPrompts = yield* SharedPromptRepository;
  const persisted = yield* repository.loadCollaboration().pipe(
    Effect.mapError(
      (cause) =>
        new CollaborationError({
          code: "invalid-membership-rule",
          message: "Failed to load persisted collaboration state.",
          cause,
        }),
    ),
  );
  const events = yield* PubSub.unbounded<CollaborationStreamEvent>();
  const stateRef = yield* Ref.make<CollaborationState>({
    presence: new Map(
      persisted.presence.map((presence) => [
        presenceKey({
          tenantId: presence.tenantId,
          workspaceId: presence.workspaceId,
          threadId: presence.threadId,
          userId: presence.userId,
        }),
        presence,
      ]),
    ),
    invites: new Map(persisted.invites.map((invite) => [invite.id, invite])),
    memberships: new Map(
      persisted.memberships
        .filter((membership) => membership.organizationId === null)
        .map((membership) => [membership.id, membership]),
    ),
    activities: persisted.activities,
    settings: new Map(
      (persisted.settings ?? []).map((entry) => [
        workspaceKey(entry.tenantId, entry.workspaceId),
        entry,
      ]),
    ),
    approvals: new Map((persisted.approvals ?? []).map((entry) => [entry.id, entry])),
    viewPreferences: new Map(
      (persisted.viewPreferences ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    branchClaims: new Map(
      (persisted.branchClaims ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    fileTouches: new Map(
      // Same key as touchFiles writes: per person as well as per path, or
      // reloading would collapse two authors back down to one.
      (persisted.fileTouches ?? []).map((entry) => [
        `${scopedKey(entry.tenantId, entry.workspaceId, entry.path)}:${entry.userId}`,
        entry,
      ]),
    ),
    filePresence: new Map(
      // Pruned on the way in, not just on the way out. A server that was down
      // longer than a claim's deadline must come back to an empty room; loading
      // the rows and filtering later would leave a window where a restart
      // resurrected somebody who left hours ago.
      (persisted.filePresence ?? [])
        .filter((entry) => isFilePresenceLive(toPresenceEntry(entry), Date.now()))
        .map((entry) => [filePresenceKey(entry), entry]),
    ),
    memberProfiles: new Map(
      (persisted.memberProfiles ?? []).map((entry) => [
        scopedKey(entry.tenantId, entry.workspaceId, entry.userId),
        entry,
      ]),
    ),
    memberUsage: new Map(
      (persisted.memberUsage ?? []).map((entry) => [
        usageKey(entry.tenantId, entry.workspaceId, entry.userId, entry.threadId),
        entry,
      ]),
    ),
  });

  /** The workspace owner is the lead, when the workspace is known at all. */
  const resolveLeadUserId = (workspaceId: string) =>
    repository.loadWorkspaces().pipe(
      Effect.map(
        (snapshot) =>
          snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.ownerUserId ??
          null,
      ),
      Effect.catchCause(() => Effect.succeed(null)),
    );

  const persist = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      repository.saveCollaboration({
        presence: Array.from(state.presence.values()),
        invites: Array.from(state.invites.values()),
        memberships: Array.from(state.memberships.values()),
        activities: state.activities,
        settings: Array.from(state.settings.values()),
        approvals: Array.from(state.approvals.values()),
        viewPreferences: Array.from(state.viewPreferences.values()),
        branchClaims: Array.from(state.branchClaims.values()),
        fileTouches: Array.from(state.fileTouches.values()),
        filePresence: Array.from(state.filePresence.values()),
        memberProfiles: Array.from(state.memberProfiles.values()),
        memberUsage: Array.from(state.memberUsage.values()),
      }),
    ),
    Effect.mapError(
      (cause) =>
        new CollaborationError({
          code: "invalid-membership-rule",
          message: "Failed to persist collaboration state.",
          cause,
        }),
    ),
  );

  /**
   * Refuses a read of a workspace the caller was never invited into.
   *
   * Deliberately NOT softened by "unless they are this workspace's lead or an
   * approver": somebody invited only to workspace A is nobody in workspace B
   * until B invites them, and an approver list is not an invite. Being wrong in
   * that direction costs one more invite; being wrong in the other direction is
   * the leak this exists to close.
   */
  const ensureWorkspaceReach = (
    actor: CollaborationActor,
    input: { readonly tenantId: string; readonly workspaceId: string },
  ): Effect.Effect<void, CollaborationError> =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) => {
        const reach = tenantReadReach(state, input.tenantId, actor.userId);
        const reaches =
          reach._tag === "everything" ||
          (reach._tag === "workspaces" && reach.workspaceIds.has(input.workspaceId));
        return reaches
          ? Effect.void
          : Effect.fail(
              new CollaborationError({
                code: "invalid-membership-rule",
                message: "You are not a member of this workspace.",
              }),
            );
      }),
    );

  const upsertPresence: CollaborationServiceShape["upsertPresence"] = (actor, input) => {
    const createdAt = nowIso();
    const presence = {
      userId: actor.userId,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      displayName: actor.displayName,
      ...(actor.avatarInitials ? { avatarInitials: actor.avatarInitials } : {}),
      status: input.status,
      lastSeenAt: createdAt,
    };
    return ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() =>
        Ref.update(stateRef, (state) => {
          const nextPresence = new Map(state.presence);
          nextPresence.set(
            presenceKey({
              tenantId: input.tenantId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              userId: actor.userId,
            }),
            presence,
          );

          const activityKind = input.status === "offline" ? "left" : "joined";
          return appendActivity(
            {
              ...state,
              presence: nextPresence,
            },
            {
              id: newActivityId(),
              tenantId: input.tenantId,
              workspaceId: input.workspaceId,
              threadId: input.threadId,
              userId: actor.userId,
              kind: activityKind,
              hiddenAt: null,
              summary:
                input.status === "offline"
                  ? `${actor.displayName} left the workspace.`
                  : `${actor.displayName} is present in the workspace.`,
              createdAt,
            },
          );
        }),
      ),
      Effect.flatMap(() => persist),
      Effect.tap(() => PubSub.publish(events, { type: "presence-upserted", presence })),
      Effect.as({ presence }),
    );
  };

  const listPresence: CollaborationServiceShape["listPresence"] = (actor, input) =>
    ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() => Ref.get(stateRef)),
      Effect.map((state) => ({
        users: Array.from(state.presence.values()).filter(
          (presence) =>
            presence.tenantId === input.tenantId &&
            presence.workspaceId === input.workspaceId &&
            (input.threadId === undefined || presence.threadId === input.threadId),
        ),
      })),
    );

  const createInvite: CollaborationServiceShape["createInvite"] = (actor, input) =>
    Effect.gen(function* () {
      yield* validateInviteScope(input);
      // A workspace-scoped invite names a workspace, and the inviter has to
      // reach it: otherwise one workspace's contractor could hand out access
      // to every other workspace in the tenant. A TENANT-scoped invite names
      // none, so there is no workspace to check — the tenant permission ws.ts
      // already required is the whole of its authority.
      if (input.workspaceId !== null) {
        yield* ensureWorkspaceReach(actor, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
        });
      }
      const createdAt = nowIso();
      const invite: TenantInvite = {
        id: InviteId.make(`invite:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        invitedByUserId: actor.userId,
        email: input.email,
        scope: input.scope,
        roles: input.roles,
        createdAt,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      };

      const activity = {
        id: newActivityId(),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "invited" as const,
        hiddenAt: null,
        summary: `${actor.displayName} invited ${input.email}.`,
        createdAt,
      };

      yield* Ref.update(stateRef, (state) => {
        const invites = new Map(state.invites);
        invites.set(invite.id, invite);
        return appendActivity(
          {
            ...state,
            invites,
          },
          activity,
        );
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "invite-created", invite });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite,
        acceptUrlPath: inviteAcceptUrlPath(invite.id),
      };
    });

  /**
   * An invite carries the address of the person invited, so a listing of them
   * is a listing of who else is in the tenant. `workspaceId` is optional here,
   * and the tenant-wide form is the one that leaked: a contractor invited to
   * workspace A asked for the tenant and was handed every address every other
   * workspace had invited.
   *
   * Asking for one workspace is refused outright when it is not theirs, the
   * same as every other read. Asking tenant-wide is answered, but narrowed to
   * what they could have asked for one workspace at a time.
   */
  const listInvites: CollaborationServiceShape["listInvites"] = (actor, input) =>
    Effect.gen(function* () {
      const workspaceId = input.workspaceId ?? null;
      if (workspaceId !== null) {
        yield* ensureWorkspaceReach(actor, { tenantId: input.tenantId, workspaceId });
      }
      const state = yield* Ref.get(stateRef);
      const reach = tenantReadReach(state, input.tenantId, actor.userId);
      if (reach._tag === "nothing") {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "You are not a member of this workspace.",
        });
      }
      return {
        invites: Array.from(state.invites.values()).filter((invite) => {
          if (invite.tenantId !== input.tenantId) {
            return false;
          }
          if (workspaceId !== null) {
            return invite.workspaceId === workspaceId;
          }
          // A tenant-scoped invite belongs to no one workspace, so there is no
          // workspace to be a member of — whoever may read the tenant at all
          // may read those. A workspace-scoped one needs the workspace.
          return (
            reach._tag === "everything" ||
            invite.workspaceId === null ||
            reach.workspaceIds.has(invite.workspaceId)
          );
        }),
      };
    });

  const acceptInvite: CollaborationServiceShape["acceptInvite"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const invite = state.invites.get(input.inviteId);
      if (!invite) {
        return yield* new CollaborationError({
          code: "invalid-invite",
          message: "Collaboration invite was not found.",
        });
      }

      if (invite.revokedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-revoked",
          message: "Collaboration invite has been revoked.",
        });
      }

      if (invite.acceptedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-accepted",
          message: "Collaboration invite has already been accepted.",
        });
      }

      if (Date.parse(invite.expiresAt) <= Date.now()) {
        return yield* new CollaborationError({
          code: "invite-expired",
          message: "Collaboration invite has expired.",
        });
      }

      // An invite names a person. Nothing used to check that the person
      // redeeming it was that person, so an accept URL forwarded, pasted into a
      // shared channel, or simply opened on a machine signed in as somebody
      // else granted that somebody else a membership in the tenant — and with
      // it file.read and file.write on every project root the tenant owns.
      //
      // Refused only on a positive mismatch. An actor with no provable address
      // is let through deliberately: `email` is resolved from the account
      // record and a hosted account may not have one on this install, so
      // refusing the absent case would lock every such member out of every
      // invite. That leaves a real gap for installs that cannot prove an
      // address, and closing it means giving those accounts a provable one
      // rather than tightening the test here.
      const invitedEmail = invite.email?.trim().toLowerCase();
      const actorEmail = actor.email?.trim().toLowerCase();
      if (invitedEmail && actorEmail && invitedEmail !== actorEmail) {
        return yield* new CollaborationError({
          code: "invalid-invite",
          message: "This invite was sent to a different account.",
        });
      }

      const acceptedAt = nowIso();
      const acceptedInvite = {
        ...invite,
        acceptedAt,
        acceptedByUserId: actor.userId,
      };
      const membership: TenantMembership = {
        id: MembershipId.make(`membership:${crypto.randomUUID()}`),
        tenantId: invite.tenantId,
        userId: actor.userId,
        organizationId: null,
        roles: invite.roles,
        createdAt: acceptedAt,
        disabledAt: null,
      };
      const invites = new Map(state.invites);
      const memberships = new Map(state.memberships);
      invites.set(acceptedInvite.id, acceptedInvite);
      memberships.set(membership.id, membership);

      const activity = {
        id: newActivityId(),
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "accepted-invite" as const,
        hiddenAt: null,
        summary: `${actor.displayName} accepted a collaboration invite.`,
        createdAt: acceptedAt,
      };

      yield* Ref.set(
        stateRef,
        appendActivity(
          {
            ...state,
            invites,
            memberships,
          },
          activity,
        ),
      );
      yield* persist;
      yield* PubSub.publish(events, {
        type: "invite-accepted",
        invite: acceptedInvite,
        membership,
      });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite: acceptedInvite,
        membership,
      };
    });

  const revokeInvite: CollaborationServiceShape["revokeInvite"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const invite = state.invites.get(input.inviteId);
      if (!invite || invite.tenantId !== input.tenantId) {
        return yield* new CollaborationError({
          code: "invalid-invite",
          message: "Collaboration invite was not found.",
        });
      }

      // Checked against the INVITE's workspace, not a workspace the caller
      // named: the id is the only thing they send, so a tenant-wide
      // `workspace.invite` permission let anybody cancel any pending invite in
      // the tenant — including the owner's invites into workspaces the caller
      // has never been able to see.
      if (invite.workspaceId !== null) {
        yield* ensureWorkspaceReach(actor, {
          tenantId: invite.tenantId,
          workspaceId: invite.workspaceId,
        });
      }

      if (invite.revokedAt !== null) {
        return {
          invite,
        };
      }

      if (invite.acceptedAt !== null) {
        return yield* new CollaborationError({
          code: "invite-accepted",
          message: "Accepted collaboration invites cannot be revoked.",
        });
      }

      const revokedAt = nowIso();
      const revokedInvite = {
        ...invite,
        revokedAt,
      };
      const activity = {
        id: newActivityId(),
        tenantId: invite.tenantId,
        workspaceId: invite.workspaceId ?? null,
        threadId: null,
        userId: actor.userId,
        kind: "revoked-invite" as const,
        hiddenAt: null,
        summary: `${actor.displayName} revoked an invite for ${invite.email}.`,
        createdAt: revokedAt,
      };

      yield* Ref.update(stateRef, (current) => {
        const invites = new Map(current.invites);
        invites.set(revokedInvite.id, revokedInvite);
        return appendActivity(
          {
            ...current,
            invites,
          },
          activity,
        );
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "invite-revoked", invite: revokedInvite });
      yield* PubSub.publish(events, { type: "activity-appended", activity });

      return {
        invite: revokedInvite,
      };
    });

  const recordSharedPrompt: CollaborationServiceShape["recordSharedPrompt"] = (actor, input) => {
    const activity = {
      id: newActivityId(),
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      userId: actor.userId,
      kind: "prompted" as const,
      summary: toPromptSummary(actor, input.prompt),
      hiddenAt: null,
      createdAt: nowIso(),
    };
    return ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() => Ref.update(stateRef, (state) => appendActivity(state, activity))),
      Effect.flatMap(() => persist),
      Effect.tap(() => PubSub.publish(events, { type: "activity-appended", activity })),
      Effect.as({ activity }),
    );
  };

  const listActivity: CollaborationServiceShape["listActivity"] = (actor, input) =>
    ensureWorkspaceReach(actor, input).pipe(
      Effect.andThen(Ref.get(stateRef)),
      Effect.map((state) => {
        const limit = Math.min(input.limit ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
        const activities = state.activities.filter(
          (activity) =>
            activity.tenantId === input.tenantId &&
            activity.workspaceId === input.workspaceId &&
            (input.threadId === undefined || activity.threadId === input.threadId) &&
            // Hidden entries stay visible to the person who wrote them.
            (activity.hiddenAt === null || activity.userId === actor.userId),
        );
        return {
          activities: activities.slice(-limit).toReversed(),
        };
      }),
    );

  const setActivityVisibility: CollaborationServiceShape["setActivityVisibility"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const state = yield* Ref.get(stateRef);
      const existing = state.activities.find(
        (activity) =>
          activity.id === input.activityId &&
          activity.tenantId === input.tenantId &&
          activity.workspaceId === input.workspaceId,
      );
      if (!existing) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Shared activity was not found.",
        });
      }
      // Your own history is yours to curate; nobody else edits it for you.
      if (existing.userId !== actor.userId) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the author can change what they share.",
        });
      }

      const updated = { ...existing, hiddenAt: input.hidden ? nowIso() : null };
      yield* Ref.update(stateRef, (current) => ({
        ...current,
        activities: current.activities.map((activity) =>
          activity.id === updated.id ? updated : activity,
        ),
      }));
      yield* persist;
      yield* PubSub.publish(events, { type: "activity-visibility-changed", activity: updated });

      return { activity: updated };
    });

  // Persistence stores ids as plain strings (storage stays dumb, same
  // reasoning as `ShareLinks.ts`); the contract layer brands them, so every
  // id gets re-branded here on the one boundary where a plain string becomes
  // a `TenantId`/`WorkspaceId`/`UserId` again. Safe: the value only ever got
  // into this row by having already satisfied the brand on the way in.
  function toContractNote(record: ActivityNoteRecord) {
    return {
      id: record.id,
      authorId: UserId.make(record.authorId),
      targetType: record.targetType,
      targetId: record.targetId,
      parentNoteId: record.parentNoteId,
      body: record.body,
      status: record.status,
      visibility: record.visibility,
      createdAt: DateTime.formatIso(record.createdAt),
      resolvedAt: record.resolvedAt ? DateTime.formatIso(record.resolvedAt) : null,
      resolvedByUserId: record.resolvedByUserId ? UserId.make(record.resolvedByUserId) : null,
    };
  }

  function toContractSharedPrompt(record: SharedPromptRecord) {
    return {
      id: record.id,
      tenantId: TenantId.make(record.tenantId),
      workspaceId: WorkspaceId.make(record.workspaceId),
      sharedByUserId: UserId.make(record.sharedByUserId),
      promptText: record.promptText,
      sourceThreadId: record.sourceThreadId ? ThreadId.make(record.sourceThreadId) : null,
      sourceTurnId: record.sourceTurnId ? TurnId.make(record.sourceTurnId) : null,
      createdAt: DateTime.formatIso(record.createdAt),
    };
  }

  const mapPersistenceError = (message: string) => (cause: unknown) =>
    new CollaborationError({ code: "invalid-membership-rule", message, cause });

  const createSharedPrompt: CollaborationServiceShape["createSharedPrompt"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const now = yield* DateTime.now;
      const record = yield* sharedPrompts
        .create({
          id: `shared-prompt:${crypto.randomUUID()}`,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          sharedByUserId: actor.userId,
          promptText: input.promptText,
          sourceThreadId: input.sourceThreadId ?? null,
          sourceTurnId: input.sourceTurnId ?? null,
          createdAt: now,
        })
        .pipe(Effect.mapError(mapPersistenceError("Failed to share prompt.")));
      const sharedPrompt = toContractSharedPrompt(record);
      yield* PubSub.publish(events, { type: "shared-prompt-created", sharedPrompt });
      return { sharedPrompt };
    });

  const listSharedPrompts: CollaborationServiceShape["listSharedPrompts"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const records = yield* sharedPrompts
        .listForWorkspace({ tenantId: input.tenantId, workspaceId: input.workspaceId })
        .pipe(Effect.mapError(mapPersistenceError("Failed to list shared prompts.")));
      return { sharedPrompts: records.map(toContractSharedPrompt) };
    });

  /**
   * `tenantId`/`workspaceId` on the created note-event: resolved from the
   * shared prompt for a prompt note (so the workspace stream can filter
   * correctly), `null` for a direct message (not workspace-scoped — see the
   * event schema's own doc comment for why that means no live delivery yet).
   */
  const createNote: CollaborationServiceShape["createNote"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      if (input.targetType === "prompt") {
        const prompt = yield* sharedPrompts
          .getById({ id: input.targetId })
          .pipe(Effect.mapError(mapPersistenceError("Failed to look up shared prompt.")));
        if (prompt._tag === "None") {
          return yield* new CollaborationError({
            code: "shared-prompt-not-found",
            message: "That shared prompt no longer exists.",
          });
        }
      }

      const now = yield* DateTime.now;
      const record = yield* activityNotes
        .create({
          id: `note:${crypto.randomUUID()}`,
          authorId: actor.userId,
          targetType: input.targetType,
          targetId: input.targetId,
          parentNoteId: input.parentNoteId ?? null,
          body: input.body,
          visibility: input.targetType === "prompt" ? "public" : "direct",
          createdAt: now,
        })
        .pipe(Effect.mapError(mapPersistenceError("Failed to create note.")));

      const note = toContractNote(record);
      yield* PubSub.publish(events, {
        type: "note-created",
        note,
        tenantId: input.targetType === "prompt" ? input.tenantId : null,
        workspaceId: input.targetType === "prompt" ? input.workspaceId : null,
      });
      return { note };
    });

  const listNotesForTarget: CollaborationServiceShape["listNotesForTarget"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      // A `user` target is a direct-message thread, and `target_id` names only
      // the RECIPIENT — so a read by target returned every message anyone had
      // ever sent that person, to anyone who could name them. The thread a
      // caller is entitled to is the one they are themselves a party to, which
      // `listDirectMessagesBetween` already scopes correctly for
      // `listDirectMessages`; this path just has to use it too.
      const records = yield* (
        input.targetType === "user"
          ? activityNotes.listDirectMessagesBetween({
              userIdA: actor.userId,
              userIdB: input.targetId,
            })
          : activityNotes.listForTarget({
              targetType: input.targetType,
              targetId: input.targetId,
            })
      ).pipe(Effect.mapError(mapPersistenceError("Failed to list notes.")));
      return { notes: records.map(toContractNote) };
    });

  const resolveNote: CollaborationServiceShape["resolveNote"] = (actor, input) =>
    Effect.gen(function* () {
      const existing = yield* activityNotes
        .getById({ id: input.noteId })
        .pipe(Effect.mapError(mapPersistenceError("Failed to look up note.")));
      if (existing._tag === "None") {
        return yield* new CollaborationError({
          code: "note-not-found",
          message: "That note was not found.",
        });
      }
      if (existing.value.targetType !== "prompt") {
        return yield* new CollaborationError({
          code: "note-not-found",
          message: "Only a note on a shared prompt can be resolved.",
        });
      }
      const prompt = yield* sharedPrompts
        .getById({ id: existing.value.targetId })
        .pipe(Effect.mapError(mapPersistenceError("Failed to look up shared prompt.")));
      // Only the prompt's own author may resolve feedback on it -- the same
      // "your own history is yours to curate" rule setActivityVisibility uses.
      if (prompt._tag === "None" || prompt.value.sharedByUserId !== actor.userId) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the person who shared this prompt can resolve notes on it.",
        });
      }

      const now = yield* DateTime.now;
      const resolved = yield* activityNotes
        .resolve({ id: input.noteId, resolvedByUserId: actor.userId, resolvedAt: now })
        .pipe(Effect.mapError(mapPersistenceError("Failed to resolve note.")));
      if (resolved._tag === "None") {
        return yield* new CollaborationError({
          code: "note-not-found",
          message: "That note was not found.",
        });
      }

      const note = toContractNote(resolved.value);
      yield* PubSub.publish(events, {
        type: "note-resolved",
        note,
        tenantId: TenantId.make(prompt.value.tenantId),
        workspaceId: WorkspaceId.make(prompt.value.workspaceId),
      });
      return { note };
    });

  const listDirectMessages: CollaborationServiceShape["listDirectMessages"] = (actor, input) =>
    Effect.gen(function* () {
      const records = yield* activityNotes
        .listDirectMessagesBetween({ userIdA: actor.userId, userIdB: input.withUserId })
        .pipe(Effect.mapError(mapPersistenceError("Failed to list direct messages.")));
      return { messages: records.map(toContractNote) };
    });

  /**
   * The workspace check has to happen inside the stream, not before it: the
   * caller is a subscription that stays open, and `ws.ts` re-runs its own
   * tenant check on every event for exactly that reason. `Stream.unwrap` over
   * `ensureWorkspaceReach` refuses at subscribe time and surfaces as a failed
   * stream, which is what a refused read looks like to the client either way.
   */
  const stream: CollaborationServiceShape["stream"] = (actor, input) =>
    Stream.unwrap(ensureWorkspaceReach(actor, input).pipe(Effect.as(workspaceEvents(input))));

  const workspaceEvents = (input: CollaborationStreamInput) =>
    Stream.fromPubSub(events).pipe(
      Stream.filter((event) => {
        switch (event.type) {
          case "presence-upserted":
            return (
              event.presence.tenantId === input.tenantId &&
              event.presence.workspaceId === input.workspaceId &&
              (input.threadId === undefined || event.presence.threadId === input.threadId)
            );
          case "invite-created":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "invite-accepted":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "invite-revoked":
            return (
              event.invite.tenantId === input.tenantId &&
              (event.invite.workspaceId === null || event.invite.workspaceId === input.workspaceId)
            );
          case "activity-appended":
          case "activity-visibility-changed":
            return (
              event.activity.tenantId === input.tenantId &&
              event.activity.workspaceId === input.workspaceId &&
              (input.threadId === undefined || event.activity.threadId === input.threadId)
            );
          case "settings-updated":
            return (
              event.settings.tenantId === input.tenantId &&
              event.settings.workspaceId === input.workspaceId
            );
          case "approval-requested":
          case "approval-decided":
            // Not filtered by thread: the approval queue is workspace-wide, and
            // an approver watching one thread still has to see the others.
            return (
              event.approval.tenantId === input.tenantId &&
              event.approval.workspaceId === input.workspaceId
            );
          case "branch-claimed":
            return (
              event.claim.tenantId === input.tenantId &&
              event.claim.workspaceId === input.workspaceId
            );
          case "branch-released":
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "member-updated":
            return (
              event.member.tenantId === input.tenantId &&
              event.member.workspaceId === input.workspaceId
            );
          case "member-removed":
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "files-touched":
            return event.touches.some(
              (touch) =>
                touch.tenantId === input.tenantId && touch.workspaceId === input.workspaceId,
            );
          case "file-presence-changed":
            // Not filtered by thread. A file is a workspace-wide thing and the
            // whole point is that somebody in a different thread — or in no
            // thread at all — is the one about to lose work.
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "note-created":
          case "note-resolved":
            // `null` tenant/workspace means a direct message, which is not
            // workspace-scoped and is never delivered through this stream.
            return event.tenantId === input.tenantId && event.workspaceId === input.workspaceId;
          case "shared-prompt-created":
            return (
              event.sharedPrompt.tenantId === input.tenantId &&
              event.sharedPrompt.workspaceId === input.workspaceId
            );
        }
      }),
    );

  /** Reads stored settings, falling back to defaults derived from the workspace. */
  const resolveSettings = Effect.fn("resolveSettings")(function* (input: {
    readonly tenantId: CollaborationWorkspaceSettings["tenantId"];
    readonly workspaceId: CollaborationWorkspaceSettings["workspaceId"];
  }) {
    const state = yield* Ref.get(stateRef);
    const stored = state.settings.get(workspaceKey(input.tenantId, input.workspaceId));
    if (stored) {
      return stored;
    }
    const leadUserId = yield* resolveLeadUserId(input.workspaceId);
    return defaultSettings({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      leadUserId,
      updatedAt: nowIso(),
    });
  });

  const getSettings: CollaborationServiceShape["getSettings"] = (actor, input) =>
    ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() => resolveSettings(input)),
      Effect.map((settings) => ({
        settings,
        canManage: isApprover(settings, actor.userId),
      })),
    );

  const updateSettings: CollaborationServiceShape["updateSettings"] = (actor, input) =>
    Effect.gen(function* () {
      // Before the bootstrap allowance below, not after it: an unconfigured
      // workspace has no lead, so the first caller becomes one — and without
      // this, "the first caller" included anybody holding a workspace-scoped
      // invite to somewhere ELSE in the tenant. Lead is approver, and approver
      // decides queued prompts, edits members and removes them, so seizing an
      // unconfigured workspace was the whole chain in one call.
      yield* ensureWorkspaceReach(actor, input);
      const current = yield* resolveSettings(input);
      // A workspace with no owner on record has nobody who could ever qualify,
      // so let the first caller configure it rather than locking it forever.
      if (current.leadUserId !== null && !isApprover(current, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can change collaboration settings.",
        });
      }

      const next: CollaborationWorkspaceSettings = {
        ...current,
        leadUserId: current.leadUserId ?? actor.userId,
        approvalMode: input.approvalMode ?? current.approvalMode,
        approverUserIds: input.approverUserIds ?? current.approverUserIds,
        updatedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const settings = new Map(state.settings);
        settings.set(workspaceKey(next.tenantId, next.workspaceId), next);
        return { ...state, settings };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "settings-updated", settings: next });

      return {
        settings: next,
        canManage: isApprover(next, actor.userId),
      };
    });

  /** The oldest approved-but-unspent approval this person still holds. */
  const findSpendableApproval = Effect.fn("findSpendableApproval")(function* (
    userId: UserId,
    input: { readonly tenantId: string; readonly workspaceId: string },
  ) {
    const state = yield* Ref.get(stateRef);
    return (
      Array.from(state.approvals.values())
        .filter(
          (approval) =>
            approval.tenantId === input.tenantId &&
            approval.workspaceId === input.workspaceId &&
            approval.requestedByUserId === userId &&
            approval.status === "approved" &&
            approval.consumedAt === null,
        )
        .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))[0] ?? null
    );
  });

  const submitPromptForApproval: CollaborationServiceShape["submitPromptForApproval"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const settings = yield* resolveSettings(input);
      // Approvers never queue behind themselves, and an open workspace queues
      // nobody, so both cases skip the record entirely.
      if (settings.approvalMode === "open" || isApprover(settings, actor.userId)) {
        return { approval: null, mayRun: true };
      }

      // Queuing a prompt nobody can ever decide would block its author
      // permanently — a solo workspace, or one where the lead left without
      // naming a replacement. Fail open here for the same reason an open
      // workspace queues nobody: a governance gate that cannot be exercised
      // is worse than no gate at all.
      if (!hasEligibleApprover(settings, actor.userId)) {
        return { approval: null, mayRun: true };
      }

      // A prompt that has already been approved and not yet spent is what the
      // author re-sends after being told to wait. Queueing it again would mean
      // they could never actually run it.
      const alreadyApproved = yield* findSpendableApproval(actor.userId, input);
      if (alreadyApproved) {
        return { approval: alreadyApproved, mayRun: true };
      }

      const approval: CollaborationPromptApproval = {
        id: CollaborationApprovalId.make(`approval:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        threadId: input.threadId ?? null,
        requestedByUserId: actor.userId,
        requestedByName: actor.displayName,
        prompt: input.prompt,
        mode: settings.approvalMode,
        status: "pending",
        decidedByUserId: null,
        decidedAt: null,
        note: null,
        consumedAt: null,
        createdAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const approvals = new Map(state.approvals);
        approvals.set(approval.id, approval);
        return { ...state, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-requested", approval });

      // `staged` lets the work happen on the author's own branch and reviews the
      // merge instead; `blocking` holds the prompt until somebody says yes.
      return { approval, mayRun: settings.approvalMode === "staged" };
    });

  const listApprovals: CollaborationServiceShape["listApprovals"] = (actor, input) =>
    Effect.gen(function* () {
      // A held approval carries the prompt verbatim, which makes this the most
      // expensive thing in the service to answer for the wrong workspace.
      yield* ensureWorkspaceReach(actor, input);
      const settings = yield* resolveSettings(input);
      const state = yield* Ref.get(stateRef);
      const limit = Math.min(input.limit ?? DEFAULT_ACTIVITY_LIMIT, MAX_ACTIVITY_LIMIT);
      const approvals = Array.from(state.approvals.values())
        .filter(
          (approval) =>
            approval.tenantId === input.tenantId &&
            approval.workspaceId === input.workspaceId &&
            (input.status === undefined || approval.status === input.status),
        )
        .slice(-limit)
        .toReversed();

      return {
        approvals,
        canDecide: isApprover(settings, actor.userId),
      };
    });

  const decideApproval: CollaborationServiceShape["decideApproval"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can decide prompt approvals.",
        });
      }

      const state = yield* Ref.get(stateRef);
      const existing = state.approvals.get(input.approvalId);
      if (!existing || existing.workspaceId !== input.workspaceId) {
        return yield* new CollaborationError({
          code: "approval-not-found",
          message: "Prompt approval was not found.",
        });
      }
      if (existing.status !== "pending") {
        return yield* new CollaborationError({
          code: "approval-already-decided",
          message: "Prompt approval has already been decided.",
        });
      }

      const decided: CollaborationPromptApproval = {
        ...existing,
        status: input.decision,
        decidedByUserId: actor.userId,
        decidedAt: nowIso(),
        note: input.note ?? null,
      };

      yield* Ref.update(stateRef, (current) => {
        const approvals = new Map(current.approvals);
        approvals.set(decided.id, decided);
        return { ...current, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-decided", approval: decided });

      return { approval: decided };
    });

  const consumeApprovalForTurn: CollaborationServiceShape["consumeApprovalForTurn"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      // Only `blocking` withholds the run itself. `staged` deliberately lets the
      // work happen and reviews it at the merge instead.
      if (settings.approvalMode !== "blocking" || isApprover(settings, actor.userId)) {
        return { mayRun: true };
      }

      const spendable = yield* findSpendableApproval(actor.userId, input);
      if (!spendable) {
        return { mayRun: false };
      }

      const consumed: CollaborationPromptApproval = { ...spendable, consumedAt: nowIso() };
      yield* Ref.update(stateRef, (state) => {
        const approvals = new Map(state.approvals);
        approvals.set(consumed.id, consumed);
        return { ...state, approvals };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "approval-decided", approval: consumed });

      return { mayRun: true };
    });

  /**
   * Assembles the roster from what is already recorded: memberships say who
   * belongs, presence says what they are called and whether they are here, and
   * the accepted invite carries the email.
   */
  const buildMembers = Effect.fn("buildMembers")(function* (input: {
    readonly tenantId: CollaborationMember["tenantId"];
    readonly workspaceId: CollaborationMember["workspaceId"];
    /** Whoever is asking always sees their own details in full. */
    readonly viewerUserId?: UserId;
  }) {
    const state = yield* Ref.get(stateRef);
    const settings = yield* resolveSettings(input);

    const presenceByUser = new Map<string, CollaborationPresence>();
    for (const presence of state.presence.values()) {
      if (presence.tenantId !== input.tenantId || presence.workspaceId !== input.workspaceId) {
        continue;
      }
      const existing = presenceByUser.get(presence.userId);
      if (!existing || existing.lastSeenAt < presence.lastSeenAt) {
        presenceByUser.set(presence.userId, presence);
      }
    }

    const emailByUser = new Map<string, string>();
    const joinedByUser = new Map<string, string>();
    for (const invite of state.invites.values()) {
      if (invite.tenantId !== input.tenantId || invite.acceptedAt === null) {
        continue;
      }
      if (invite.workspaceId !== null && invite.workspaceId !== input.workspaceId) {
        continue;
      }
      // Who accepted, recorded at the time. The fallback matches on the
      // timestamps coinciding, which is how this worked before the invite
      // carried the user and is the only thing older invites can offer.
      const membership = Array.from(state.memberships.values()).find((candidate) =>
        candidate.tenantId !== invite.tenantId
          ? false
          : invite.acceptedByUserId !== null
            ? candidate.userId === invite.acceptedByUserId
            : candidate.createdAt === invite.acceptedAt,
      );
      if (membership) {
        emailByUser.set(membership.userId, invite.email);
        joinedByUser.set(membership.userId, invite.acceptedAt);
      }
    }

    const promptCounts = new Map<string, number>();
    for (const activity of state.activities) {
      if (
        activity.tenantId !== input.tenantId ||
        activity.workspaceId !== input.workspaceId ||
        activity.kind !== "prompted"
      ) {
        continue;
      }
      promptCounts.set(activity.userId, (promptCounts.get(activity.userId) ?? 0) + 1);
    }

    const tokenTotals = new Map<string, number>();
    for (const usage of state.memberUsage.values()) {
      if (usage.tenantId !== input.tenantId || usage.workspaceId !== input.workspaceId) {
        continue;
      }
      tokenTotals.set(usage.userId, (tokenTotals.get(usage.userId) ?? 0) + usage.totalTokens);
    }

    const pendingCounts = new Map<string, number>();
    for (const approval of state.approvals.values()) {
      if (
        approval.tenantId !== input.tenantId ||
        approval.workspaceId !== input.workspaceId ||
        approval.status !== "pending"
      ) {
        continue;
      }
      pendingCounts.set(
        approval.requestedByUserId,
        (pendingCounts.get(approval.requestedByUserId) ?? 0) + 1,
      );
    }

    // Anyone who belongs, plus anyone who has shown up or spent tokens, plus
    // the lead even if they have never reported presence.
    const userIds = new Set<string>();
    for (const membership of state.memberships.values()) {
      if (membership.tenantId === input.tenantId && membership.disabledAt === null) {
        userIds.add(membership.userId);
      }
    }
    for (const userId of presenceByUser.keys()) {
      userIds.add(userId);
    }
    for (const userId of tokenTotals.keys()) {
      userIds.add(userId);
    }
    if (settings.leadUserId) {
      userIds.add(settings.leadUserId);
    }

    return Array.from(userIds).map((userId): CollaborationMember => {
      const typedUserId = userId as CollaborationMember["userId"];
      const presence = presenceByUser.get(userId) ?? null;
      const profile = state.memberProfiles.get(
        scopedKey(input.tenantId, input.workspaceId, userId),
      );
      const membership = Array.from(state.memberships.values()).find(
        (candidate) => candidate.tenantId === input.tenantId && candidate.userId === userId,
      );
      const displayName = profile?.displayName ?? presence?.displayName ?? userId;
      // Silence is not consent where it exposes the person: an email address
      // stays private until offered. Usage is the other way round by product
      // decision — see DEFAULT_SHARE_USAGE — so an undecided member is counted
      // and the settings toggle is how they stop being counted.
      const sharesProfile = profile?.shareProfile ?? DEFAULT_SHARE_PROFILE;
      const sharesUsage = profile?.shareUsage ?? DEFAULT_SHARE_USAGE;
      const isViewer = input.viewerUserId === userId;

      return {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: typedUserId,
        displayName,
        email: sharesProfile || isViewer ? (emailByUser.get(userId) ?? null) : null,
        avatarInitials: presence?.avatarInitials ?? toAvatarInitials(displayName),
        color: profile?.color ?? defaultMemberColor(userId),
        colorIsCustom: Boolean(profile?.color),
        roles: membership?.roles ?? [],
        isLead: settings.leadUserId === userId,
        isApprover: isApprover(settings, typedUserId),
        status: presence?.status ?? "offline",
        lastSeenAt: presence?.lastSeenAt ?? null,
        joinedAt: joinedByUser.get(userId) ?? membership?.createdAt ?? null,
        sharesProfile,
        sharesUsage,
        promptCount: sharesUsage || isViewer ? (promptCounts.get(userId) ?? 0) : null,
        pendingApprovalCount: sharesUsage || isViewer ? (pendingCounts.get(userId) ?? 0) : null,
        tokensUsed: sharesUsage || isViewer ? (tokenTotals.get(userId) ?? 0) : null,
      };
    });
  });

  const checkWriteAccessForTurn: CollaborationServiceShape["checkWriteAccessForTurn"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const membership = Array.from(state.memberships.values()).find(
        (candidate) =>
          candidate.tenantId === input.tenantId &&
          candidate.userId === actor.userId &&
          candidate.disabledAt === null,
      );

      if (membership !== undefined) {
        // A membership minted by an invite into workspace A says nothing about
        // workspace B; see `membershipWorkspaceReach`.
        const reach = membershipWorkspaceReach(state, input.tenantId, actor.userId);
        if (reach !== null && !reach.has(input.workspaceId)) {
          return { mayRun: false };
        }
        // Only a viewer-and-nothing-else role is read-only. An empty role list
        // is refused rather than waved through: a membership that grants
        // nothing grants nothing.
        return { mayRun: membership.roles.some((role) => role !== "viewer") };
      }

      // Nobody with a membership on record.
      //
      // This used to answer `true`, on the reading that an unrecorded
      // membership means "not governed yet". `removeMember` DELETES the
      // membership row, so that reading handed a removed member write access
      // back the instant they were removed: their next turn found no row, took
      // the same branch, and ran. Removal has to mean removal.
      //
      // A workspace with no lead is still genuinely ungoverned — nobody has
      // configured it and it has no owner on record — and that is the
      // single-user desktop case, where refusing would lock the only person on
      // the machine out of their own work. Once a workspace HAS a lead, not
      // being in it means not being in it, and the lead and its approvers are
      // let through because that is who they are.
      //
      // Read here rather than through `resolveSettings` for one reason: that
      // helper answers "no lead" when the workspace list cannot be READ, and
      // "no lead" is the branch that lets a stranger write. A lookup that
      // failed is not permission, so a failed read refuses instead.
      // An organization member has no row here at all.
      //
      // `state.memberships` comes from `loadCollaboration()`, which reads only
      // `tenant_memberships WHERE organization_id IS NULL` — the personal side.
      // Somebody who belongs to a tenant through an ORGANIZATION is recorded in
      // the other half of that table and is legitimately absent from this map.
      // Refusing them here would have taken the ability to start a turn away
      // from every organization-scoped member, which is a far worse outcome
      // than the leak this branch exists to close.
      const organizationRoles = yield* repository.loadOrganizations().pipe(
        Effect.map((snapshot) =>
          snapshot.memberships
            .filter(
              (candidate) =>
                candidate.tenantId === input.tenantId &&
                candidate.userId === actor.userId &&
                candidate.disabledAt === null,
            )
            .flatMap((candidate) => candidate.roles),
        ),
        // A membership table we could not read is not permission. Fall through
        // to the lead check rather than inventing roles.
        Effect.catchCause(() => Effect.succeed<ReadonlyArray<string>>([])),
      );
      if (organizationRoles.length > 0) {
        // Same rule the personal branch applies: viewer-and-nothing-else is
        // read-only, anything more may write.
        return { mayRun: organizationRoles.some((role) => role !== "viewer") };
      }

      const stored = state.settings.get(workspaceKey(input.tenantId, input.workspaceId));
      const settings =
        stored ??
        (yield* repository.loadWorkspaces().pipe(
          Effect.map((snapshot) =>
            defaultSettings({
              tenantId: input.tenantId,
              workspaceId: input.workspaceId,
              leadUserId:
                snapshot.workspaces.find((workspace) => workspace.id === input.workspaceId)
                  ?.ownerUserId ?? null,
              updatedAt: nowIso(),
            }),
          ),
          Effect.catchCause(() => Effect.succeed(null)),
        ));
      if (settings === null) {
        return { mayRun: false };
      }
      return { mayRun: settings.leadUserId === null || isApprover(settings, actor.userId) };
    });

  const listMembers: CollaborationServiceShape["listMembers"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const settings = yield* resolveSettings(input);
      const members = yield* buildMembers({ ...input, viewerUserId: actor.userId });
      return {
        members,
        canManage: isApprover(settings, actor.userId),
        viewerUserId: actor.userId,
      };
    });

  const updateMember: CollaborationServiceShape["updateMember"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can change member settings.",
        });
      }

      if (input.color !== undefined || input.displayName !== undefined) {
        const key = scopedKey(input.tenantId, input.workspaceId, input.userId);
        yield* Ref.update(stateRef, (state) => {
          const memberProfiles = new Map(state.memberProfiles);
          const existing = memberProfiles.get(key);
          memberProfiles.set(key, {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            color: input.color ?? existing?.color ?? null,
            displayName: input.displayName ?? existing?.displayName ?? null,
            shareProfile: existing?.shareProfile ?? null,
            shareUsage: existing?.shareUsage ?? null,
            consentAt: existing?.consentAt ?? null,
            updatedAt: nowIso(),
          });
          return { ...state, memberProfiles };
        });
      }

      if (input.isApprover !== undefined) {
        const approvers = new Set(settings.approverUserIds);
        if (input.isApprover) {
          approvers.add(input.userId);
        } else {
          approvers.delete(input.userId);
        }
        yield* updateSettings(actor, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          approverUserIds: [...approvers],
        });
      }

      if (input.readOnly !== undefined) {
        // The lead is the one person who can undo this, so letting them take
        // their own write access away would strand the workspace.
        if (settings.leadUserId === input.userId) {
          return yield* new CollaborationError({
            code: "invalid-membership-rule",
            message: "The workspace lead cannot be made read-only.",
          });
        }

        const roles = input.readOnly ? READ_ONLY_ROLES : WRITE_ROLES;
        yield* Ref.update(stateRef, (state) => {
          const memberships = new Map(state.memberships);
          for (const [id, membership] of memberships) {
            if (membership.tenantId === input.tenantId && membership.userId === input.userId) {
              memberships.set(id, { ...membership, roles });
            }
          }
          return { ...state, memberships };
        });
      }

      yield* persist;
      const members = yield* buildMembers(input);
      const member = members.find((candidate) => candidate.userId === input.userId);
      if (!member) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Workspace member was not found.",
        });
      }
      yield* PubSub.publish(events, { type: "member-updated", member });
      return { member };
    });

  const removeMember: CollaborationServiceShape["removeMember"] = (actor, input) =>
    Effect.gen(function* () {
      const settings = yield* resolveSettings(input);
      if (!isApprover(settings, actor.userId)) {
        return yield* new CollaborationError({
          code: "not-an-approver",
          message: "Only the workspace lead or an approver can remove members.",
        });
      }
      // The lead is the one account that cannot be locked out of its own
      // workspace, or nobody would be left who could govern it.
      if (settings.leadUserId === input.userId) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "The workspace lead cannot be removed.",
        });
      }

      const removedMembershipIds: string[] = [];
      const removed = yield* Ref.modify(stateRef, (state) => {
        const memberships = new Map(state.memberships);
        let didRemove = false;
        for (const [id, membership] of memberships) {
          if (membership.tenantId === input.tenantId && membership.userId === input.userId) {
            memberships.delete(id);
            removedMembershipIds.push(id);
            didRemove = true;
          }
        }
        if (!didRemove) {
          return [false, state] as const;
        }

        const presence = new Map(state.presence);
        for (const [key, entry] of presence) {
          if (
            entry.tenantId === input.tenantId &&
            entry.workspaceId === input.workspaceId &&
            entry.userId === input.userId
          ) {
            presence.delete(key);
          }
        }
        return [true, { ...state, memberships, presence }] as const;
      });

      if (!removed) {
        return { removed: false };
      }

      // Removal has to be said out loud now. `saveCollaboration` upserts and no
      // longer infers deletion from absence, because inferring it meant clearing
      // every personal membership on the instance and reinstating only the ones
      // this service happened to be holding — which destroyed the rows of every
      // account provisioned since it booted.
      yield* repository.deleteMemberships(removedMembershipIds).pipe(
        Effect.mapError(
          (cause) =>
            new CollaborationError({
              code: "invalid-membership-rule",
              message: "Failed to remove the member.",
              cause,
            }),
        ),
      );
      yield* persist;
      yield* PubSub.publish(events, {
        type: "member-removed",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: input.userId,
      });
      return { removed: true };
    });

  const recordUsage: CollaborationServiceShape["recordUsage"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const key = usageKey(input.tenantId, input.workspaceId, actor.userId, input.threadId);
      const observedAt = nowIso();
      const snapshot: ThreadTokenSnapshot = {
        totalTokens: input.totalTokens,
        inputTokens: input.inputTokens ?? 0,
        cachedInputTokens: input.cachedInputTokens ?? 0,
        outputTokens: input.outputTokens ?? 0,
        reasoningOutputTokens: input.reasoningOutputTokens ?? 0,
      };

      const observation = yield* Ref.modify(stateRef, (state) => {
        const result = deriveUsageObservation(state.memberUsage.get(key), snapshot);
        if (!result.changed) {
          return [result, state] as const;
        }
        const memberUsage = new Map(state.memberUsage);
        memberUsage.set(key, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          threadId: input.threadId,
          totalTokens: result.highWaterTotal,
          updatedAt: observedAt,
          lastTotalTokens: result.baseline.totalTokens,
          lastInputTokens: result.baseline.inputTokens,
          lastCachedInputTokens: result.baseline.cachedInputTokens,
          lastOutputTokens: result.baseline.outputTokens,
          lastReasoningOutputTokens: result.baseline.reasoningOutputTokens,
        });
        return [result, { ...state, memberUsage }] as const;
      });

      const changed = observation.changed;
      if (observation.delta !== null && repository.appendCollaborationUsageSamples) {
        // Appended before the baseline is written, so a failure here loses
        // nothing: the stored baseline has not moved and the next report
        // derives the same delta again.
        yield* repository
          .appendCollaborationUsageSamples([
            {
              sampleId: `usage:${crypto.randomUUID()}`,
              tenantId: input.tenantId,
              workspaceId: input.workspaceId,
              userId: actor.userId,
              threadId: input.threadId,
              turnId: input.turnId ?? null,
              observedAt,
              provider: input.provider ?? null,
              model: input.model ?? null,
              ...observation.delta,
            },
          ])
          .pipe(
            Effect.mapError(
              (cause) =>
                new CollaborationError({
                  code: "invalid-membership-rule",
                  message: "Failed to record a token usage sample.",
                  cause,
                }),
            ),
          );
      }

      if (changed) {
        yield* persist;
      }

      const members = yield* buildMembers({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        viewerUserId: actor.userId,
      });
      const member = members.find((candidate) => candidate.userId === actor.userId);
      if (!member) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Workspace member was not found.",
        });
      }
      if (changed && member.sharesUsage) {
        // Only broadcast a total the workspace is allowed to see; the caller
        // still gets their own back either way.
        yield* PubSub.publish(events, { type: "member-updated", member });
      }

      return { member };
    });

  const queryUsage: CollaborationServiceShape["queryUsage"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      // The window is half-open — `[since, until)` in SQL — so that two
      // adjacent windows cannot both claim a sample on the boundary. That makes
      // the default upper bound a millisecond in the future rather than `now`:
      // asking for usage "up to now" has to include a sample stamped now, and
      // with a bare `Date.now()` the report a turn had just filed was dropped
      // whenever it landed in the same millisecond as the request.
      const untilMs = input.until === undefined ? Date.now() + 1 : Date.parse(input.until);
      const requestedSinceMs =
        input.since === undefined ? untilMs - DEFAULT_USAGE_WINDOW_MS : Date.parse(input.since);
      if (Number.isNaN(untilMs) || Number.isNaN(requestedSinceMs)) {
        return yield* new CollaborationError({
          code: "invalid-membership-rule",
          message: "Usage window bounds must be ISO-8601 timestamps.",
        });
      }
      // Clamped rather than rejected: an over-wide window is a UI mistake, not
      // a caller error, and returning a year of days is friendlier than a
      // failure. An inverted window collapses to empty rather than reversing.
      const sinceMs = Math.max(Math.min(requestedSinceMs, untilMs), untilMs - MAX_USAGE_WINDOW_MS);
      const since = new Date(sinceMs).toISOString();
      const until = new Date(untilMs).toISOString();

      // The same consent gate the People panel uses, applied before anything is
      // summed: a member who opted out contributes to no total, no chart and no
      // cost figure that anyone else can see. Their own row still works,
      // because nobody is hidden from themselves.
      const members = yield* buildMembers({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        viewerUserId: actor.userId,
      });
      const visibleMembers = new Map(
        members
          .filter((member) => member.sharesUsage || member.userId === actor.userId)
          .map((member) => [member.userId as string, member]),
      );

      const readBuckets = repository.readCollaborationUsageBuckets;
      const allBuckets = readBuckets
        ? yield* readBuckets({
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            since,
            until,
          }).pipe(
            Effect.mapError(
              (cause) =>
                new CollaborationError({
                  code: "invalid-membership-rule",
                  message: "Failed to read the workspace usage history.",
                  cause,
                }),
            ),
          )
        : [];

      const buckets = allBuckets.filter((bucket) => visibleMembers.has(bucket.userId));
      const hiddenMemberCount = new Set(
        allBuckets
          .filter((bucket) => !visibleMembers.has(bucket.userId))
          .map((bucket) => bucket.userId),
      ).size;

      const overall = emptyUsage();
      const byUser = new Map<string, UsageAccumulator>();
      const byDay = new Map<string, UsageAccumulator>();
      const byHour = new Map<number, UsageAccumulator>();
      const byProvider = new Map<string, UsageAccumulator>();
      const byModel = new Map<string, UsageAccumulator>();

      const into = <K>(map: Map<K, UsageAccumulator>, key: K): UsageAccumulator => {
        const existing = map.get(key);
        if (existing) {
          return existing;
        }
        const created = emptyUsage();
        map.set(key, created);
        return created;
      };

      for (const bucket of buckets) {
        addBucket(overall, bucket);
        addBucket(into(byUser, bucket.userId), bucket);
        addBucket(into(byDay, bucket.day), bucket);
        addBucket(into(byHour, bucket.hour), bucket);
        addBucket(into(byProvider, bucket.provider ?? ""), bucket);
        addBucket(into(byModel, `${bucket.provider ?? ""} ${bucket.model ?? ""}`), bucket);
      }

      const leaderboard = [...byUser.entries()]
        .flatMap(([userId, accumulator]) => {
          const member = visibleMembers.get(userId);
          return member
            ? [
                {
                  userId: member.userId,
                  displayName: member.displayName,
                  totals: toTotals(accumulator),
                  estimatedCost: toCostEstimate(accumulator),
                  isViewer: member.userId === actor.userId,
                },
              ]
            : [];
        })
        .toSorted((left, right) => right.totals.totalTokens - left.totals.totalTokens);

      const days = enumerateDays(sinceMs, untilMs).map((day) => {
        const accumulator = byDay.get(day) ?? emptyUsage();
        return {
          day,
          totals: toTotals(accumulator),
          estimatedCost: toCostEstimate(accumulator),
        };
      });

      // Always 24, so the histogram has a fixed shape whatever the window.
      const hours = Array.from({ length: 24 }, (_unused, hour) => ({
        hour,
        totals: toTotals(byHour.get(hour) ?? emptyUsage()),
      }));

      const providers = [...byProvider.entries()]
        .map(([provider, accumulator]) => ({
          provider: toProviderKind(provider === "" ? null : provider),
          totals: toTotals(accumulator),
          estimatedCost: toCostEstimate(accumulator),
        }))
        .toSorted((left, right) => right.totals.totalTokens - left.totals.totalTokens);

      const modelRows = [...byModel.entries()]
        .map(([key, accumulator]) => {
          const [provider = "", model = ""] = key.split(" ");
          return {
            provider: toProviderKind(provider === "" ? null : provider),
            model: model === "" ? null : model,
            totals: toTotals(accumulator),
            estimatedCost: toCostEstimate(accumulator),
            isPriced: model !== "" && MODEL_TOKEN_RATES_USD[model] !== undefined,
          };
        })
        .toSorted((left, right) => right.totals.totalTokens - left.totals.totalTokens);

      return {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        since,
        until,
        totals: toTotals(overall),
        estimatedCost: toCostEstimate(overall),
        leaderboard,
        byDay: days,
        byHourOfDay: hours,
        byProvider: providers,
        byModel: modelRows,
        hiddenMemberCount,
        viewerUserId: actor.userId,
      } satisfies CollaborationUsageQueryResult;
    });

  const getConsent: CollaborationServiceShape["getConsent"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => {
        const profile = state.memberProfiles.get(
          scopedKey(input.tenantId, input.workspaceId, actor.userId),
        );
        // `consentAt` is the only record that someone actually decided, and it
        // stays the thing that distinguishes "never asked" from "asked and said
        // yes" — the two now produce the same `shareUsage`, so a settings
        // toggle needs `effective.isDecided` to tell them apart.
        const isDecided = profile !== undefined && profile.consentAt !== null;
        const shareProfile = profile?.shareProfile ?? DEFAULT_SHARE_PROFILE;
        const shareUsage = profile?.shareUsage ?? DEFAULT_SHARE_USAGE;
        const effective = { shareProfile, shareUsage, isDecided };
        if (!isDecided || profile?.consentAt == null) {
          return { consent: null, effective };
        }
        return {
          consent: {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            userId: actor.userId,
            shareProfile,
            shareUsage,
            decidedAt: profile.consentAt,
          },
          effective,
        };
      }),
    );

  const updateConsent: CollaborationServiceShape["updateConsent"] = (actor, input) =>
    Effect.gen(function* () {
      // A consent row is this one person's own decision, but writing one puts
      // them in `buildMembers` for the workspace it names — so an unguarded
      // write stood a stranger up in a roster they were never invited to.
      yield* ensureWorkspaceReach(actor, input);
      const decidedAt = nowIso();
      const key = scopedKey(input.tenantId, input.workspaceId, actor.userId);
      yield* Ref.update(stateRef, (state) => {
        const memberProfiles = new Map(state.memberProfiles);
        const existing = memberProfiles.get(key);
        memberProfiles.set(key, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          color: existing?.color ?? null,
          displayName: existing?.displayName ?? null,
          shareProfile: input.shareProfile,
          shareUsage: input.shareUsage,
          consentAt: decidedAt,
          updatedAt: decidedAt,
        });
        return { ...state, memberProfiles };
      });
      yield* persist;

      const members = yield* buildMembers(input);
      const member = members.find((candidate) => candidate.userId === actor.userId);
      if (member) {
        yield* PubSub.publish(events, { type: "member-updated", member });
      }

      return {
        consent: {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          shareProfile: input.shareProfile,
          shareUsage: input.shareUsage,
          decidedAt,
        },
        effective: {
          shareProfile: input.shareProfile,
          shareUsage: input.shareUsage,
          isDecided: true,
        },
      };
    });

  const getViewPreferences: CollaborationServiceShape["getViewPreferences"] = (actor, input) =>
    Ref.get(stateRef).pipe(
      Effect.map((state) => ({
        preferences: state.viewPreferences.get(
          scopedKey(input.tenantId, input.workspaceId, actor.userId),
        ) ?? {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          userId: actor.userId,
          showOthersPrompts: true,
          showOthersFiles: true,
          updatedAt: nowIso(),
        },
      })),
    );

  const updateViewPreferences: CollaborationServiceShape["updateViewPreferences"] = (
    actor,
    input,
  ) =>
    Effect.gen(function* () {
      const { preferences: current } = yield* getViewPreferences(actor, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
      });
      const next: CollaborationViewPreferences = {
        ...current,
        showOthersPrompts: input.showOthersPrompts ?? current.showOthersPrompts,
        showOthersFiles: input.showOthersFiles ?? current.showOthersFiles,
        updatedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const viewPreferences = new Map(state.viewPreferences);
        viewPreferences.set(scopedKey(next.tenantId, next.workspaceId, next.userId), next);
        return { ...state, viewPreferences };
      });
      yield* persist;

      // Deliberately not broadcast: this is one person's own view filter.
      return { preferences: next };
    });

  const claimBranch: CollaborationServiceShape["claimBranch"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const claim: CollaborationBranchClaim = {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        displayName: actor.displayName,
        branch: input.branch,
        baseBranch: input.baseBranch,
        worktreePath: input.worktreePath,
        createdAt: nowIso(),
      };

      yield* Ref.update(stateRef, (state) => {
        const branchClaims = new Map(state.branchClaims);
        branchClaims.set(scopedKey(claim.tenantId, claim.workspaceId, claim.userId), claim);
        return { ...state, branchClaims };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "branch-claimed", claim });

      return { claim };
    });

  const listBranchClaims: CollaborationServiceShape["listBranchClaims"] = (actor, input) =>
    ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() => Ref.get(stateRef)),
      Effect.map((state) => {
        const claims = Array.from(state.branchClaims.values()).filter(
          (claim) => claim.tenantId === input.tenantId && claim.workspaceId === input.workspaceId,
        );
        return {
          claims,
          mine: claims.find((claim) => claim.userId === actor.userId) ?? null,
          viewerDisplayName: actor.displayName,
        };
      }),
    );

  const releaseBranch: CollaborationServiceShape["releaseBranch"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const key = scopedKey(input.tenantId, input.workspaceId, actor.userId);
      const released = yield* Ref.modify(stateRef, (state) => {
        if (!state.branchClaims.has(key)) {
          return [false, state] as const;
        }
        const branchClaims = new Map(state.branchClaims);
        branchClaims.delete(key);
        return [true, { ...state, branchClaims }] as const;
      });

      if (!released) {
        return { released: false };
      }

      yield* persist;
      yield* PubSub.publish(events, {
        type: "branch-released",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
      });

      return { released: true };
    });

  const touchFiles: CollaborationServiceShape["touchFiles"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const touchedAt = nowIso();
      const touches: ReadonlyArray<CollaborationFileTouch> = input.paths.map((path) => ({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        displayName: actor.displayName,
        path,
        touchedAt,
      }));

      if (touches.length === 0) {
        return { touches };
      }

      yield* Ref.update(stateRef, (state) => {
        const fileTouches = new Map(state.fileTouches);
        for (const touch of touches) {
          // Keyed by person as well as path. Keying by path alone overwrote the
          // previous author, so two people working on one file left exactly the
          // same trace as one person working on it twice — and the fact worth
          // knowing was gone before anything could ask.
          fileTouches.set(
            `${scopedKey(touch.tenantId, touch.workspaceId, touch.path)}:${touch.userId}`,
            touch,
          );
        }
        return { ...state, fileTouches };
      });
      yield* persist;
      yield* PubSub.publish(events, { type: "files-touched", touches });

      return { touches };
    });

  const touchFilesForUser: CollaborationServiceShape["touchFilesForUser"] = (userId, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);

      /**
       * Inference must not overwrite evidence.
       *
       * A browser save says "this person changed this file". A turn's diff says
       * "these files differ from the checkpoint the turn started at", which is
       * only the same sentence when that checkpoint was captured at the turn's
       * start — and it is not, whenever an earlier turn changed nothing and left
       * no checkpoint to measure from. A turn then sweeps up whatever anybody
       * else did in between, and claiming those would put the wrong name and the
       * wrong colour against a colleague's file.
       *
       * So a turn fills in the files nobody has claimed and leaves the rest
       * alone. The cost is real and worth naming: a file somebody saved by hand
       * keeps their name after somebody else's agent rewrites it.
       */
      const claimedByOthers = new Set<string>();
      for (const touch of state.fileTouches.values()) {
        if (
          touch.tenantId === input.tenantId &&
          touch.workspaceId === input.workspaceId &&
          touch.userId !== userId
        ) {
          claimedByOthers.add(touch.path);
        }
      }
      const paths = input.paths.filter((path) => !claimedByOthers.has(path));
      if (paths.length === 0) {
        return { touches: [] };
      }

      const profile = state.memberProfiles.get(
        scopedKey(input.tenantId, input.workspaceId, userId),
      );
      // The same precedence `buildMembers` uses, so an agent's mark and the
      // roster row for the same person never disagree about their name.
      let presence: CollaborationPresence | null = null;
      for (const entry of state.presence.values()) {
        if (
          entry.tenantId !== input.tenantId ||
          entry.workspaceId !== input.workspaceId ||
          entry.userId !== userId
        ) {
          continue;
        }
        if (!presence || presence.lastSeenAt < entry.lastSeenAt) {
          presence = entry;
        }
      }
      const displayName = profile?.displayName ?? presence?.displayName ?? userId;

      return yield* touchFiles(
        {
          userId,
          displayName,
          avatarInitials: presence?.avatarInitials ?? toAvatarInitials(displayName),
        },
        { ...input, paths },
      );
    });

  /**
   * Whoever this id belongs to, named the way the roster names them.
   *
   * Shared by the agent-side touch and the agent-side presence so a turn's mark
   * and a turn's live claim never disagree about the same person's name.
   */
  const resolveMemberDisplayName = (
    state: CollaborationState,
    input: { readonly tenantId: string; readonly workspaceId: string; readonly userId: string },
  ): { readonly displayName: string; readonly avatarInitials: string } => {
    const profile = state.memberProfiles.get(
      scopedKey(input.tenantId, input.workspaceId, input.userId),
    );
    let presence: CollaborationPresence | null = null;
    for (const entry of state.presence.values()) {
      if (
        entry.tenantId !== input.tenantId ||
        entry.workspaceId !== input.workspaceId ||
        entry.userId !== input.userId
      ) {
        continue;
      }
      if (!presence || presence.lastSeenAt < entry.lastSeenAt) {
        presence = entry;
      }
    }
    const displayName = profile?.displayName ?? presence?.displayName ?? input.userId;
    return {
      displayName,
      avatarInitials: presence?.avatarInitials ?? toAvatarInitials(displayName),
    };
  };

  /**
   * Drops everything past its deadline and says what it dropped.
   *
   * Sweeping on every read and every write rather than on a timer is what keeps
   * this table from becoming the append-only log it must not be: there is no
   * moment where a stale claim can be observed, because observing is what
   * clears it. The dropped rows are returned so the same pass that removes them
   * can tell every browser to stop drawing them.
   */
  const pruneFilePresence = (
    presence: ReadonlyMap<string, CollaborationFilePresence>,
    nowMs: number,
  ): {
    readonly kept: Map<string, CollaborationFilePresence>;
    readonly expired: ReadonlyArray<CollaborationFilePresence>;
  } => {
    const kept = new Map<string, CollaborationFilePresence>();
    const expired: CollaborationFilePresence[] = [];
    for (const [key, entry] of presence) {
      if (isFilePresenceLive(toPresenceEntry(entry), nowMs)) {
        kept.set(key, entry);
      } else {
        expired.push(entry);
      }
    }
    return { kept, expired };
  };

  /**
   * The one place a claim is written, for people and for turns alike.
   *
   * `kind` is a parameter of this private function and never of anything a
   * browser can reach: `markFilePresence` always passes `person` and only the
   * reactor's entry point passes `agent`. A tab that could name its own kind
   * could silence the warning that exists for it.
   */
  const writeFilePresence = (input: {
    readonly tenantId: TenantId;
    readonly workspaceId: WorkspaceId;
    readonly userId: UserId;
    readonly displayName: string;
    readonly kind: CollaborationFilePresence["kind"];
    readonly sourceId: string;
    readonly paths: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const refreshedAt = nowIso();
      const nowMs = Date.parse(refreshedAt);

      const { present, released } = yield* Ref.modify(stateRef, (state) => {
        const { kept, expired } = pruneFilePresence(state.filePresence, nowMs);
        const written: CollaborationFilePresence[] = [];
        for (const path of input.paths) {
          const key = filePresenceKey({ ...input, path });
          const entry: CollaborationFilePresence = {
            tenantId: input.tenantId,
            workspaceId: input.workspaceId,
            userId: input.userId,
            displayName: input.displayName,
            path,
            kind: input.kind,
            sourceId: input.sourceId,
            // A heartbeat moves the deadline and nothing else. Keeping the
            // original start is what lets a reader say how long somebody has
            // been in a file rather than how recently they said so.
            startedAt: kept.get(key)?.startedAt ?? refreshedAt,
            refreshedAt,
          };
          kept.set(key, entry);
          written.push(entry);
        }
        return [
          { present: written as ReadonlyArray<CollaborationFilePresence>, released: expired },
          { ...state, filePresence: kept },
        ];
      });

      if (present.length === 0 && released.length === 0) {
        return { presence: present };
      }

      yield* persist;
      yield* PubSub.publish(events, {
        type: "file-presence-changed",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        present,
        released: released.map(toRelease),
      });
      return { presence: present };
    });

  const dropFilePresence = (input: {
    readonly tenantId: TenantId;
    readonly workspaceId: WorkspaceId;
    readonly userId: UserId;
    readonly kind: CollaborationFilePresence["kind"];
    readonly sourceId: string;
    readonly paths: ReadonlyArray<string>;
  }) =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      // An empty path list means "everything this source holds", which is what
      // a page being closed sends: it knows it is going away and not always
      // which files it still had open.
      const wanted = input.paths.length === 0 ? null : new Set(input.paths);

      const released = yield* Ref.modify(stateRef, (state) => {
        const { kept, expired } = pruneFilePresence(state.filePresence, nowMs);
        const removed: CollaborationFilePresence[] = [...expired];
        for (const [key, entry] of kept) {
          if (
            entry.tenantId !== input.tenantId ||
            entry.workspaceId !== input.workspaceId ||
            entry.userId !== input.userId ||
            entry.kind !== input.kind ||
            entry.sourceId !== input.sourceId
          ) {
            continue;
          }
          if (wanted !== null && !wanted.has(entry.path)) {
            continue;
          }
          kept.delete(key);
          removed.push(entry);
        }
        return [
          removed as ReadonlyArray<CollaborationFilePresence>,
          { ...state, filePresence: kept },
        ];
      });

      if (released.length === 0) {
        return { presence: [] as ReadonlyArray<CollaborationFilePresence> };
      }

      yield* persist;
      yield* PubSub.publish(events, {
        type: "file-presence-changed",
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        present: [],
        released: released.map(toRelease),
      });
      return { presence: [] as ReadonlyArray<CollaborationFilePresence> };
    });

  const markFilePresence: CollaborationServiceShape["markFilePresence"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      return yield* writeFilePresence({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        displayName: actor.displayName,
        kind: "person",
        sourceId: sourceOf(input, `session:${actor.userId}`),
        paths: input.paths,
      });
    });

  const markFilePresenceForAgent: CollaborationServiceShape["markFilePresenceForAgent"] = (
    userId,
    input,
  ) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const { displayName } = resolveMemberDisplayName(state, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId,
      });
      return yield* writeFilePresence({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId,
        displayName,
        kind: "agent",
        // A turn is the writer, not the person: two threads run by one person
        // into one file are two writers racing, and one thread heartbeating
        // twice is still one.
        sourceId: sourceOf(input, `user:${userId}`),
        paths: input.paths,
      });
    });

  const releaseFilePresence: CollaborationServiceShape["releaseFilePresence"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      return yield* dropFilePresence({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId: actor.userId,
        kind: "person",
        sourceId: sourceOf(input, `session:${actor.userId}`),
        paths: input.paths,
      });
    });

  const releaseFilePresenceForAgent: CollaborationServiceShape["releaseFilePresenceForAgent"] = (
    userId,
    input,
  ) =>
    dropFilePresence({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      userId,
      kind: "agent",
      sourceId: sourceOf(input, `user:${userId}`),
      paths: input.paths,
    });

  const listFilePresence: CollaborationServiceShape["listFilePresence"] = (actor, input) =>
    Effect.gen(function* () {
      yield* ensureWorkspaceReach(actor, input);
      const nowMs = Date.now();
      const { expired, live } = yield* Ref.modify(stateRef, (state) => {
        const { kept, expired: dropped } = pruneFilePresence(state.filePresence, nowMs);
        const inScope = [...kept.values()].filter(
          (entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId,
        );
        return [
          { expired: dropped, live: inScope as ReadonlyArray<CollaborationFilePresence> },
          { ...state, filePresence: kept },
        ];
      });

      // Reading is what sweeps, so a read that swept has to tell everyone —
      // otherwise the browser that asked is the only one that stops drawing a
      // person who left.
      if (expired.length > 0) {
        yield* persist;
        yield* PubSub.publish(events, {
          type: "file-presence-changed",
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          present: [],
          released: expired.map(toRelease),
        });
      }
      return { presence: live };
    });

  const warnBeforeAgentWrites: CollaborationServiceShape["warnBeforeAgentWrites"] = (
    userId,
    input,
  ) =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      const state = yield* Ref.get(stateRef);
      const held = peopleHoldingFiles({
        entries: [...state.filePresence.values()]
          .filter(
            (entry) => entry.tenantId === input.tenantId && entry.workspaceId === input.workspaceId,
          )
          .map(toPresenceEntry),
        nowMs,
      });
      if (held.length === 0) {
        return { heldPaths: [] as ReadonlyArray<string> };
      }

      const heldPaths = [...new Set(held.map((entry) => entry.path))].toSorted();
      const names = [...new Set(held.map((entry) => entry.displayName))];
      const { displayName } = resolveMemberDisplayName(state, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        userId,
      });
      const shown = heldPaths.slice(0, 3).join(", ");
      const rest = heldPaths.length > 3 ? ` and ${heldPaths.length - 3} more` : "";
      const activity = {
        id: newActivityId(),
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        threadId: null,
        userId,
        kind: "agent-may-overwrite" as const,
        hiddenAt: null,
        summary: `${displayName}'s agent started while ${names.join(" and ")} had ${shown}${rest} open. An agent replaces a file rather than merging into it.`,
        createdAt: nowIso(),
      };

      yield* Ref.update(stateRef, (current) => appendActivity(current, activity));
      yield* persist;
      yield* PubSub.publish(events, { type: "activity-appended", activity });
      return { heldPaths };
    });

  const listFileTouches: CollaborationServiceShape["listFileTouches"] = (actor, input) =>
    ensureWorkspaceReach(actor, input).pipe(
      Effect.flatMap(() => Ref.get(stateRef)),
      Effect.map((state) => ({
        touches: Array.from(state.fileTouches.values()).filter(
          (touch) => touch.tenantId === input.tenantId && touch.workspaceId === input.workspaceId,
        ),
      })),
    );

  return {
    ensureWorkspaceAccess: ensureWorkspaceReach,
    upsertPresence,
    listPresence,
    createInvite,
    listInvites,
    acceptInvite,
    revokeInvite,
    recordSharedPrompt,
    listActivity,
    setActivityVisibility,
    stream,
    getSettings,
    updateSettings,
    submitPromptForApproval,
    consumeApprovalForTurn,
    checkWriteAccessForTurn,
    listApprovals,
    decideApproval,
    getViewPreferences,
    updateViewPreferences,
    claimBranch,
    listBranchClaims,
    releaseBranch,
    touchFiles,
    touchFilesForUser,
    listFileTouches,
    markFilePresence,
    markFilePresenceForAgent,
    releaseFilePresence,
    releaseFilePresenceForAgent,
    listFilePresence,
    warnBeforeAgentWrites,
    listMembers,
    updateMember,
    removeMember,
    recordUsage,
    queryUsage,
    getConsent,
    updateConsent,
    createSharedPrompt,
    listSharedPrompts,
    createNote,
    listNotesForTarget,
    resolveNote,
    listDirectMessages,
  } satisfies CollaborationServiceShape;
});

export const CollaborationServiceLive = Layer.effect(
  CollaborationService,
  makeCollaborationService,
);
