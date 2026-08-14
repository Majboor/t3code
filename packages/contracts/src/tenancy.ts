import { Schema } from "effect";

import {
  AuthSessionId,
  CollaborationActivityId,
  CollaborationApprovalId,
  InviteId,
  IsoDateTime,
  MembershipId,
  OrganizationAccessGrantId,
  OrganizationAccessReviewId,
  OrganizationAuditEventId,
  OrganizationDepartmentId,
  NonNegativeInt,
  OrganizationId,
  OrganizationTeamId,
  PositiveInt,
  ProjectId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  ThreadId,
  TrimmedNonEmptyString,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";
import { ProviderKind } from "./orchestration.ts";
import { TerminalSessionSnapshot } from "./terminal.ts";

const PortNumber = PositiveInt.check(Schema.isLessThanOrEqualTo(65535));

export const TenantKind = Schema.Literals(["personal", "shared", "corporate", "support"]);
export type TenantKind = typeof TenantKind.Type;

export const WorkspaceKind = Schema.Literals(["personal", "shared", "corporate", "support"]);
export type WorkspaceKind = typeof WorkspaceKind.Type;

export const TenantRole = Schema.Literals([
  "owner",
  "admin",
  "developer",
  "pm",
  "support",
  "viewer",
  "platform-operator",
]);
export type TenantRole = typeof TenantRole.Type;

export const TenantPermission = Schema.Literals([
  "tenant.read",
  "tenant.update",
  "tenant.quarantine",
  "workspace.view",
  "workspace.edit",
  "workspace.invite",
  "project.view",
  "project.create",
  "project.edit",
  "session.view",
  "session.create",
  "session.prompt",
  "file.read",
  "file.write",
  "file.upload",
  "provider.use",
  "provider.connect",
  "provider.manage",
  "runtime.manage",
  "membership.manage",
  "organization.manage",
  "audit.view",
  "support.assist",
  "platform.operate",
]);
export type TenantPermission = typeof TenantPermission.Type;

export const TenantRuntimeStatus = Schema.Literals([
  "stopped",
  "starting",
  "running",
  "stopping",
  "quarantined",
]);
export type TenantRuntimeStatus = typeof TenantRuntimeStatus.Type;

export const TenantRuntimeIsolationStrategy = Schema.Literals([
  "systemd-per-tenant",
  "container-per-tenant",
  "process-per-tenant",
]);
export type TenantRuntimeIsolationStrategy = typeof TenantRuntimeIsolationStrategy.Type;

export const TenantRuntimeIsolation = Schema.Struct({
  runtimeId: TenantRuntimeId,
  tenantId: TenantId,
  strategy: TenantRuntimeIsolationStrategy,
  linuxUser: TrimmedNonEmptyString,
  baseDir: TrimmedNonEmptyString,
  dataDir: TrimmedNonEmptyString,
  secretsDir: TrimmedNonEmptyString,
  attachmentsDir: TrimmedNonEmptyString,
  worktreesDir: TrimmedNonEmptyString,
  runsDir: TrimmedNonEmptyString,
  providerHomesDir: TrimmedNonEmptyString,
  internalHost: TrimmedNonEmptyString,
  internalPort: PortNumber,
  status: TenantRuntimeStatus,
  idleShutdownAfterMs: PositiveInt,
  lastStartedAt: Schema.NullOr(IsoDateTime),
  lastStoppedAt: Schema.NullOr(IsoDateTime),
});
export type TenantRuntimeIsolation = typeof TenantRuntimeIsolation.Type;

export const Tenant = Schema.Struct({
  id: TenantId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  kind: TenantKind,
  organizationId: Schema.NullOr(OrganizationId),
  runtimeId: TenantRuntimeId,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Tenant = typeof Tenant.Type;

export const UserProfile = Schema.Struct({
  id: UserId,
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  avatarUrl: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
});
export type UserProfile = typeof UserProfile.Type;

export const Organization = Schema.Struct({
  id: OrganizationId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Organization = typeof Organization.Type;

export const OrganizationRole = Schema.Literals([
  "owner",
  "admin",
  "manager",
  "developer",
  "pm",
  "support",
  "auditor",
  "viewer",
]);
export type OrganizationRole = typeof OrganizationRole.Type;

export const OrganizationPermission = Schema.Literals([
  "organization.read",
  "organization.update",
  "employee.invite",
  "employee.update",
  "employee.disable",
  "team.manage",
  "department.manage",
  "access.grant",
  "access.revoke",
  "access.review",
  "audit.view",
]);
export type OrganizationPermission = typeof OrganizationPermission.Type;

export const OrganizationTeam = Schema.Struct({
  id: OrganizationTeamId,
  organizationId: OrganizationId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationTeam = typeof OrganizationTeam.Type;

export const OrganizationDepartment = Schema.Struct({
  id: OrganizationDepartmentId,
  organizationId: OrganizationId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationDepartment = typeof OrganizationDepartment.Type;

export const TenantMembership = Schema.Struct({
  id: MembershipId,
  tenantId: TenantId,
  userId: UserId,
  organizationId: Schema.NullOr(OrganizationId),
  roles: Schema.NonEmptyArray(TenantRole),
  organizationRoles: Schema.optional(Schema.NonEmptyArray(OrganizationRole)),
  teamIds: Schema.optional(Schema.Array(OrganizationTeamId)),
  departmentId: Schema.optional(Schema.NullOr(OrganizationDepartmentId)),
  createdAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
});
export type TenantMembership = typeof TenantMembership.Type;

export const OrganizationEmployeeStatus = Schema.Literals(["invited", "active", "disabled"]);
export type OrganizationEmployeeStatus = typeof OrganizationEmployeeStatus.Type;

export const OrganizationEmployee = Schema.Struct({
  membership: TenantMembership,
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  status: OrganizationEmployeeStatus,
});
export type OrganizationEmployee = typeof OrganizationEmployee.Type;

export const OrganizationAccessScope = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("global"),
  }),
  Schema.Struct({
    type: Schema.Literal("organization"),
    organizationId: OrganizationId,
  }),
  Schema.Struct({
    type: Schema.Literal("tenant"),
    tenantId: TenantId,
  }),
  Schema.Struct({
    type: Schema.Literal("workspace"),
    workspaceId: WorkspaceId,
  }),
  Schema.Struct({
    type: Schema.Literal("project"),
    projectId: ProjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("team"),
    teamId: OrganizationTeamId,
  }),
  Schema.Struct({
    type: Schema.Literal("department"),
    departmentId: OrganizationDepartmentId,
  }),
]);
export type OrganizationAccessScope = typeof OrganizationAccessScope.Type;

export const OrganizationAccessGrant = Schema.Struct({
  id: OrganizationAccessGrantId,
  organizationId: OrganizationId,
  membershipId: MembershipId,
  scope: OrganizationAccessScope,
  roles: Schema.NonEmptyArray(TenantRole),
  grantedByUserId: UserId,
  createdAt: IsoDateTime,
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationAccessGrant = typeof OrganizationAccessGrant.Type;

export const OrganizationAuditEventKind = Schema.Literals([
  "organization-created",
  "employee-invited",
  "employee-updated",
  "employee-disabled",
  "team-created",
  "department-created",
  "access-granted",
  "access-revoked",
  "access-review-created",
  "access-review-completed",
  "provider-account-created",
  "provider-account-connect-confirmed",
  "provider-account-connect-failed",
  "provider-account-status-checked",
  "provider-account-disconnected",
  "provider-account-launch-used",
]);
export type OrganizationAuditEventKind = typeof OrganizationAuditEventKind.Type;

export const OrganizationAuditEvent = Schema.Struct({
  id: OrganizationAuditEventId,
  organizationId: OrganizationId,
  actorUserId: UserId,
  kind: OrganizationAuditEventKind,
  summary: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type OrganizationAuditEvent = typeof OrganizationAuditEvent.Type;

export const OrganizationAccessReviewStatus = Schema.Literals(["open", "completed"]);
export type OrganizationAccessReviewStatus = typeof OrganizationAccessReviewStatus.Type;

export const OrganizationAccessReview = Schema.Struct({
  id: OrganizationAccessReviewId,
  organizationId: OrganizationId,
  requestedByUserId: UserId,
  status: OrganizationAccessReviewStatus,
  membershipIds: Schema.Array(MembershipId),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrganizationAccessReview = typeof OrganizationAccessReview.Type;

export const WorkspaceAccessMode = Schema.Literals(["private", "invite-only", "organization"]);
export type WorkspaceAccessMode = typeof WorkspaceAccessMode.Type;

export const Workspace = Schema.Struct({
  id: WorkspaceId,
  tenantId: TenantId,
  organizationId: Schema.NullOr(OrganizationId),
  ownerUserId: UserId,
  kind: WorkspaceKind,
  accessMode: WorkspaceAccessMode,
  title: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Workspace = typeof Workspace.Type;

export const WorkspaceCreateInput = Schema.Struct({
  tenantId: TenantId,
  title: TrimmedNonEmptyString,
  kind: Schema.optionalKey(WorkspaceKind),
  accessMode: Schema.optionalKey(WorkspaceAccessMode),
});
export type WorkspaceCreateInput = typeof WorkspaceCreateInput.Type;

export const WorkspaceCreateResult = Schema.Struct({
  workspace: Workspace,
});
export type WorkspaceCreateResult = typeof WorkspaceCreateResult.Type;

export const TenantInviteScope = Schema.Literals(["tenant", "workspace", "project"]);
export type TenantInviteScope = typeof TenantInviteScope.Type;

export const TenantInvite = Schema.Struct({
  id: InviteId,
  tenantId: TenantId,
  workspaceId: Schema.NullOr(WorkspaceId),
  invitedByUserId: UserId,
  email: TrimmedNonEmptyString,
  scope: TenantInviteScope,
  roles: Schema.NonEmptyArray(TenantRole),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  acceptedAt: Schema.NullOr(IsoDateTime),
  revokedAt: Schema.NullOr(IsoDateTime),
});
export type TenantInvite = typeof TenantInvite.Type;

export const ProviderAccountOwner = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("tenant"),
    tenantId: TenantId,
  }),
  Schema.Struct({
    type: Schema.Literal("organization"),
    organizationId: OrganizationId,
  }),
]);
export type ProviderAccountOwner = typeof ProviderAccountOwner.Type;

export const ProviderAccountSharing = Schema.Literals(["private", "tenant-shared"]);
export type ProviderAccountSharing = typeof ProviderAccountSharing.Type;

export const ProviderAccountConnectScope = Schema.Literals(["personal", "organization"]);
export type ProviderAccountConnectScope = typeof ProviderAccountConnectScope.Type;

export const ProviderAccount = Schema.Struct({
  id: ProviderAccountId,
  provider: ProviderKind,
  tenantId: TenantId,
  owner: ProviderAccountOwner,
  sharing: ProviderAccountSharing,
  authHomeDir: TrimmedNonEmptyString,
  configDir: TrimmedNonEmptyString,
  secretsDir: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
});
export type ProviderAccount = typeof ProviderAccount.Type;

export const ProviderAccountConnectionStatus = Schema.Literals(["connected", "disabled"]);
export type ProviderAccountConnectionStatus = typeof ProviderAccountConnectionStatus.Type;

export const ProviderAccountSummary = Schema.Struct({
  id: ProviderAccountId,
  provider: ProviderKind,
  tenantId: TenantId,
  owner: ProviderAccountOwner,
  sharing: ProviderAccountSharing,
  status: ProviderAccountConnectionStatus,
  createdAt: IsoDateTime,
  disabledAt: Schema.NullOr(IsoDateTime),
  activeSessionCount: NonNegativeInt,
});
export type ProviderAccountSummary = typeof ProviderAccountSummary.Type;

export const ProviderSessionIsolation = Schema.Struct({
  id: ProviderSessionId,
  tenantId: TenantId,
  userId: UserId,
  providerAccountId: ProviderAccountId,
  provider: ProviderKind,
  providerHomeDir: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
});
export type ProviderSessionIsolation = typeof ProviderSessionIsolation.Type;

export class ProviderAccountError extends Schema.TaggedErrorClass<ProviderAccountError>()(
  "ProviderAccountError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "unauthenticated",
      "forbidden",
      "not-found",
      "not-authenticated",
      "rate-limited",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProviderAccountListInput = Schema.Struct({});
export type ProviderAccountListInput = typeof ProviderAccountListInput.Type;

export const ProviderAccountListResult = Schema.Struct({
  accounts: Schema.Array(ProviderAccountSummary),
});
export type ProviderAccountListResult = typeof ProviderAccountListResult.Type;

export const ProviderAccountConnectInput = Schema.Struct({
  provider: ProviderKind,
  accountScope: Schema.optionalKey(ProviderAccountConnectScope),
});
export type ProviderAccountConnectInput = typeof ProviderAccountConnectInput.Type;

export const ProviderAccountConnectInstructions = Schema.Struct({
  provider: ProviderKind,
  authCommand: TrimmedNonEmptyString,
  statusCommand: TrimmedNonEmptyString,
  verificationHint: TrimmedNonEmptyString,
  steps: Schema.NonEmptyArray(TrimmedNonEmptyString),
});
export type ProviderAccountConnectInstructions = typeof ProviderAccountConnectInstructions.Type;

export const ProviderAccountConnectResult = Schema.Struct({
  instructions: ProviderAccountConnectInstructions,
});
export type ProviderAccountConnectResult = typeof ProviderAccountConnectResult.Type;

export const ProviderAccountOpenAuthTerminalInput = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
  terminalId: Schema.optional(TrimmedNonEmptyString),
  accountScope: Schema.optionalKey(ProviderAccountConnectScope),
});
export type ProviderAccountOpenAuthTerminalInput = typeof ProviderAccountOpenAuthTerminalInput.Type;

export const ProviderAccountOpenAuthTerminalResult = Schema.Struct({
  instructions: ProviderAccountConnectInstructions,
  terminal: TerminalSessionSnapshot,
});
export type ProviderAccountOpenAuthTerminalResult =
  typeof ProviderAccountOpenAuthTerminalResult.Type;

export const ProviderAccountConfirmInput = Schema.Struct({
  provider: ProviderKind,
  threadId: ThreadId,
  statusOutput: Schema.String.check(Schema.isMaxLength(10_000)),
  accountScope: Schema.optionalKey(ProviderAccountConnectScope),
});
export type ProviderAccountConfirmInput = typeof ProviderAccountConfirmInput.Type;

export const ProviderAccountConfirmResult = Schema.Struct({
  account: ProviderAccountSummary,
});
export type ProviderAccountConfirmResult = typeof ProviderAccountConfirmResult.Type;

export const ProviderAccountDisconnectInput = Schema.Struct({
  providerAccountId: ProviderAccountId,
});
export type ProviderAccountDisconnectInput = typeof ProviderAccountDisconnectInput.Type;

export const ProviderAccountDisconnectResult = Schema.Struct({
  account: ProviderAccountSummary,
});
export type ProviderAccountDisconnectResult = typeof ProviderAccountDisconnectResult.Type;

export const TenantSessionContext = Schema.Struct({
  authSessionId: AuthSessionId,
  userId: UserId,
  tenantId: TenantId,
  organizationId: Schema.NullOr(OrganizationId),
  membershipIds: Schema.Array(MembershipId),
  roles: Schema.NonEmptyArray(TenantRole),
  activeWorkspaceId: Schema.NullOr(WorkspaceId),
  issuedAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type TenantSessionContext = typeof TenantSessionContext.Type;

export const TenantAccessDecision = Schema.Struct({
  allowed: Schema.Boolean,
  permission: TenantPermission,
  reason: TrimmedNonEmptyString,
});
export type TenantAccessDecision = typeof TenantAccessDecision.Type;

export const AuthTenantSessionMapping = Schema.Struct({
  authSessionId: AuthSessionId,
  userId: UserId,
  tenantId: TenantId,
  organizationId: Schema.NullOr(OrganizationId),
  membershipIds: Schema.Array(MembershipId),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
});
export type AuthTenantSessionMapping = typeof AuthTenantSessionMapping.Type;

export const PublicAccessLimits = Schema.Struct({
  maxWebSocketConnectionsPerIp: PositiveInt,
  maxWebSocketConnectionsPerUser: PositiveInt,
  maxWebSocketConnectionsPerTenant: PositiveInt,
  maxRpcRequestsPerMinutePerUser: PositiveInt,
  maxRpcRequestsPerMinutePerTenant: PositiveInt,
  maxRpcRequestBytes: PositiveInt,
  maxFileUploadBytes: PositiveInt,
  maxFileReadBytes: PositiveInt,
  maxDirectoryEntries: PositiveInt,
  maxDiffBytes: PositiveInt,
  maxActiveTurnsPerUser: PositiveInt,
  maxActiveTurnsPerTenant: PositiveInt,
  maxActiveProviderSessionsPerUser: PositiveInt,
  maxActiveProviderSessionsPerTenant: PositiveInt,
  maxProviderConnectFailuresPerUser: PositiveInt,
  providerConnectFailureWindowMs: PositiveInt,
  providerConnectLockoutMs: PositiveInt,
  maxActiveTenantRuntimesPerMachine: PositiveInt,
  maxRuntimeIdleMs: PositiveInt,
  maxRuntimeWallClockMs: PositiveInt,
});
export type PublicAccessLimits = typeof PublicAccessLimits.Type;

export const TenantUsageCounters = Schema.Struct({
  webSocketConnectionsForIp: NonNegativeInt,
  webSocketConnectionsForUser: NonNegativeInt,
  webSocketConnectionsForTenant: NonNegativeInt,
  rpcRequestsThisMinuteForUser: NonNegativeInt,
  rpcRequestsThisMinuteForTenant: NonNegativeInt,
  activeTurnsForUser: NonNegativeInt,
  activeTurnsForTenant: NonNegativeInt,
  activeProviderSessionsForUser: NonNegativeInt,
  activeProviderSessionsForTenant: NonNegativeInt,
  providerConnectFailuresForUser: NonNegativeInt,
  activeTenantRuntimesForMachine: NonNegativeInt,
});
export type TenantUsageCounters = typeof TenantUsageCounters.Type;

export const TenantLimitCheck = Schema.Struct({
  allowed: Schema.Boolean,
  limit: TrimmedNonEmptyString,
  current: NonNegativeInt,
  maximum: PositiveInt,
});
export type TenantLimitCheck = typeof TenantLimitCheck.Type;

export const CollaborationPresenceStatus = Schema.Literals(["active", "idle", "offline"]);
export type CollaborationPresenceStatus = typeof CollaborationPresenceStatus.Type;

export const CollaborationPresence = Schema.Struct({
  userId: UserId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.NullOr(ThreadId),
  displayName: TrimmedNonEmptyString,
  avatarInitials: Schema.optional(TrimmedNonEmptyString),
  status: CollaborationPresenceStatus,
  lastSeenAt: IsoDateTime,
});
export type CollaborationPresence = typeof CollaborationPresence.Type;

export const CollaborationActivityKind = Schema.Literals([
  "joined",
  "left",
  "prompted",
  "edited",
  "invited",
  "accepted-invite",
  "revoked-invite",
]);
export type CollaborationActivityKind = typeof CollaborationActivityKind.Type;

export const CollaborationActivity = Schema.Struct({
  id: CollaborationActivityId,
  tenantId: TenantId,
  workspaceId: Schema.NullOr(WorkspaceId),
  threadId: Schema.NullOr(ThreadId),
  userId: UserId,
  kind: CollaborationActivityKind,
  summary: TrimmedNonEmptyString,
  /**
   * Set when the author has taken this out of the shared history. They keep
   * seeing it; everyone else stops.
   */
  hiddenAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type CollaborationActivity = typeof CollaborationActivity.Type;

export const CollaborationActivityVisibilityInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  activityId: CollaborationActivityId,
  hidden: Schema.Boolean,
});
export type CollaborationActivityVisibilityInput = typeof CollaborationActivityVisibilityInput.Type;

export const CollaborationActivityVisibilityResult = Schema.Struct({
  activity: CollaborationActivity,
});
export type CollaborationActivityVisibilityResult =
  typeof CollaborationActivityVisibilityResult.Type;

export class CollaborationError extends Schema.TaggedErrorClass<CollaborationError>()(
  "CollaborationError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "invalid-invite",
      "invite-expired",
      "invite-revoked",
      "invite-accepted",
      "invalid-membership-rule",
      "approval-not-found",
      "approval-already-decided",
      "not-an-approver",
      "branch-claim-not-found",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const CollaborationPresenceUpsertInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.NullOr(ThreadId),
  status: CollaborationPresenceStatus,
});
export type CollaborationPresenceUpsertInput = typeof CollaborationPresenceUpsertInput.Type;

export const CollaborationPresenceUpsertResult = Schema.Struct({
  presence: CollaborationPresence,
});
export type CollaborationPresenceUpsertResult = typeof CollaborationPresenceUpsertResult.Type;

export const CollaborationPresenceListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type CollaborationPresenceListInput = typeof CollaborationPresenceListInput.Type;

export const CollaborationPresenceListResult = Schema.Struct({
  users: Schema.Array(CollaborationPresence),
});
export type CollaborationPresenceListResult = typeof CollaborationPresenceListResult.Type;

export const CollaborationInviteCreateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: Schema.NullOr(WorkspaceId),
  email: TrimmedNonEmptyString,
  scope: TenantInviteScope,
  roles: Schema.NonEmptyArray(TenantRole),
  expiresAt: IsoDateTime,
});
export type CollaborationInviteCreateInput = typeof CollaborationInviteCreateInput.Type;

export const CollaborationInviteCreateResult = Schema.Struct({
  invite: TenantInvite,
  acceptUrlPath: TrimmedNonEmptyString,
  accountSetupUrlPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CollaborationInviteCreateResult = typeof CollaborationInviteCreateResult.Type;

export const CollaborationInviteListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: Schema.optional(Schema.NullOr(WorkspaceId)),
});
export type CollaborationInviteListInput = typeof CollaborationInviteListInput.Type;

export const CollaborationInviteListResult = Schema.Struct({
  invites: Schema.Array(TenantInvite),
});
export type CollaborationInviteListResult = typeof CollaborationInviteListResult.Type;

export const CollaborationInviteAcceptInput = Schema.Struct({
  inviteId: InviteId,
});
export type CollaborationInviteAcceptInput = typeof CollaborationInviteAcceptInput.Type;

export const CollaborationInviteAcceptResult = Schema.Struct({
  invite: TenantInvite,
  membership: TenantMembership,
});
export type CollaborationInviteAcceptResult = typeof CollaborationInviteAcceptResult.Type;

export const CollaborationInviteRevokeInput = Schema.Struct({
  tenantId: TenantId,
  inviteId: InviteId,
});
export type CollaborationInviteRevokeInput = typeof CollaborationInviteRevokeInput.Type;

export const CollaborationInviteRevokeResult = Schema.Struct({
  invite: TenantInvite,
});
export type CollaborationInviteRevokeResult = typeof CollaborationInviteRevokeResult.Type;

export const CollaborationSharedPromptRecordInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  prompt: TrimmedNonEmptyString,
});
export type CollaborationSharedPromptRecordInput = typeof CollaborationSharedPromptRecordInput.Type;

export const CollaborationSharedPromptRecordResult = Schema.Struct({
  activity: CollaborationActivity,
});
export type CollaborationSharedPromptRecordResult =
  typeof CollaborationSharedPromptRecordResult.Type;

export const CollaborationActivityListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  limit: Schema.optional(PositiveInt),
});
export type CollaborationActivityListInput = typeof CollaborationActivityListInput.Type;

export const CollaborationActivityListResult = Schema.Struct({
  activities: Schema.Array(CollaborationActivity),
});
export type CollaborationActivityListResult = typeof CollaborationActivityListResult.Type;

// ── Collaboration governance ────────────────────────────────────────────────

/**
 * How a workspace treats a prompt from someone who is not an approver.
 * `open` runs it straight away, `blocking` holds it until an approver says yes,
 * and `staged` lets it run on the author's own branch so the shared branch only
 * moves once the work is merged.
 */
export const CollaborationApprovalMode = Schema.Literals(["open", "blocking", "staged"]);
export type CollaborationApprovalMode = typeof CollaborationApprovalMode.Type;

export const CollaborationWorkspaceSettings = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  /** The person who created the workspace. Always an approver, never removable. */
  leadUserId: Schema.NullOr(UserId),
  approvalMode: CollaborationApprovalMode,
  /** Extra people the lead has handed approval rights to. */
  approverUserIds: Schema.Array(UserId),
  updatedAt: IsoDateTime,
});
export type CollaborationWorkspaceSettings = typeof CollaborationWorkspaceSettings.Type;

export const CollaborationSettingsGetInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationSettingsGetInput = typeof CollaborationSettingsGetInput.Type;

export const CollaborationSettingsUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  approvalMode: Schema.optional(CollaborationApprovalMode),
  approverUserIds: Schema.optional(Schema.Array(UserId)),
});
export type CollaborationSettingsUpdateInput = typeof CollaborationSettingsUpdateInput.Type;

