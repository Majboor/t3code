import type {
  CollaborationActivity,
  CollaborationBranchClaim,
  CollaborationFileTouch,
  CollaborationPresence,
  CollaborationPromptApproval,
  CollaborationViewPreferences,
  CollaborationWorkspaceSettings,
  Organization,
  OrganizationAccessGrant,
  OrganizationAccessReview,
  OrganizationAuditEvent,
  OrganizationDepartment,
  OrganizationEmployee,
  OrganizationTeam,
  ProviderAccount,
  ProviderSessionIsolation,
  Tenant,
  TenantInvite,
  TenantMembership,
  TenantRuntimeId,
  TenantRuntimeIsolation,
  Workspace,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

import type { TenancyRepositoryError } from "../Errors.ts";

export interface OrganizationPersistenceSnapshot {
  readonly organizations: ReadonlyArray<Organization>;
  readonly tenants: ReadonlyArray<Tenant>;
  readonly employees: ReadonlyArray<OrganizationEmployee>;
  readonly invites: ReadonlyArray<TenantInvite>;
  readonly memberships: ReadonlyArray<TenantMembership>;
  readonly teams: ReadonlyArray<OrganizationTeam>;
  readonly departments: ReadonlyArray<OrganizationDepartment>;
  readonly grants: ReadonlyArray<OrganizationAccessGrant>;
  readonly reviews: ReadonlyArray<OrganizationAccessReview>;
  readonly auditEvents: ReadonlyArray<OrganizationAuditEvent>;
}

/** A lead's override of how one member is drawn in one workspace. */
export interface CollaborationMemberProfileRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly color: string | null;
  readonly displayName: string | null;
  /** Null when this person has not been asked to consent yet. */
  readonly shareProfile: boolean | null;
  readonly shareUsage: boolean | null;
  readonly consentAt: string | null;
  readonly updatedAt: string;
}

/**
 * The highest token total one member's thread has reached, plus the figures it
 * last actually reported.
 *
 * `totalTokens` only climbs and is what a member's usage is summed from. The
 * `last*` fields are the delta baseline for the sample series and follow the
 * provider down when it compacts. Null on rows written before migration 050.
 */
export interface CollaborationMemberUsageRecord {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly totalTokens: number;
  readonly updatedAt: string;
  readonly lastTotalTokens?: number | null;
  readonly lastInputTokens?: number | null;
  readonly lastCachedInputTokens?: number | null;
  readonly lastOutputTokens?: number | null;
  readonly lastReasoningOutputTokens?: number | null;
}

/**
 * One observation in the append-only usage series (migration 050).
 *
 * Every token field is the CHANGE since the previous observation for the same
 * (member, thread), never a running total — summing a set of these rows is
 * therefore meaningful, which is the whole point of keeping them.
 */
export interface CollaborationUsageSampleRecord {
  readonly sampleId: string;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly observedAt: string;
  /** Raw provider id (`codex` / `claudeAgent`), or null when unresolved. */
  readonly provider: string | null;
  /** Raw model id, or null when unresolved. Priced by the server's rate table. */
  readonly model: string | null;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
}

/** A half-open window over the sample series: `since` inclusive, `until` exclusive. */
export interface CollaborationUsageWindowQuery {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly since: string;
  readonly until: string;
}

/**
 * Samples rolled up in SQL to the finest grain any of the panel's views need.
 *
 * One query rather than four: a leaderboard, a daily trend, an hour-of-day
 * histogram and a provider split are all sums over subsets of this grouping, so
 * fetching it once and re-aggregating in memory keeps consent filtering and
 * cost arithmetic out of SQL — where per-member visibility rules do not belong.
 * Cardinality is bounded by members x models x days x 24.
 */
export interface CollaborationUsageBucketRecord {
  readonly userId: string;
  readonly provider: string | null;
  readonly model: string | null;
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
  /** UTC hour of day, 0-23. */
  readonly hour: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly totalTokens: number;
  readonly sampleCount: number;
}

export interface CollaborationPersistenceSnapshot {
  readonly presence: ReadonlyArray<CollaborationPresence>;
  readonly invites: ReadonlyArray<TenantInvite>;
  readonly memberships: ReadonlyArray<TenantMembership>;
  readonly activities: ReadonlyArray<CollaborationActivity>;
  // Governance arrived after the first snapshots were written, so readers have
  // to cope with these being absent on disk.
  readonly settings?: ReadonlyArray<CollaborationWorkspaceSettings>;
  readonly approvals?: ReadonlyArray<CollaborationPromptApproval>;
  readonly viewPreferences?: ReadonlyArray<CollaborationViewPreferences>;
  readonly branchClaims?: ReadonlyArray<CollaborationBranchClaim>;
  readonly fileTouches?: ReadonlyArray<CollaborationFileTouch>;
  readonly memberProfiles?: ReadonlyArray<CollaborationMemberProfileRecord>;
  readonly memberUsage?: ReadonlyArray<CollaborationMemberUsageRecord>;
}

