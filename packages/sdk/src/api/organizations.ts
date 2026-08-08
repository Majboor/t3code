/**
 * Organizations: employees, teams, departments, access grants, and the audit
 * trail behind them.
 *
 * @module api/organizations
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3OrganizationsApi {
  readonly create: (
    input: RpcInput<typeof WS_METHODS.organizationsCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationsCreate>>;
  /** Organizations, tenants, workspaces, and memberships visible to the caller. */
  readonly list: () => Promise<RpcSuccess<typeof WS_METHODS.organizationsList>>;

  readonly inviteEmployee: (
    input: RpcInput<typeof WS_METHODS.organizationEmployeesInvite>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationEmployeesInvite>>;
  readonly acceptEmployeeInvite: (
    input: RpcInput<typeof WS_METHODS.organizationEmployeesAcceptInvite>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationEmployeesAcceptInvite>>;
  readonly listEmployees: (
    input: RpcInput<typeof WS_METHODS.organizationEmployeesList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationEmployeesList>>;
  readonly updateEmployee: (
    input: RpcInput<typeof WS_METHODS.organizationEmployeesUpdate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationEmployeesUpdate>>;
  readonly disableEmployee: (
    input: RpcInput<typeof WS_METHODS.organizationEmployeesDisable>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationEmployeesDisable>>;

  readonly createTeam: (
    input: RpcInput<typeof WS_METHODS.organizationTeamsCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationTeamsCreate>>;
  readonly createDepartment: (
    input: RpcInput<typeof WS_METHODS.organizationDepartmentsCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationDepartmentsCreate>>;

  readonly grantAccess: (
    input: RpcInput<typeof WS_METHODS.organizationAccessGrant>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationAccessGrant>>;
  readonly revokeAccess: (
    input: RpcInput<typeof WS_METHODS.organizationAccessRevoke>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationAccessRevoke>>;
  readonly createAccessReview: (
    input: RpcInput<typeof WS_METHODS.organizationAccessReviewCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationAccessReviewCreate>>;
  readonly completeAccessReview: (
    input: RpcInput<typeof WS_METHODS.organizationAccessReviewComplete>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationAccessReviewComplete>>;
  readonly listAuditEvents: (
    input: RpcInput<typeof WS_METHODS.organizationAuditList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.organizationAuditList>>;
}

export function makeOrganizationsApi(transport: T3Transport): T3OrganizationsApi {
  return {
    create: (input) => transport.request((client) => client[WS_METHODS.organizationsCreate](input)),
    list: () => transport.request((client) => client[WS_METHODS.organizationsList]({})),

    inviteEmployee: (input) =>
      transport.request((client) => client[WS_METHODS.organizationEmployeesInvite](input)),
    acceptEmployeeInvite: (input) =>
      transport.request((client) => client[WS_METHODS.organizationEmployeesAcceptInvite](input)),
    listEmployees: (input) =>
      transport.request((client) => client[WS_METHODS.organizationEmployeesList](input)),
    updateEmployee: (input) =>
      transport.request((client) => client[WS_METHODS.organizationEmployeesUpdate](input)),
    disableEmployee: (input) =>
      transport.request((client) => client[WS_METHODS.organizationEmployeesDisable](input)),

    createTeam: (input) =>
      transport.request((client) => client[WS_METHODS.organizationTeamsCreate](input)),
    createDepartment: (input) =>
      transport.request((client) => client[WS_METHODS.organizationDepartmentsCreate](input)),

    grantAccess: (input) =>
      transport.request((client) => client[WS_METHODS.organizationAccessGrant](input)),
    revokeAccess: (input) =>
      transport.request((client) => client[WS_METHODS.organizationAccessRevoke](input)),
    createAccessReview: (input) =>
      transport.request((client) => client[WS_METHODS.organizationAccessReviewCreate](input)),
    completeAccessReview: (input) =>
      transport.request((client) => client[WS_METHODS.organizationAccessReviewComplete](input)),
    listAuditEvents: (input) =>
      transport.request((client) => client[WS_METHODS.organizationAuditList](input)),
  };
}