export const CollaborationSettingsResult = Schema.Struct({
  settings: CollaborationWorkspaceSettings,
  /** Whether the caller may change these settings. */
  canManage: Schema.Boolean,
});
export type CollaborationSettingsResult = typeof CollaborationSettingsResult.Type;

export const CollaborationApprovalStatus = Schema.Literals(["pending", "approved", "rejected"]);
export type CollaborationApprovalStatus = typeof CollaborationApprovalStatus.Type;

export const CollaborationPromptApproval = Schema.Struct({
  id: CollaborationApprovalId,
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.NullOr(ThreadId),
  requestedByUserId: UserId,
  requestedByName: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  /** The mode in force when the prompt was submitted. */
  mode: CollaborationApprovalMode,
  status: CollaborationApprovalStatus,
  decidedByUserId: Schema.NullOr(UserId),
  decidedAt: Schema.NullOr(IsoDateTime),
  note: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * When the approved prompt was actually spent on a turn. An approval is good
   * for one run, so this is what stops a single yes being replayed.
   */
  consumedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
});
export type CollaborationPromptApproval = typeof CollaborationPromptApproval.Type;

export const CollaborationApprovalSubmitInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
  prompt: TrimmedNonEmptyString,
});
export type CollaborationApprovalSubmitInput = typeof CollaborationApprovalSubmitInput.Type;

