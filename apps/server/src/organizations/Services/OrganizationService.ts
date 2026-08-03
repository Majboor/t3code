import type {
  OrganizationAccessGrantInput,
  OrganizationAccessGrantResult,
  OrganizationAccessRevokeInput,
  OrganizationAccessRevokeResult,
  OrganizationAccessReviewCompleteInput,
  OrganizationAccessReviewCompleteResult,
  OrganizationAccessReviewCreateInput,
  OrganizationAccessReviewCreateResult,
  OrganizationAuditEvent,
  OrganizationAuditEventKind,
  OrganizationAuditListInput,
  OrganizationAuditListResult,
  OrganizationCreateInput,
  OrganizationCreateResult,
  OrganizationDepartment,
  OrganizationDepartmentCreateInput,
  OrganizationDepartmentCreateResult,
  OrganizationEmployee,
  OrganizationEmployeeDisableInput,
  OrganizationEmployeeInviteAcceptInput,
  OrganizationEmployeeInviteAcceptResult,
  OrganizationEmployeeInviteInput,
  OrganizationEmployeeInviteResult,
  OrganizationEmployeeListInput,
  OrganizationEmployeeListResult,
  OrganizationEmployeeUpdateInput,
  OrganizationEmployeeUpdateResult,
  OrganizationError,
  OrganizationListResult,
  OrganizationTeam,
  OrganizationTeamCreateInput,
  OrganizationTeamCreateResult,
  Organization,
  OrganizationAccessGrant,
  OrganizationAccessReview,
  Tenant,
  TenantInvite,
  TenantMembership,
  UserId,
} from "@t3tools/contracts";
import { Context, type Effect } from "effect";

export interface OrganizationActor {
  readonly userId: UserId;
  readonly displayName: string;
  readonly email?: string;
}

export interface OrganizationState {
  readonly organizations: ReadonlyMap<string, Organization>;
  readonly tenants: ReadonlyMap<string, Tenant>;
  readonly employees: ReadonlyMap<string, OrganizationEmployee>;
  readonly invites: ReadonlyMap<string, TenantInvite>;
  readonly memberships: ReadonlyMap<string, TenantMembership>;
  readonly teams: ReadonlyMap<string, OrganizationTeam>;
  readonly departments: ReadonlyMap<string, OrganizationDepartment>;
  readonly grants: ReadonlyMap<string, OrganizationAccessGrant>;
  readonly reviews: ReadonlyMap<string, OrganizationAccessReview>;
  readonly auditEvents: ReadonlyArray<OrganizationAuditEvent>;
}

export interface OrganizationServiceShape {
  readonly createOrganization: (
    actor: OrganizationActor,
    input: OrganizationCreateInput,
  ) => Effect.Effect<OrganizationCreateResult, OrganizationError>;
  readonly listOrganizations: () => Effect.Effect<OrganizationListResult, OrganizationError>;
  readonly inviteEmployee: (
    actor: OrganizationActor,
    input: OrganizationEmployeeInviteInput,
  ) => Effect.Effect<OrganizationEmployeeInviteResult, OrganizationError>;
  readonly acceptEmployeeInvite: (
    actor: OrganizationActor,
    input: OrganizationEmployeeInviteAcceptInput,
  ) => Effect.Effect<OrganizationEmployeeInviteAcceptResult, OrganizationError>;
  readonly listEmployees: (
    input: OrganizationEmployeeListInput,
  ) => Effect.Effect<OrganizationEmployeeListResult, OrganizationError>;
  readonly updateEmployee: (
    actor: OrganizationActor,
    input: OrganizationEmployeeUpdateInput,
  ) => Effect.Effect<OrganizationEmployeeUpdateResult, OrganizationError>;
  readonly disableEmployee: (
    actor: OrganizationActor,
    input: OrganizationEmployeeDisableInput,
  ) => Effect.Effect<OrganizationEmployeeUpdateResult, OrganizationError>;
  readonly createTeam: (
    actor: OrganizationActor,
    input: OrganizationTeamCreateInput,
  ) => Effect.Effect<OrganizationTeamCreateResult, OrganizationError>;
  readonly createDepartment: (
    actor: OrganizationActor,
    input: OrganizationDepartmentCreateInput,
  ) => Effect.Effect<OrganizationDepartmentCreateResult, OrganizationError>;
  readonly grantAccess: (
    actor: OrganizationActor,
    input: OrganizationAccessGrantInput,
  ) => Effect.Effect<OrganizationAccessGrantResult, OrganizationError>;
  readonly revokeAccess: (
    actor: OrganizationActor,
    input: OrganizationAccessRevokeInput,
  ) => Effect.Effect<OrganizationAccessRevokeResult, OrganizationError>;
  readonly createAccessReview: (
    actor: OrganizationActor,
    input: OrganizationAccessReviewCreateInput,
  ) => Effect.Effect<OrganizationAccessReviewCreateResult, OrganizationError>;
  readonly completeAccessReview: (
    actor: OrganizationActor,
    input: OrganizationAccessReviewCompleteInput,
  ) => Effect.Effect<OrganizationAccessReviewCompleteResult, OrganizationError>;
  readonly recordAuditEvent: (
    actor: OrganizationActor,
    input: {
      readonly organizationId: Organization["id"];
      readonly kind: OrganizationAuditEventKind;
      readonly summary: string;
    },
  ) => Effect.Effect<OrganizationAuditEvent, OrganizationError>;
  readonly listAuditEvents: (
    input: OrganizationAuditListInput,
  ) => Effect.Effect<OrganizationAuditListResult, OrganizationError>;
}

export class OrganizationService extends Context.Service<
  OrganizationService,
  OrganizationServiceShape
>()("t3/organizations/Services/OrganizationService") {}
