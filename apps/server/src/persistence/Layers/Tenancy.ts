import {
  InviteId,
  MembershipId,
  OrganizationAccessGrantId,
  OrganizationAccessReviewId,
  OrganizationAuditEventId,
  OrganizationDepartmentId,
  OrganizationId,
  OrganizationTeamId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  ThreadId,
  UserId,
  WorkspaceId,
  CollaborationActivityId,
  CollaborationApprovalId,
  type CollaborationActivity,
  type CollaborationBranchClaim,
  type CollaborationFileTouch,
  type CollaborationPresence,
  type CollaborationPromptApproval,
  type CollaborationViewPreferences,
  type CollaborationWorkspaceSettings,
  type Organization,
  type OrganizationAccessGrant,
  type OrganizationAccessReview,
  type OrganizationAuditEvent,
  type OrganizationDepartment,
  type OrganizationEmployee,
  type OrganizationTeam,
  type ProviderAccount,
  type ProviderSessionIsolation,
  type Tenant,
  type TenantInvite,
  type TenantMembership,
  type Workspace,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  toPersistenceDecodeError,
  toPersistenceDecodeCauseError,
  toPersistenceSqlError,
  type TenancyRepositoryError,
} from "../Errors.ts";
import {
  type CollaborationMemberProfileRecord,
  type CollaborationMemberUsageRecord,
  type CollaborationPersistenceSnapshot,
  type OrganizationPersistenceSnapshot,
  type ProviderIsolationPersistenceSnapshot,
  TenancyRepository,
  type TenancyRepositoryShape,
  type TenantRuntimeLifecyclePersistenceSnapshot,
  type WorkspacePersistenceSnapshot,
} from "../Services/Tenancy.ts";

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

function parseArray(value: string | null): ReadonlyArray<unknown> | undefined {
  if (value === null) {
    return undefined;
  }
  return JSON.parse(value) as ReadonlyArray<unknown>;
}

function parseObject(value: string): unknown {
  return JSON.parse(value);
}

function toDecodeError(operation: string) {
  return (cause: unknown): TenancyRepositoryError =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(operation)(cause)
      : toPersistenceDecodeCauseError(operation)(cause);
}

function toSqlError(operation: string) {
  return (cause: unknown): TenancyRepositoryError => toPersistenceSqlError(operation)(cause);
}

const makeTenancyRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const loadOrganizations: TenancyRepositoryShape["loadOrganizations"] = () =>
    Effect.gen(function* () {
      const [
        organizationRows,
        tenantRows,
        membershipRows,
        employeeRows,
        inviteRows,
        teamRows,
        departmentRows,
        grantRows,
        reviewRows,
        auditRows,
      ] = yield* Effect.all([
        sql`SELECT * FROM organizations`,
        sql`SELECT * FROM tenants`,
        sql`SELECT * FROM tenant_memberships WHERE organization_id IS NOT NULL`,
        sql`SELECT * FROM organization_employees`,
        sql`SELECT * FROM tenant_invites WHERE workspace_id IS NULL`,
        sql`SELECT * FROM organization_teams`,
        sql`SELECT * FROM organization_departments`,
        sql`SELECT * FROM organization_access_grants`,
        sql`SELECT * FROM organization_access_reviews`,
        sql`SELECT * FROM organization_audit_events ORDER BY created_at ASC, event_id ASC`,
      ]).pipe(Effect.mapError(toSqlError("TenancyRepository.loadOrganizations:query")));

      const memberships = new Map<string, TenantMembership>(
        (membershipRows as any[]).map((row) => {
          const membership: TenantMembership = {
            id: MembershipId.make(row.membership_id),
            tenantId: TenantId.make(row.tenant_id),
            userId: UserId.make(row.user_id),
            organizationId:
              row.organization_id === null ? null : OrganizationId.make(row.organization_id),
            roles: parseArray(row.roles_json) as TenantMembership["roles"],
            ...(row.organization_roles_json
              ? {
                  organizationRoles: parseArray(row.organization_roles_json) as NonNullable<
                    TenantMembership["organizationRoles"]
                  >,
                }
              : {}),
            ...(row.team_ids_json
              ? {
                  teamIds: (parseArray(row.team_ids_json) as string[]).map((id) =>
                    OrganizationTeamId.make(id),
                  ),
                }
              : {}),
            ...(row.department_id !== undefined
              ? {
                  departmentId:
                    row.department_id === null
                      ? null
                      : OrganizationDepartmentId.make(row.department_id),
                }
              : {}),
            createdAt: row.created_at,
            disabledAt: row.disabled_at,
          };
          return [membership.id, membership] as const;
        }),
      );

      return {
        organizations: (organizationRows as any[]).map(
          (row): Organization => ({
            id: OrganizationId.make(row.organization_id),
            slug: row.slug,
            displayName: row.display_name,
            createdAt: row.created_at,
            archivedAt: row.archived_at,
          }),
        ),
        tenants: (tenantRows as any[]).map(
          (row): Tenant => ({
            id: TenantId.make(row.tenant_id),
            slug: row.slug,
            displayName: row.display_name,
            kind: row.kind,
            organizationId:
              row.organization_id === null ? null : OrganizationId.make(row.organization_id),
            runtimeId: TenantRuntimeId.make(row.runtime_id),
            createdAt: row.created_at,
            archivedAt: row.archived_at,
          }),
        ),
        memberships: Array.from(memberships.values()),
        employees: (employeeRows as any[]).flatMap((row): OrganizationEmployee[] => {
          const membership = memberships.get(row.membership_id);
          return membership
            ? [
                {
                  membership,
                  email: row.email,
                  displayName: row.display_name,
                  status: row.status,
                },
              ]
            : [];
        }),
        invites: decodeInviteRows(inviteRows as any[]),
        teams: (teamRows as any[]).map(
          (row): OrganizationTeam => ({
            id: OrganizationTeamId.make(row.team_id),
            organizationId: OrganizationId.make(row.organization_id),
            slug: row.slug,
            displayName: row.display_name,
            createdAt: row.created_at,
            archivedAt: row.archived_at,
          }),
        ),
        departments: (departmentRows as any[]).map(
          (row): OrganizationDepartment => ({
            id: OrganizationDepartmentId.make(row.department_id),
            organizationId: OrganizationId.make(row.organization_id),
            slug: row.slug,
            displayName: row.display_name,
            createdAt: row.created_at,
            archivedAt: row.archived_at,
          }),
        ),
        grants: (grantRows as any[]).map(
          (row): OrganizationAccessGrant => ({
            id: OrganizationAccessGrantId.make(row.grant_id),
            organizationId: OrganizationId.make(row.organization_id),
            membershipId: MembershipId.make(row.membership_id),
            scope: parseObject(row.scope_json) as OrganizationAccessGrant["scope"],
            roles: parseArray(row.roles_json) as OrganizationAccessGrant["roles"],
            grantedByUserId: UserId.make(row.granted_by_user_id),
            createdAt: row.created_at,
            revokedAt: row.revoked_at,
          }),
        ),
        reviews: (reviewRows as any[]).map(
          (row): OrganizationAccessReview => ({
            id: OrganizationAccessReviewId.make(row.review_id),
            organizationId: OrganizationId.make(row.organization_id),
            requestedByUserId: UserId.make(row.requested_by_user_id),
            status: row.status,
            membershipIds: (parseArray(row.membership_ids_json) as string[]).map((id) =>
              MembershipId.make(id),
            ),
            createdAt: row.created_at,
            completedAt: row.completed_at,
          }),
        ),
        auditEvents: (auditRows as any[]).map(
          (row): OrganizationAuditEvent => ({
            id: OrganizationAuditEventId.make(row.event_id),
            organizationId: OrganizationId.make(row.organization_id),
            actorUserId: UserId.make(row.actor_user_id),
            kind: row.kind,
            summary: row.summary,
            createdAt: row.created_at,
          }),
        ),
      } satisfies OrganizationPersistenceSnapshot;
    }).pipe(Effect.mapError(toDecodeError("TenancyRepository.loadOrganizations:decode")));

  const loadCollaboration: TenancyRepositoryShape["loadCollaboration"] = () =>
    Effect.gen(function* () {
      const [
        presenceRows,
        inviteRows,
        membershipRows,
        activityRows,
        settingsRows,
        approvalRows,
        viewRows,
        branchRows,
        touchRows,
        memberProfileRows,
        memberUsageRows,
      ] = yield* Effect.all([
        sql`SELECT * FROM collaboration_presence`,
        sql`SELECT * FROM tenant_invites WHERE workspace_id IS NOT NULL`,
        sql`SELECT * FROM tenant_memberships WHERE organization_id IS NULL`,
        sql`SELECT * FROM collaboration_activities ORDER BY created_at ASC, activity_id ASC`,
        sql`SELECT * FROM collaboration_workspace_settings`,
        sql`SELECT * FROM collaboration_prompt_approvals ORDER BY created_at ASC`,
        sql`SELECT * FROM collaboration_view_preferences`,
        sql`SELECT * FROM collaboration_branch_claims`,
        sql`SELECT * FROM collaboration_file_touches`,
        sql`SELECT * FROM collaboration_member_profiles`,
        sql`SELECT * FROM collaboration_member_usage`,
      ]).pipe(Effect.mapError(toSqlError("TenancyRepository.loadCollaboration:query")));

      return {
        presence: (presenceRows as any[]).map((row): CollaborationPresence => {
          const presence: CollaborationPresence = {
            userId: UserId.make(row.user_id),
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
            displayName: row.display_name,
            status: row.status,
            lastSeenAt: row.last_seen_at,
          };
          if (row.avatar_initials) {
            return Object.assign(presence, { avatarInitials: row.avatar_initials });
          }
          return presence;
        }),
        invites: decodeInviteRows(inviteRows as any[]),
        memberships: (membershipRows as any[]).map((row): TenantMembership => {
          return Object.assign(
            {
              id: MembershipId.make(row.membership_id),
              tenantId: TenantId.make(row.tenant_id),
              userId: UserId.make(row.user_id),
              organizationId:
                row.organization_id === null ? null : OrganizationId.make(row.organization_id),
              roles: parseArray(row.roles_json) as TenantMembership["roles"],
              createdAt: row.created_at,
              disabledAt: row.disabled_at,
            },
            row.organization_roles_json
              ? {
                  organizationRoles: parseArray(row.organization_roles_json) as NonNullable<
                    TenantMembership["organizationRoles"]
                  >,
                }
              : undefined,
            row.team_ids_json
              ? {
                  teamIds: (parseArray(row.team_ids_json) as string[]).map((id) =>
                    OrganizationTeamId.make(id),
                  ),
                }
              : undefined,
            row.department_id !== undefined
              ? {
                  departmentId:
                    row.department_id === null
                      ? null
                      : OrganizationDepartmentId.make(row.department_id),
                }
              : undefined,
          );
        }),
        activities: (activityRows as any[]).map(
          (row): CollaborationActivity => ({
            id: CollaborationActivityId.make(row.activity_id),
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: row.workspace_id === null ? null : WorkspaceId.make(row.workspace_id),
            threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
            userId: UserId.make(row.user_id),
            kind: row.kind,
            summary: row.summary,
            hiddenAt: row.hidden_at ?? null,
            createdAt: row.created_at,
          }),
        ),
        settings: (settingsRows as any[]).map(
          (row): CollaborationWorkspaceSettings => ({
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            leadUserId: row.lead_user_id === null ? null : UserId.make(row.lead_user_id),
            approvalMode: row.approval_mode,
            approverUserIds: (parseArray(row.approver_user_ids_json) as string[]).map((id) =>
              UserId.make(id),
            ),
            updatedAt: row.updated_at,
          }),
        ),
        approvals: (approvalRows as any[]).map(
          (row): CollaborationPromptApproval => ({
            id: CollaborationApprovalId.make(row.approval_id),
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            threadId: row.thread_id === null ? null : ThreadId.make(row.thread_id),
            requestedByUserId: UserId.make(row.requested_by_user_id),
            requestedByName: row.requested_by_name,
            prompt: row.prompt,
            mode: row.mode,
            status: row.status,
            decidedByUserId:
              row.decided_by_user_id === null ? null : UserId.make(row.decided_by_user_id),
            decidedAt: row.decided_at,
            note: row.note,
            consumedAt: row.consumed_at ?? null,
            createdAt: row.created_at,
          }),
        ),
        viewPreferences: (viewRows as any[]).map(
          (row): CollaborationViewPreferences => ({
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            userId: UserId.make(row.user_id),
            showOthersPrompts: row.show_others_prompts !== 0,
            showOthersFiles: row.show_others_files !== 0,
            updatedAt: row.updated_at,
          }),
        ),
        branchClaims: (branchRows as any[]).map(
          (row): CollaborationBranchClaim => ({
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            userId: UserId.make(row.user_id),
            displayName: row.display_name,
            branch: row.branch,
            baseBranch: row.base_branch,
            worktreePath: row.worktree_path,
            createdAt: row.created_at,
          }),
        ),
        fileTouches: (touchRows as any[]).map(
          (row): CollaborationFileTouch => ({
            tenantId: TenantId.make(row.tenant_id),
            workspaceId: WorkspaceId.make(row.workspace_id),
            userId: UserId.make(row.user_id),
            displayName: row.display_name,
            path: row.path,
            touchedAt: row.touched_at,
          }),
        ),
        memberProfiles: (memberProfileRows as any[]).map(
          (row): CollaborationMemberProfileRecord => ({
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            userId: row.user_id,
            color: row.color,
            displayName: row.display_name,
            shareProfile: row.share_profile === null ? null : row.share_profile !== 0,
            shareUsage: row.share_usage === null ? null : row.share_usage !== 0,
            consentAt: row.consent_at,
            updatedAt: row.updated_at,
          }),
        ),
        memberUsage: (memberUsageRows as any[]).map(
          (row): CollaborationMemberUsageRecord => ({
            tenantId: row.tenant_id,
            workspaceId: row.workspace_id,
            userId: row.user_id,
            threadId: row.thread_id,
            totalTokens: Number(row.total_tokens),
            updatedAt: row.updated_at,
          }),
        ),
      } satisfies CollaborationPersistenceSnapshot;
    }).pipe(Effect.mapError(toDecodeError("TenancyRepository.loadCollaboration:decode")));

  const loadWorkspaces: TenancyRepositoryShape["loadWorkspaces"] = () =>
    Effect.gen(function* () {
      const rows =
        yield* sql`SELECT * FROM tenant_workspaces ORDER BY created_at ASC, workspace_id ASC`.pipe(
          Effect.mapError(toSqlError("TenancyRepository.loadWorkspaces:query")),
        );

      return {
        workspaces: (rows as any[]).map(
          (row): Workspace => ({
            id: WorkspaceId.make(row.workspace_id),
            tenantId: TenantId.make(row.tenant_id),
            organizationId:
              row.organization_id === null ? null : OrganizationId.make(row.organization_id),
            ownerUserId: UserId.make(row.owner_user_id),
            kind: row.kind,
            accessMode: row.access_mode,
            title: row.title,
            createdAt: row.created_at,
            archivedAt: row.archived_at,
          }),
        ),
      } satisfies WorkspacePersistenceSnapshot;
    }).pipe(Effect.mapError(toDecodeError("TenancyRepository.loadWorkspaces:decode")));

  const saveOrganizations: TenancyRepositoryShape["saveOrganizations"] = (snapshot) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const tenantIds = snapshot.tenants.map((tenant) => tenant.id);
          yield* sql`DELETE FROM organization_audit_events`;
          yield* sql`DELETE FROM organization_access_reviews`;
          yield* sql`DELETE FROM organization_access_grants`;
          yield* sql`DELETE FROM organization_departments`;
          yield* sql`DELETE FROM organization_teams`;
          yield* sql`DELETE FROM organization_employees`;
          yield* sql`DELETE FROM tenant_memberships WHERE organization_id IS NOT NULL`;
          yield* sql`DELETE FROM tenant_invites WHERE workspace_id IS NULL`;
          for (const tenantId of tenantIds) {
            yield* sql`DELETE FROM tenants WHERE tenant_id = ${tenantId}`;
          }
          yield* sql`DELETE FROM organizations`;

          for (const organization of snapshot.organizations) {
            yield* sql`
              INSERT INTO organizations VALUES (
                ${organization.id}, ${organization.slug}, ${organization.displayName},
                ${organization.createdAt}, ${organization.archivedAt}
              )
            `;
          }
          for (const tenant of snapshot.tenants) {
            yield* sql`
              INSERT INTO tenants VALUES (
                ${tenant.id}, ${tenant.slug}, ${tenant.displayName}, ${tenant.kind},
                ${tenant.organizationId}, ${tenant.runtimeId}, ${tenant.createdAt}, ${tenant.archivedAt}
              )
            `;
          }
          yield* persistMemberships(snapshot.memberships);
          yield* persistInvites(snapshot.invites);
          for (const employee of snapshot.employees) {
            yield* sql`
              INSERT INTO organization_employees VALUES (
                ${employee.membership.id}, ${employee.membership.organizationId},
                ${employee.email}, ${employee.displayName}, ${employee.status}
              )
            `;
          }
          for (const team of snapshot.teams) {
            yield* sql`
              INSERT INTO organization_teams VALUES (
                ${team.id}, ${team.organizationId}, ${team.slug}, ${team.displayName},
                ${team.createdAt}, ${team.archivedAt}
              )
            `;
          }
          for (const department of snapshot.departments) {
            yield* sql`
              INSERT INTO organization_departments VALUES (
                ${department.id}, ${department.organizationId}, ${department.slug}, ${department.displayName},
                ${department.createdAt}, ${department.archivedAt}
              )
            `;
          }
          for (const grant of snapshot.grants) {
            yield* sql`
              INSERT INTO organization_access_grants VALUES (
                ${grant.id}, ${grant.organizationId}, ${grant.membershipId}, ${stringify(grant.scope)},
                ${stringify(grant.roles)}, ${grant.grantedByUserId}, ${grant.createdAt}, ${grant.revokedAt}
              )
            `;
          }
          for (const review of snapshot.reviews) {
            yield* sql`
              INSERT INTO organization_access_reviews VALUES (
                ${review.id}, ${review.organizationId}, ${review.requestedByUserId}, ${review.status},
                ${stringify(review.membershipIds)}, ${review.createdAt}, ${review.completedAt}
              )
            `;
          }
          for (const event of snapshot.auditEvents) {
            yield* sql`
              INSERT INTO organization_audit_events VALUES (
                ${event.id}, ${event.organizationId}, ${event.actorUserId},
                ${event.kind}, ${event.summary}, ${event.createdAt}
              )
            `;
          }
        }),
      )
      .pipe(Effect.mapError(toSqlError("TenancyRepository.saveOrganizations:query")));

  const saveCollaboration: TenancyRepositoryShape["saveCollaboration"] = (snapshot) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM collaboration_activities`;
          yield* sql`DELETE FROM collaboration_presence`;
          yield* persistInvites(snapshot.invites);
          yield* persistMemberships(snapshot.memberships);
          for (const presence of snapshot.presence) {
            yield* sql`
              INSERT INTO collaboration_presence VALUES (
                ${[
                  presence.tenantId,
                  presence.workspaceId,
                  presence.threadId ?? "",
                  presence.userId,
                ].join(":")},
                ${presence.userId}, ${presence.tenantId}, ${presence.workspaceId}, ${presence.threadId},
                ${presence.displayName}, ${presence.status}, ${presence.lastSeenAt},
                ${presence.avatarInitials ?? null}
              )
            `;
          }
          for (const activity of snapshot.activities) {
            yield* sql`
              INSERT INTO collaboration_activities (
                activity_id, tenant_id, workspace_id, thread_id, user_id, kind,
                summary, created_at, hidden_at
              ) VALUES (
                ${activity.id}, ${activity.tenantId}, ${activity.workspaceId},
                ${activity.threadId}, ${activity.userId}, ${activity.kind},
                ${activity.summary}, ${activity.createdAt}, ${activity.hiddenAt}
              )
            `;
          }

          // An absent governance array means "this caller does not manage that
          // table", which is not the same as "delete everything in it".
          if (snapshot.settings) {
            yield* sql`DELETE FROM collaboration_workspace_settings`;
            for (const settings of snapshot.settings) {
              yield* sql`
                INSERT INTO collaboration_workspace_settings VALUES (
                  ${settings.tenantId}, ${settings.workspaceId}, ${settings.leadUserId},
                  ${settings.approvalMode}, ${JSON.stringify(settings.approverUserIds)},
                  ${settings.updatedAt}
                )
              `;
            }
          }
          if (snapshot.approvals) {
            yield* sql`DELETE FROM collaboration_prompt_approvals`;
            for (const approval of snapshot.approvals) {
              yield* sql`
                INSERT INTO collaboration_prompt_approvals VALUES (
                  ${approval.id}, ${approval.tenantId}, ${approval.workspaceId},
                  ${approval.threadId}, ${approval.requestedByUserId}, ${approval.requestedByName},
                  ${approval.prompt}, ${approval.mode}, ${approval.status},
                  ${approval.decidedByUserId}, ${approval.decidedAt}, ${approval.note},
                  ${approval.createdAt}, ${approval.consumedAt}
                )
              `;
            }
          }
          if (snapshot.viewPreferences) {
            yield* sql`DELETE FROM collaboration_view_preferences`;
            for (const preferences of snapshot.viewPreferences) {
              yield* sql`
                INSERT INTO collaboration_view_preferences VALUES (
                  ${preferences.tenantId}, ${preferences.workspaceId}, ${preferences.userId},
                  ${preferences.showOthersPrompts ? 1 : 0}, ${preferences.showOthersFiles ? 1 : 0},
                  ${preferences.updatedAt}
                )
              `;
            }
          }
          if (snapshot.branchClaims) {
            yield* sql`DELETE FROM collaboration_branch_claims`;
            for (const claim of snapshot.branchClaims) {
              yield* sql`
                INSERT INTO collaboration_branch_claims VALUES (
                  ${claim.tenantId}, ${claim.workspaceId}, ${claim.userId}, ${claim.displayName},
                  ${claim.branch}, ${claim.baseBranch}, ${claim.worktreePath}, ${claim.createdAt}
                )
              `;
            }
          }
          if (snapshot.memberProfiles) {
            yield* sql`DELETE FROM collaboration_member_profiles`;
            for (const profile of snapshot.memberProfiles) {
              yield* sql`
                INSERT INTO collaboration_member_profiles (
                  tenant_id, workspace_id, user_id, color, display_name,
                  share_profile, share_usage, consent_at, updated_at
                ) VALUES (
                  ${profile.tenantId}, ${profile.workspaceId}, ${profile.userId},
                  ${profile.color}, ${profile.displayName},
                  ${profile.shareProfile === null ? null : profile.shareProfile ? 1 : 0},
                  ${profile.shareUsage === null ? null : profile.shareUsage ? 1 : 0},
                  ${profile.consentAt}, ${profile.updatedAt}
                )
              `;
            }
          }
          if (snapshot.memberUsage) {
            yield* sql`DELETE FROM collaboration_member_usage`;
            for (const usage of snapshot.memberUsage) {
              yield* sql`
                INSERT INTO collaboration_member_usage (
                  tenant_id, workspace_id, user_id, thread_id, total_tokens, updated_at
                ) VALUES (
                  ${usage.tenantId}, ${usage.workspaceId}, ${usage.userId}, ${usage.threadId},
                  ${usage.totalTokens}, ${usage.updatedAt}
                )
              `;
            }
          }
          if (snapshot.fileTouches) {
            yield* sql`DELETE FROM collaboration_file_touches`;
            for (const touch of snapshot.fileTouches) {
              yield* sql`
                INSERT INTO collaboration_file_touches VALUES (
                  ${touch.tenantId}, ${touch.workspaceId}, ${touch.path}, ${touch.userId},
                  ${touch.displayName}, ${touch.touchedAt}
                )
              `;
            }
          }
        }),
      )
      .pipe(Effect.mapError(toSqlError("TenancyRepository.saveCollaboration:query")));

  const saveWorkspaces: TenancyRepositoryShape["saveWorkspaces"] = (snapshot) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM tenant_workspaces`;
          for (const workspace of snapshot.workspaces) {
            yield* sql`
              INSERT INTO tenant_workspaces VALUES (
                ${workspace.id}, ${workspace.tenantId}, ${workspace.organizationId},
                ${workspace.ownerUserId}, ${workspace.kind}, ${workspace.accessMode},
                ${workspace.title}, ${workspace.createdAt}, ${workspace.archivedAt}
              )
            `;
          }
        }),
      )
      .pipe(Effect.mapError(toSqlError("TenancyRepository.saveWorkspaces:query")));

  const loadProviderIsolation: TenancyRepositoryShape["loadProviderIsolation"] = () =>
    Effect.gen(function* () {
      const [accountRows, sessionRows] = yield* Effect.all([
        sql`SELECT * FROM provider_accounts`,
        sql`SELECT * FROM provider_session_isolation ORDER BY created_at ASC, provider_session_id ASC`,
      ]).pipe(Effect.mapError(toSqlError("TenancyRepository.loadProviderIsolation:query")));

      return {
        providerAccounts: (accountRows as any[]).map(
          (row): ProviderAccount => ({
            id: ProviderAccountId.make(row.provider_account_id),
            provider: row.provider,
            tenantId: TenantId.make(row.tenant_id),
            owner: parseObject(row.owner_json) as ProviderAccount["owner"],
            sharing: row.sharing,
            authHomeDir: row.auth_home_dir,
            configDir: row.config_dir,
            secretsDir: row.secrets_dir,
            createdAt: row.created_at,
            disabledAt: row.disabled_at,
          }),
        ),
        providerSessions: (sessionRows as any[]).map(
          (row): ProviderSessionIsolation => ({
            id: ProviderSessionId.make(row.provider_session_id),
            tenantId: TenantId.make(row.tenant_id),
            userId: UserId.make(row.user_id),
            providerAccountId: ProviderAccountId.make(row.provider_account_id),
            provider: row.provider,
            providerHomeDir: row.provider_home_dir,
            cwd: row.cwd,
            createdAt: row.created_at,
            endedAt: row.ended_at,
          }),
        ),
      } satisfies ProviderIsolationPersistenceSnapshot;
    }).pipe(Effect.mapError(toDecodeError("TenancyRepository.loadProviderIsolation:decode")));

  const saveProviderIsolation: TenancyRepositoryShape["saveProviderIsolation"] = (snapshot) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM provider_session_isolation`;
          yield* sql`DELETE FROM provider_accounts`;

          for (const account of snapshot.providerAccounts) {
            yield* sql`
              INSERT INTO provider_accounts VALUES (
                ${account.id}, ${account.provider}, ${account.tenantId},
                ${stringify(account.owner)}, ${account.sharing}, ${account.authHomeDir},
                ${account.configDir}, ${account.secretsDir}, ${account.createdAt},
                ${account.disabledAt}
              )
            `;
          }
          for (const session of snapshot.providerSessions) {
            yield* sql`
              INSERT INTO provider_session_isolation VALUES (
                ${session.id}, ${session.tenantId}, ${session.userId},
                ${session.providerAccountId}, ${session.provider}, ${session.providerHomeDir},
                ${session.cwd}, ${session.createdAt}, ${session.endedAt}
              )
            `;
          }
        }),
      )
      .pipe(Effect.mapError(toSqlError("TenancyRepository.saveProviderIsolation:query")));

  const loadTenantRuntimeLifecycleState: TenancyRepositoryShape["loadTenantRuntimeLifecycleState"] =
    () =>
      Effect.gen(function* () {
        const [runtimeRows, unitRows, stepRows] = yield* Effect.all([
          sql`SELECT * FROM tenant_runtime_descriptors ORDER BY tenant_id ASC, runtime_id ASC`,
          sql`SELECT * FROM tenant_runtime_systemd_units ORDER BY generated_at ASC, runtime_id ASC`,
          sql`SELECT * FROM tenant_runtime_lifecycle_steps ORDER BY completed_at ASC, idempotency_key ASC`,
        ]).pipe(
          Effect.mapError(toSqlError("TenancyRepository.loadTenantRuntimeLifecycleState:query")),
        );

        return {
          runtimes: (runtimeRows as any[]).map((row) => ({
            runtimeId: TenantRuntimeId.make(row.runtime_id),
            tenantId: TenantId.make(row.tenant_id),
            strategy: row.strategy,
            linuxUser: row.linux_user,
            baseDir: row.base_dir,
            dataDir: row.data_dir,
            secretsDir: row.secrets_dir,
            attachmentsDir: row.attachments_dir,
            worktreesDir: row.worktrees_dir,
            runsDir: row.runs_dir,
            providerHomesDir: row.provider_homes_dir,
            internalHost: row.internal_host,
            internalPort: row.internal_port,
            status: row.status,
            idleShutdownAfterMs: row.idle_shutdown_after_ms,
            lastStartedAt: row.last_started_at,
            lastStoppedAt: row.last_stopped_at,
          })),
          systemdUnits: (unitRows as any[]).map((row) => ({
            tenantId: TenantId.make(row.tenant_id),
            runtimeId: TenantRuntimeId.make(row.runtime_id),
            unitName: row.unit_name,
            unitFile: row.unit_file,
            generatedAt: row.generated_at,
            lastWrittenAt: row.last_written_at,
          })),
          completedSteps: (stepRows as any[]).map((row) => ({
            idempotencyKey: row.idempotency_key,
            tenantId: TenantId.make(row.tenant_id),
            runtimeId: TenantRuntimeId.make(row.runtime_id),
            operation: row.operation,
            sourceAction: row.source_action,
            targetStatus: row.target_status,
            processAction: row.process_action === 1,
            reason: row.reason,
            completedAt: row.completed_at,
          })),
        } satisfies TenantRuntimeLifecyclePersistenceSnapshot;
      }).pipe(
        Effect.mapError(toDecodeError("TenancyRepository.loadTenantRuntimeLifecycleState:decode")),
      );

  const saveTenantRuntimeLifecycleState: TenancyRepositoryShape["saveTenantRuntimeLifecycleState"] =
    (snapshot) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM tenant_runtime_lifecycle_steps`;
            yield* sql`DELETE FROM tenant_runtime_systemd_units`;
            yield* sql`DELETE FROM tenant_runtime_descriptors`;

            for (const runtime of snapshot.runtimes) {
              yield* sql`
                INSERT INTO tenant_runtime_descriptors VALUES (
                  ${runtime.runtimeId}, ${runtime.tenantId}, ${runtime.strategy},
                  ${runtime.linuxUser}, ${runtime.baseDir}, ${runtime.dataDir},
                  ${runtime.secretsDir}, ${runtime.attachmentsDir}, ${runtime.worktreesDir},
                  ${runtime.runsDir}, ${runtime.providerHomesDir}, ${runtime.internalHost},
                  ${runtime.internalPort}, ${runtime.status}, ${runtime.idleShutdownAfterMs},
                  ${runtime.lastStartedAt}, ${runtime.lastStoppedAt}
                )
              `;
            }
            for (const unit of snapshot.systemdUnits) {
              yield* sql`
                INSERT INTO tenant_runtime_systemd_units VALUES (
                  ${unit.runtimeId}, ${unit.tenantId}, ${unit.unitName},
                  ${unit.unitFile}, ${unit.generatedAt}, ${unit.lastWrittenAt}
                )
              `;
            }
            for (const step of snapshot.completedSteps) {
              yield* sql`
                INSERT INTO tenant_runtime_lifecycle_steps VALUES (
                  ${step.idempotencyKey}, ${step.tenantId}, ${step.runtimeId},
                  ${step.operation}, ${step.sourceAction}, ${step.targetStatus},
                  ${step.processAction ? 1 : 0}, ${step.reason}, ${step.completedAt}
                )
              `;
            }
          }),
        )
        .pipe(
          Effect.mapError(toSqlError("TenancyRepository.saveTenantRuntimeLifecycleState:query")),
        );

  function persistInvites(invites: ReadonlyArray<TenantInvite>) {
    return Effect.forEach(
      invites,
      (invite) =>
        sql`
        INSERT OR REPLACE INTO tenant_invites VALUES (
          ${invite.id}, ${invite.tenantId}, ${invite.workspaceId}, ${invite.invitedByUserId},
          ${invite.email}, ${invite.scope}, ${stringify(invite.roles)}, ${invite.createdAt},
          ${invite.expiresAt}, ${invite.acceptedAt}, ${invite.revokedAt}
        )
      `,
    ).pipe(Effect.asVoid);
  }

  function persistMemberships(memberships: ReadonlyArray<TenantMembership>) {
    return Effect.forEach(
      memberships,
      (membership) =>
        sql`
        INSERT OR REPLACE INTO tenant_memberships VALUES (
          ${membership.id}, ${membership.tenantId}, ${membership.userId}, ${membership.organizationId},
          ${stringify(membership.roles)}, ${membership.organizationRoles ? stringify(membership.organizationRoles) : null},
          ${membership.teamIds ? stringify(membership.teamIds) : null}, ${membership.departmentId ?? null},
          ${membership.createdAt}, ${membership.disabledAt}
        )
      `,
    ).pipe(Effect.asVoid);
  }

  return {
    loadOrganizations,
    saveOrganizations,
    loadCollaboration,
    saveCollaboration,
    loadWorkspaces,
    saveWorkspaces,
    loadProviderIsolation,
    saveProviderIsolation,
    loadTenantRuntimeLifecycleState,
    saveTenantRuntimeLifecycleState,
  } satisfies TenancyRepositoryShape;
});

function decodeInviteRows(rows: any[]): TenantInvite[] {
  return rows.map(
    (row): TenantInvite => ({
      id: InviteId.make(row.invite_id),
      tenantId: TenantId.make(row.tenant_id),
      workspaceId: row.workspace_id === null ? null : WorkspaceId.make(row.workspace_id),
      invitedByUserId: UserId.make(row.invited_by_user_id),
      email: row.email,
      scope: row.scope,
      roles: parseArray(row.roles_json) as TenantInvite["roles"],
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      acceptedAt: row.accepted_at,
      revokedAt: row.revoked_at,
    }),
  );
}

export const TenancyRepositoryLive = Layer.effect(TenancyRepository, makeTenancyRepository);