export const CollaborationApprovalSubmitResult = Schema.Struct({
  /** Absent when the workspace let the prompt through without a review. */
  approval: Schema.NullOr(CollaborationPromptApproval),
  /** True when the caller may send the prompt to the agent right now. */
  mayRun: Schema.Boolean,
});
export type CollaborationApprovalSubmitResult = typeof CollaborationApprovalSubmitResult.Type;

export const CollaborationApprovalListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  status: Schema.optional(CollaborationApprovalStatus),
  limit: Schema.optional(PositiveInt),
});
export type CollaborationApprovalListInput = typeof CollaborationApprovalListInput.Type;

export const CollaborationApprovalListResult = Schema.Struct({
  approvals: Schema.Array(CollaborationPromptApproval),
  canDecide: Schema.Boolean,
});
export type CollaborationApprovalListResult = typeof CollaborationApprovalListResult.Type;

export const CollaborationApprovalDecideInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  approvalId: CollaborationApprovalId,
  decision: Schema.Literals(["approved", "rejected"]),
  note: Schema.optional(TrimmedNonEmptyString),
});
export type CollaborationApprovalDecideInput = typeof CollaborationApprovalDecideInput.Type;

export const CollaborationApprovalDecideResult = Schema.Struct({
  approval: CollaborationPromptApproval,
});
export type CollaborationApprovalDecideResult = typeof CollaborationApprovalDecideResult.Type;

