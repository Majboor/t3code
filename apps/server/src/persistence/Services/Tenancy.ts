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