export interface WorkspacePersistenceSnapshot {
  readonly workspaces: ReadonlyArray<Workspace>;
}

export interface ProviderIsolationPersistenceSnapshot {
  readonly providerAccounts: ReadonlyArray<ProviderAccount>;
  readonly providerSessions: ReadonlyArray<ProviderSessionIsolation>;
}

export interface TenantRuntimeSystemdUnitPersistenceRecord {
  readonly tenantId: Tenant["id"];
  readonly runtimeId: TenantRuntimeId;
  readonly unitName: string;
  readonly unitFile: string;
  readonly generatedAt: string;
  readonly lastWrittenAt: string | null;
}

export interface TenantRuntimeLifecycleCompletedStepPersistenceRecord {
  readonly idempotencyKey: string;
  readonly tenantId: Tenant["id"];
  readonly runtimeId: TenantRuntimeId;
  readonly operation: string;
  readonly sourceAction: string;
  readonly targetStatus: TenantRuntimeIsolation["status"];
  readonly processAction: boolean;
  readonly reason: string;
  readonly completedAt: string;
}

export interface TenantRuntimeLifecyclePersistenceSnapshot {
  readonly runtimes: ReadonlyArray<TenantRuntimeIsolation>;
  readonly systemdUnits: ReadonlyArray<TenantRuntimeSystemdUnitPersistenceRecord>;
  readonly completedSteps: ReadonlyArray<TenantRuntimeLifecycleCompletedStepPersistenceRecord>;
}

export interface TenancyRepositoryShape {
  readonly loadOrganizations: () => Effect.Effect<
    OrganizationPersistenceSnapshot,
    TenancyRepositoryError
  >;
  readonly saveOrganizations: (
    snapshot: OrganizationPersistenceSnapshot,
  ) => Effect.Effect<void, TenancyRepositoryError>;
  readonly loadCollaboration: () => Effect.Effect<
    CollaborationPersistenceSnapshot,
    TenancyRepositoryError
  >;
  readonly saveCollaboration: (
    snapshot: CollaborationPersistenceSnapshot,
  ) => Effect.Effect<void, TenancyRepositoryError>;
  /**
   * Appends to the usage series. Deliberately not part of the collaboration
   * snapshot: that is saved by rewriting whole tables, which an append-only
   * history cannot survive and would not fit in memory for long.
   *
   * Optional, like the governance arrays above and for the same reason: several
   * repositories are hand-written stand-ins that predate the series and have no
   * table to write to. A repository without these keeps working; it simply has
   * no history to offer, which reads as an empty window rather than an error.
   */
  readonly appendCollaborationUsageSamples?: (
    samples: ReadonlyArray<CollaborationUsageSampleRecord>,
  ) => Effect.Effect<void, TenancyRepositoryError>;
  readonly readCollaborationUsageBuckets?: (
    query: CollaborationUsageWindowQuery,
  ) => Effect.Effect<ReadonlyArray<CollaborationUsageBucketRecord>, TenancyRepositoryError>;
  readonly loadWorkspaces: () => Effect.Effect<
    WorkspacePersistenceSnapshot,
    TenancyRepositoryError
  >;
  readonly saveWorkspaces: (
    snapshot: WorkspacePersistenceSnapshot,
  ) => Effect.Effect<void, TenancyRepositoryError>;
  readonly loadProviderIsolation: () => Effect.Effect<
    ProviderIsolationPersistenceSnapshot,
    TenancyRepositoryError
  >;
  readonly saveProviderIsolation: (
    snapshot: ProviderIsolationPersistenceSnapshot,
  ) => Effect.Effect<void, TenancyRepositoryError>;
  readonly loadTenantRuntimeLifecycleState: () => Effect.Effect<
    TenantRuntimeLifecyclePersistenceSnapshot,
    TenancyRepositoryError
  >;
  readonly saveTenantRuntimeLifecycleState: (
    snapshot: TenantRuntimeLifecyclePersistenceSnapshot,
  ) => Effect.Effect<void, TenancyRepositoryError>;
}

export class TenancyRepository extends Context.Service<TenancyRepository, TenancyRepositoryShape>()(
  "t3/persistence/Services/Tenancy/TenancyRepository",
) {}