/**
 * A personal filter, not a workspace mode: turning collaboration off hides
 * other people's prompts and files from your own view and nobody else's.
 */
export const CollaborationViewPreferences = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  showOthersPrompts: Schema.Boolean,
  showOthersFiles: Schema.Boolean,
  updatedAt: IsoDateTime,
});
export type CollaborationViewPreferences = typeof CollaborationViewPreferences.Type;

export const CollaborationViewGetInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationViewGetInput = typeof CollaborationViewGetInput.Type;

export const CollaborationViewUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  showOthersPrompts: Schema.optional(Schema.Boolean),
  showOthersFiles: Schema.optional(Schema.Boolean),
});
export type CollaborationViewUpdateInput = typeof CollaborationViewUpdateInput.Type;

export const CollaborationViewResult = Schema.Struct({
  preferences: CollaborationViewPreferences,
});
export type CollaborationViewResult = typeof CollaborationViewResult.Type;

/** One person's own branch and worktree inside a shared workspace. */
export const CollaborationBranchClaim = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type CollaborationBranchClaim = typeof CollaborationBranchClaim.Type;

export const CollaborationBranchClaimInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  branch: TrimmedNonEmptyString,
  baseBranch: TrimmedNonEmptyString,
  worktreePath: TrimmedNonEmptyString,
});
export type CollaborationBranchClaimInput = typeof CollaborationBranchClaimInput.Type;

export const CollaborationBranchClaimResult = Schema.Struct({
  claim: CollaborationBranchClaim,
});
export type CollaborationBranchClaimResult = typeof CollaborationBranchClaimResult.Type;

export const CollaborationBranchListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationBranchListInput = typeof CollaborationBranchListInput.Type;

export const CollaborationBranchListResult = Schema.Struct({
  claims: Schema.Array(CollaborationBranchClaim),
  /**
   * The caller's own claim, so a browser can tell whether it needs to offer a
   * branch without knowing which user it is signed in as.
   */
  mine: Schema.NullOr(CollaborationBranchClaim),
  /** The caller's own display name, so a new branch can be named after them. */
  viewerDisplayName: TrimmedNonEmptyString,
});
export type CollaborationBranchListResult = typeof CollaborationBranchListResult.Type;

export const CollaborationBranchReleaseInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationBranchReleaseInput = typeof CollaborationBranchReleaseInput.Type;

export const CollaborationBranchReleaseResult = Schema.Struct({
  released: Schema.Boolean,
});
export type CollaborationBranchReleaseResult = typeof CollaborationBranchReleaseResult.Type;

/** Who last touched a file, so the tree can colour it by author. */
export const CollaborationFileTouch = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  touchedAt: IsoDateTime,
});
export type CollaborationFileTouch = typeof CollaborationFileTouch.Type;

export const CollaborationFileTouchInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  paths: Schema.Array(TrimmedNonEmptyString),
});
export type CollaborationFileTouchInput = typeof CollaborationFileTouchInput.Type;

export const CollaborationFileTouchResult = Schema.Struct({
  touches: Schema.Array(CollaborationFileTouch),
});
export type CollaborationFileTouchResult = typeof CollaborationFileTouchResult.Type;

export const CollaborationFileTouchListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationFileTouchListInput = typeof CollaborationFileTouchListInput.Type;

/**
 * A person in a shared workspace, assembled from their membership, the last
 * presence they reported and the invite that let them in. Carries everything
 * the UI needs to draw them: a name, initials and a colour.
 */
export const CollaborationMember = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  displayName: TrimmedNonEmptyString,
  email: Schema.NullOr(TrimmedNonEmptyString),
  avatarInitials: TrimmedNonEmptyString,
  /** A CSS colour, auto-assigned from the id unless an approver overrode it. */
  color: TrimmedNonEmptyString,
  colorIsCustom: Schema.Boolean,
  roles: Schema.Array(TenantRole),
  isLead: Schema.Boolean,
  isApprover: Schema.Boolean,
  status: CollaborationPresenceStatus,
  lastSeenAt: Schema.NullOr(IsoDateTime),
  joinedAt: Schema.NullOr(IsoDateTime),
  /**
   * What this person agreed to share when they joined. Until they accept,
   * their email and usage are withheld from everyone else in the workspace.
   */
  sharesProfile: Schema.Boolean,
  sharesUsage: Schema.Boolean,
  /** Null when this person has not agreed to share their usage. */
  promptCount: Schema.NullOr(NonNegativeInt),
  pendingApprovalCount: Schema.NullOr(NonNegativeInt),
  tokensUsed: Schema.NullOr(NonNegativeInt),
});
export type CollaborationMember = typeof CollaborationMember.Type;

export const CollaborationMemberListInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationMemberListInput = typeof CollaborationMemberListInput.Type;

export const CollaborationMemberListResult = Schema.Struct({
  members: Schema.Array(CollaborationMember),
  canManage: Schema.Boolean,
  viewerUserId: UserId,
});
export type CollaborationMemberListResult = typeof CollaborationMemberListResult.Type;

export const CollaborationMemberUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  color: Schema.optional(TrimmedNonEmptyString),
  displayName: Schema.optional(TrimmedNonEmptyString),
  isApprover: Schema.optional(Schema.Boolean),
  /**
   * Watch but do not prompt. A boolean rather than the role array it maps onto,
   * because handing the collaboration panel arbitrary tenant roles would let an
   * approver promote someone to `owner` from a member list.
   */
  readOnly: Schema.optional(Schema.Boolean),
});
export type CollaborationMemberUpdateInput = typeof CollaborationMemberUpdateInput.Type;

export const CollaborationMemberRemoveInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
});
export type CollaborationMemberRemoveInput = typeof CollaborationMemberRemoveInput.Type;

export const CollaborationMemberResult = Schema.Struct({
  member: CollaborationMember,
});
export type CollaborationMemberResult = typeof CollaborationMemberResult.Type;

export const CollaborationMemberRemoveResult = Schema.Struct({
  removed: Schema.Boolean,
});
export type CollaborationMemberRemoveResult = typeof CollaborationMemberRemoveResult.Type;

export const CollaborationUsageRecordInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: ThreadId,
  /**
   * The thread's running total, not the change since last time. Providers
   * report a cumulative figure many times per turn, so a member's total is the
   * sum of the highest figure each of their threads has reached.
   */
  totalTokens: NonNegativeInt,
});
export type CollaborationUsageRecordInput = typeof CollaborationUsageRecordInput.Type;

/**
 * What a workspace is allowed to see about someone, agreed to when they join.
 * Joining a shared workspace hands over more than access, so it is asked for
 * once, up front, rather than assumed.
 */
export const CollaborationConsent = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  userId: UserId,
  /** Name and email visible to the rest of the workspace. */
  shareProfile: Schema.Boolean,
  /** Prompt and approval counts visible to the rest of the workspace. */
  shareUsage: Schema.Boolean,
  decidedAt: IsoDateTime,
});
export type CollaborationConsent = typeof CollaborationConsent.Type;

export const CollaborationConsentGetInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
});
export type CollaborationConsentGetInput = typeof CollaborationConsentGetInput.Type;

export const CollaborationConsentUpdateInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  shareProfile: Schema.Boolean,
  shareUsage: Schema.Boolean,
});
export type CollaborationConsentUpdateInput = typeof CollaborationConsentUpdateInput.Type;

export const CollaborationConsentResult = Schema.Struct({
  /** Null until this person has been asked. */
  consent: Schema.NullOr(CollaborationConsent),
});
export type CollaborationConsentResult = typeof CollaborationConsentResult.Type;

export const CollaborationStreamInput = Schema.Struct({
  tenantId: TenantId,
  workspaceId: WorkspaceId,
  threadId: Schema.optional(Schema.NullOr(ThreadId)),
});
export type CollaborationStreamInput = typeof CollaborationStreamInput.Type;

export const CollaborationStreamEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("presence-upserted"),
    presence: CollaborationPresence,
  }),
  Schema.Struct({
    type: Schema.Literal("invite-created"),
    invite: TenantInvite,
  }),
  Schema.Struct({
    type: Schema.Literal("invite-accepted"),
    invite: TenantInvite,
    membership: TenantMembership,
  }),
  Schema.Struct({
    type: Schema.Literal("invite-revoked"),
    invite: TenantInvite,
  }),
  Schema.Struct({
    type: Schema.Literal("activity-appended"),
    activity: CollaborationActivity,
  }),
  Schema.Struct({
    type: Schema.Literal("settings-updated"),
    settings: CollaborationWorkspaceSettings,
  }),
  Schema.Struct({
    type: Schema.Literal("approval-requested"),
    approval: CollaborationPromptApproval,
  }),
  Schema.Struct({
    type: Schema.Literal("approval-decided"),
    approval: CollaborationPromptApproval,
  }),
  Schema.Struct({
    type: Schema.Literal("branch-claimed"),
    claim: CollaborationBranchClaim,
  }),
  Schema.Struct({
    type: Schema.Literal("branch-released"),
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("files-touched"),
    touches: Schema.Array(CollaborationFileTouch),
  }),
  Schema.Struct({
    type: Schema.Literal("activity-visibility-changed"),
    activity: CollaborationActivity,
  }),
  Schema.Struct({
    type: Schema.Literal("member-updated"),
    member: CollaborationMember,
  }),
  Schema.Struct({
    type: Schema.Literal("member-removed"),
    tenantId: TenantId,
    workspaceId: WorkspaceId,
    userId: UserId,
  }),
]);
export type CollaborationStreamEvent = typeof CollaborationStreamEvent.Type;

export class OrganizationError extends Schema.TaggedErrorClass<OrganizationError>()(
  "OrganizationError",
  {
    message: TrimmedNonEmptyString,
    code: Schema.Literals([
      "organization-not-found",
      "membership-not-found",
      "team-not-found",
      "department-not-found",
      "invalid-invite",
      "invite-expired",
      "invite-revoked",
      "invite-accepted",
      "invalid-role",
      "invalid-scope",
      "employee-disabled",
      "access-grant-not-found",
      "access-grant-already-revoked",
      "access-review-not-found",
      "access-review-already-completed",
    ]),
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const OrganizationCreateInput = Schema.Struct({
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type OrganizationCreateInput = typeof OrganizationCreateInput.Type;

export const OrganizationCreateResult = Schema.Struct({
  organization: Organization,
  tenant: Tenant,
  ownerMembership: TenantMembership,
});
export type OrganizationCreateResult = typeof OrganizationCreateResult.Type;

export const OrganizationListResult = Schema.Struct({
  organizations: Schema.Array(Organization),
  tenants: Schema.Array(Tenant),
  workspaces: Schema.optionalKey(Schema.Array(Workspace)),
  employees: Schema.Array(OrganizationEmployee),
  invites: Schema.Array(TenantInvite),
  memberships: Schema.Array(TenantMembership),
  teams: Schema.Array(OrganizationTeam),
  departments: Schema.Array(OrganizationDepartment),
  grants: Schema.Array(OrganizationAccessGrant),
  reviews: Schema.Array(OrganizationAccessReview),
});
export type OrganizationListResult = typeof OrganizationListResult.Type;

export const OrganizationEmployeeInviteInput = Schema.Struct({
  organizationId: OrganizationId,
  tenantId: TenantId,
  email: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  roles: Schema.NonEmptyArray(TenantRole),
  organizationRoles: Schema.NonEmptyArray(OrganizationRole),
  teamIds: Schema.optional(Schema.Array(OrganizationTeamId)),
  departmentId: Schema.optional(Schema.NullOr(OrganizationDepartmentId)),
  expiresAt: IsoDateTime,
});
export type OrganizationEmployeeInviteInput = typeof OrganizationEmployeeInviteInput.Type;

export const OrganizationEmployeeInviteResult = Schema.Struct({
  invite: TenantInvite,
  employee: OrganizationEmployee,
  accountSetupUrlPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type OrganizationEmployeeInviteResult = typeof OrganizationEmployeeInviteResult.Type;

export const OrganizationEmployeeInviteAcceptInput = Schema.Struct({
  inviteId: InviteId,
});
export type OrganizationEmployeeInviteAcceptInput =
  typeof OrganizationEmployeeInviteAcceptInput.Type;

export const OrganizationEmployeeInviteAcceptResult = Schema.Struct({
  invite: TenantInvite,
  employee: OrganizationEmployee,
  membership: TenantMembership,
});
export type OrganizationEmployeeInviteAcceptResult =
  typeof OrganizationEmployeeInviteAcceptResult.Type;

export const OrganizationEmployeeListInput = Schema.Struct({
  organizationId: OrganizationId,
});
export type OrganizationEmployeeListInput = typeof OrganizationEmployeeListInput.Type;

export const OrganizationEmployeeListResult = Schema.Struct({
  employees: Schema.Array(OrganizationEmployee),
});
export type OrganizationEmployeeListResult = typeof OrganizationEmployeeListResult.Type;

export const OrganizationEmployeeUpdateInput = Schema.Struct({
  organizationId: OrganizationId,
  membershipId: MembershipId,
  roles: Schema.optional(Schema.NonEmptyArray(TenantRole)),
  organizationRoles: Schema.optional(Schema.NonEmptyArray(OrganizationRole)),
  teamIds: Schema.optional(Schema.Array(OrganizationTeamId)),
  departmentId: Schema.optional(Schema.NullOr(OrganizationDepartmentId)),
});
export type OrganizationEmployeeUpdateInput = typeof OrganizationEmployeeUpdateInput.Type;

export const OrganizationEmployeeUpdateResult = Schema.Struct({
  employee: OrganizationEmployee,
});
export type OrganizationEmployeeUpdateResult = typeof OrganizationEmployeeUpdateResult.Type;

export const OrganizationEmployeeDisableInput = Schema.Struct({
  organizationId: OrganizationId,
  membershipId: MembershipId,
});
export type OrganizationEmployeeDisableInput = typeof OrganizationEmployeeDisableInput.Type;

export const OrganizationTeamCreateInput = Schema.Struct({
  organizationId: OrganizationId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type OrganizationTeamCreateInput = typeof OrganizationTeamCreateInput.Type;

export const OrganizationTeamCreateResult = Schema.Struct({
  team: OrganizationTeam,
});
export type OrganizationTeamCreateResult = typeof OrganizationTeamCreateResult.Type;

export const OrganizationDepartmentCreateInput = Schema.Struct({
  organizationId: OrganizationId,
  slug: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
});
export type OrganizationDepartmentCreateInput = typeof OrganizationDepartmentCreateInput.Type;

export const OrganizationDepartmentCreateResult = Schema.Struct({
  department: OrganizationDepartment,
});
export type OrganizationDepartmentCreateResult = typeof OrganizationDepartmentCreateResult.Type;

export const OrganizationAccessGrantInput = Schema.Struct({
  organizationId: OrganizationId,
  membershipId: MembershipId,
  scope: OrganizationAccessScope,
  roles: Schema.NonEmptyArray(TenantRole),
});
export type OrganizationAccessGrantInput = typeof OrganizationAccessGrantInput.Type;

export const OrganizationAccessGrantResult = Schema.Struct({
  grant: OrganizationAccessGrant,
});
export type OrganizationAccessGrantResult = typeof OrganizationAccessGrantResult.Type;

export const OrganizationAccessRevokeInput = Schema.Struct({
  organizationId: OrganizationId,
  grantId: OrganizationAccessGrantId,
});
export type OrganizationAccessRevokeInput = typeof OrganizationAccessRevokeInput.Type;

export const OrganizationAccessRevokeResult = Schema.Struct({
  grant: OrganizationAccessGrant,
});
export type OrganizationAccessRevokeResult = typeof OrganizationAccessRevokeResult.Type;

export const OrganizationAccessReviewCreateInput = Schema.Struct({
  organizationId: OrganizationId,
  membershipIds: Schema.Array(MembershipId),
});
export type OrganizationAccessReviewCreateInput = typeof OrganizationAccessReviewCreateInput.Type;

export const OrganizationAccessReviewCreateResult = Schema.Struct({
  review: OrganizationAccessReview,
});
export type OrganizationAccessReviewCreateResult = typeof OrganizationAccessReviewCreateResult.Type;

export const OrganizationAccessReviewCompleteInput = Schema.Struct({
  organizationId: OrganizationId,
  reviewId: OrganizationAccessReviewId,
});
export type OrganizationAccessReviewCompleteInput =
  typeof OrganizationAccessReviewCompleteInput.Type;

export const OrganizationAccessReviewCompleteResult = Schema.Struct({
  review: OrganizationAccessReview,
});
export type OrganizationAccessReviewCompleteResult =
  typeof OrganizationAccessReviewCompleteResult.Type;

export const OrganizationAuditListInput = Schema.Struct({
  organizationId: OrganizationId,
  limit: Schema.optional(PositiveInt),
});
export type OrganizationAuditListInput = typeof OrganizationAuditListInput.Type;

export const OrganizationAuditListResult = Schema.Struct({
  events: Schema.Array(OrganizationAuditEvent),
});
export type OrganizationAuditListResult = typeof OrganizationAuditListResult.Type;
