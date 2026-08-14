import {
  InviteId,
  MembershipId,
  OrganizationAccessGrantId,
  OrganizationAccessReviewId,
  OrganizationAuditEventId,
  OrganizationDepartmentId,
  OrganizationError,
  OrganizationId,
  OrganizationTeamId,
  TenantId,
  TenantRuntimeId,
  type Organization,
  type OrganizationAccessGrant,
  type OrganizationAccessReview,
  type OrganizationAuditEvent,
  type OrganizationDepartment,
  type OrganizationEmployee,
  type OrganizationTeam,
  type Tenant,
  type TenantInvite,
  type TenantMembership,
  UserId,
} from "@t3tools/contracts";
import { Effect, Layer, Ref } from "effect";

import {
  OrganizationService,
  type OrganizationServiceShape,
  type OrganizationState,
} from "../Services/OrganizationService.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";

const DEFAULT_AUDIT_LIMIT = 100;
const MAX_AUDIT_LIMIT = 500;

function nowIso(): string {
  return new Date().toISOString();
}

function organizationError(
  code: ConstructorParameters<typeof OrganizationError>[0]["code"],
  message: string,
) {
  return new OrganizationError({ code, message });
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function appendAudit(state: OrganizationState, event: OrganizationAuditEvent): OrganizationState {
  return {
    ...state,
    auditEvents: [...state.auditEvents.slice(-999), event],
  };
}

function makeAuditEvent(input: {
  readonly organizationId: OrganizationId;
  readonly actorUserId: UserId;
  readonly kind: OrganizationAuditEvent["kind"];
  readonly summary: string;
}): OrganizationAuditEvent {
  return {
    id: OrganizationAuditEventId.make(`org-audit:${crypto.randomUUID()}`),
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    kind: input.kind,
    summary: input.summary,
    createdAt: nowIso(),
  };
}

function stateFromSnapshot(persisted: {
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
}): OrganizationState {
  return {
    organizations: new Map(
      persisted.organizations.map((organization) => [organization.id, organization]),
    ),
    tenants: new Map(persisted.tenants.map((tenant) => [tenant.id, tenant])),
    employees: new Map(persisted.employees.map((employee) => [employee.membership.id, employee])),
    invites: new Map(persisted.invites.map((invite) => [invite.id, invite])),
    memberships: new Map(persisted.memberships.map((membership) => [membership.id, membership])),
    teams: new Map(persisted.teams.map((team) => [team.id, team])),
    departments: new Map(persisted.departments.map((department) => [department.id, department])),
    grants: new Map(persisted.grants.map((grant) => [grant.id, grant])),
    reviews: new Map(persisted.reviews.map((review) => [review.id, review])),
    auditEvents: persisted.auditEvents,
  };
}

function requireOrganization(
  state: OrganizationState,
  organizationId: OrganizationId,
): Effect.Effect<Organization, OrganizationError> {
  const organization = state.organizations.get(organizationId);
  if (!organization || organization.archivedAt !== null) {
    return Effect.fail(organizationError("organization-not-found", "Organization was not found."));
  }
  return Effect.succeed(organization);
}

function requireEmployee(
  state: OrganizationState,
  organizationId: OrganizationId,
  membershipId: MembershipId,
): Effect.Effect<OrganizationEmployee, OrganizationError> {
  const employee = state.employees.get(membershipId);
  if (!employee || employee.membership.organizationId !== organizationId) {
    return Effect.fail(
      organizationError("membership-not-found", "Employee membership was not found."),
    );
  }
  return Effect.succeed(employee);
}

function requireTeamsAndDepartment(
  state: OrganizationState,
  organizationId: OrganizationId,
  assignment: {
    readonly teamIds?: ReadonlyArray<OrganizationTeam["id"]> | undefined;
    readonly departmentId?: OrganizationDepartment["id"] | null | undefined;
  },
): Effect.Effect<void, OrganizationError> {
  for (const teamId of assignment.teamIds ?? []) {
    const team = state.teams.get(teamId);
    if (!team || team.organizationId !== organizationId || team.archivedAt !== null) {
      return Effect.fail(
        organizationError("team-not-found", `Team ${teamId} does not belong to this organization.`),
      );
    }
  }
  if (assignment.departmentId !== undefined && assignment.departmentId !== null) {
    const department = state.departments.get(assignment.departmentId);
    if (
      !department ||
      department.organizationId !== organizationId ||
      department.archivedAt !== null
    ) {
      return Effect.fail(
        organizationError(
          "department-not-found",
          `Department ${assignment.departmentId} does not belong to this organization.`,
        ),
      );
    }
  }
  return Effect.void;
}

const makeOrganizationService = Effect.gen(function* () {
  const repository = yield* TenancyRepository;
  const persisted = yield* repository.loadOrganizations().pipe(
    Effect.mapError(
      (cause) =>
        new OrganizationError({
          code: "organization-not-found",
          message: "Failed to load persisted organization state.",
          cause,
        }),
    ),
  );
  const stateRef = yield* Ref.make<OrganizationState>({
    ...stateFromSnapshot(persisted),
  });

  const persist = Ref.get(stateRef).pipe(
    Effect.flatMap((state) =>
      repository.saveOrganizations({
        organizations: Array.from(state.organizations.values()),
        tenants: Array.from(state.tenants.values()),
        employees: Array.from(state.employees.values()),
        invites: Array.from(state.invites.values()),
        memberships: Array.from(state.memberships.values()),
        teams: Array.from(state.teams.values()),
        departments: Array.from(state.departments.values()),
        grants: Array.from(state.grants.values()),
        reviews: Array.from(state.reviews.values()),
        auditEvents: state.auditEvents,
      }),
    ),
    Effect.mapError(
      (cause) =>
        new OrganizationError({
          code: "organization-not-found",
          message: "Failed to persist organization state.",
          cause,
        }),
    ),
  );

  const createOrganization: OrganizationServiceShape["createOrganization"] = (actor, input) =>
    Effect.gen(function* () {
      const createdAt = nowIso();
      const organization: Organization = {
        id: OrganizationId.make(`org:${crypto.randomUUID()}`),
        slug: input.slug,
        displayName: input.displayName,
        createdAt,
        archivedAt: null,
      };
      const tenant: Tenant = {
        id: TenantId.make(`tenant:${organization.slug}`),
        slug: organization.slug,
        displayName: organization.displayName,
        kind: "corporate",
        organizationId: organization.id,
        runtimeId: TenantRuntimeId.make(`runtime:${organization.slug}`),
        createdAt,
        archivedAt: null,
      };
      const ownerMembership: TenantMembership = {
        id: MembershipId.make(`membership:${crypto.randomUUID()}`),
        tenantId: tenant.id,
        userId: actor.userId,
        organizationId: organization.id,
        roles: ["owner"],
        organizationRoles: ["owner"],
        teamIds: [],
        departmentId: null,
        createdAt,
        disabledAt: null,
      };

      yield* Ref.update(stateRef, (state) => {
        const organizations = new Map(state.organizations);
        const tenants = new Map(state.tenants);
        const memberships = new Map(state.memberships);
        const employees = new Map(state.employees);
        organizations.set(organization.id, organization);
        tenants.set(tenant.id, tenant);
        memberships.set(ownerMembership.id, ownerMembership);
        employees.set(ownerMembership.id, {
          membership: ownerMembership,
          email: `${actor.userId}@local`,
          displayName: actor.displayName,
          status: "active",
        });
        return appendAudit(
          {
            ...state,
            organizations,
            tenants,
            memberships,
            employees,
          },
          makeAuditEvent({
            organizationId: organization.id,
            actorUserId: actor.userId,
            kind: "organization-created",
            summary: `${actor.displayName} created ${organization.displayName}.`,
          }),
        );
      });
      yield* persist;

      return { organization, tenant, ownerMembership };
    });

  const loadPersistedState = repository.loadOrganizations().pipe(
    Effect.map(stateFromSnapshot),
    Effect.tap((state) => Ref.set(stateRef, state)),
    Effect.mapError(
      (cause) =>
        new OrganizationError({
          code: "organization-not-found",
          message: "Failed to load persisted organization state.",
          cause,
        }),
    ),
  );

  const listOrganizations: OrganizationServiceShape["listOrganizations"] = () =>
    loadPersistedState.pipe(
      Effect.map((state) => ({
        organizations: Array.from(state.organizations.values()).filter(
          (organization) => organization.archivedAt === null,
        ),
        tenants: Array.from(state.tenants.values()).filter((tenant) => tenant.archivedAt === null),
        employees: Array.from(state.employees.values()),
        invites: Array.from(state.invites.values()),
        memberships: Array.from(state.memberships.values()),
        teams: Array.from(state.teams.values()).filter((team) => team.archivedAt === null),
        departments: Array.from(state.departments.values()).filter(
          (department) => department.archivedAt === null,
        ),
        grants: Array.from(state.grants.values()),
        reviews: Array.from(state.reviews.values()),
      })),
    );

  const inviteEmployee: OrganizationServiceShape["inviteEmployee"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      yield* requireTeamsAndDepartment(state, input.organizationId, {
        teamIds: input.teamIds,
        departmentId: input.departmentId,
      });
      const createdAt = nowIso();
      const invite: TenantInvite = {
        id: InviteId.make(`invite:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        workspaceId: null,
        invitedByUserId: actor.userId,
        email: input.email,
        scope: "tenant",
        roles: input.roles,
        createdAt,
        expiresAt: input.expiresAt,
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: null,
      };
      const membership: TenantMembership = {
        id: MembershipId.make(`membership:${crypto.randomUUID()}`),
        tenantId: input.tenantId,
        userId: UserId.make(`invited:${input.email}`),
        organizationId: input.organizationId,
        roles: input.roles,
        organizationRoles: input.organizationRoles,
        teamIds: input.teamIds ?? [],
        departmentId: input.departmentId ?? null,
        createdAt,
        disabledAt: null,
      };
      const employee: OrganizationEmployee = {
        membership,
        email: input.email,
        displayName: input.displayName,
        status: "invited",
      };

      yield* Ref.update(stateRef, (current) => {
        const invites = new Map(current.invites);
        const memberships = new Map(current.memberships);
        const employees = new Map(current.employees);
        invites.set(invite.id, invite);
        memberships.set(membership.id, membership);
        employees.set(membership.id, employee);
        return appendAudit(
          {
            ...current,
            invites,
            memberships,
            employees,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "employee-invited",
            summary: `${actor.displayName} invited ${input.email}.`,
          }),
        );
      });
      yield* persist;

      return { invite, employee };
    });

  const acceptEmployeeInvite: OrganizationServiceShape["acceptEmployeeInvite"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const invite = state.invites.get(input.inviteId);
      if (!invite) {
        return yield* organizationError("invalid-invite", "Employee invite was not found.");
      }

      if (invite.revokedAt !== null) {
        return yield* organizationError("invite-revoked", "Employee invite has been revoked.");
      }

      if (invite.acceptedAt !== null) {
        return yield* organizationError(
          "invite-accepted",
          "Employee invite has already been accepted.",
        );
      }

      if (Date.parse(invite.expiresAt) <= Date.now()) {
        return yield* organizationError("invite-expired", "Employee invite has expired.");
      }

      const invitedEmail = normalizeEmail(invite.email);
      if (actor.email !== undefined && normalizeEmail(actor.email) !== invitedEmail) {
        return yield* organizationError(
          "invalid-invite",
          "Sign in with the email address that was invited before accepting this invite.",
        );
      }
      const employee = Array.from(state.employees.values()).find(
        (candidate) =>
          candidate.membership.tenantId === invite.tenantId &&
          normalizeEmail(candidate.email) === invitedEmail &&
          candidate.membership.disabledAt === null,
      );
      if (!employee) {
        return yield* organizationError("invalid-invite", "Employee invite was not found.");
      }
      const organizationId = employee.membership.organizationId;
      if (organizationId === null) {
        return yield* organizationError("invalid-invite", "Employee invite was not found.");
      }

      const acceptedAt = nowIso();
      const acceptedInvite: TenantInvite = {
        ...invite,
        acceptedAt,
      };
      const membership: TenantMembership = {
        ...employee.membership,
        userId: actor.userId,
        disabledAt: null,
      };
      const acceptedEmployee: OrganizationEmployee = {
        ...employee,
        membership,
        status: "active",
      };

      yield* Ref.update(stateRef, (current) => {
        const invites = new Map(current.invites);
        const memberships = new Map(current.memberships);
        const employees = new Map(current.employees);
        invites.set(acceptedInvite.id, acceptedInvite);
        memberships.set(membership.id, membership);
        employees.set(membership.id, acceptedEmployee);
        return appendAudit(
          {
            ...current,
            invites,
            memberships,
            employees,
          },
          makeAuditEvent({
            organizationId,
            actorUserId: actor.userId,
            kind: "employee-updated",
            summary: `${actor.displayName} accepted the employee invite for ${employee.email}.`,
          }),
        );
      });
      yield* persist;

      return {
        invite: acceptedInvite,
        employee: acceptedEmployee,
        membership,
      };
    });

  const listEmployees: OrganizationServiceShape["listEmployees"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        requireOrganization(state, input.organizationId).pipe(
          Effect.as({
            employees: Array.from(state.employees.values()).filter(
              (employee) => employee.membership.organizationId === input.organizationId,
            ),
          }),
        ),
      ),
    );

  const updateEmployee: OrganizationServiceShape["updateEmployee"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const employee = yield* requireEmployee(state, input.organizationId, input.membershipId);
      if (employee.status === "disabled") {
        return yield* organizationError("employee-disabled", "Employee is disabled.");
      }
      yield* requireTeamsAndDepartment(state, input.organizationId, {
        teamIds: input.teamIds,
        departmentId: input.departmentId,
      });

      const nextMembership: TenantMembership = {
        ...employee.membership,
        ...(input.roles ? { roles: input.roles } : {}),
        ...(input.organizationRoles ? { organizationRoles: input.organizationRoles } : {}),
        ...(input.teamIds ? { teamIds: input.teamIds } : {}),
        ...(input.departmentId !== undefined ? { departmentId: input.departmentId } : {}),
      };
      const nextEmployee: OrganizationEmployee = {
        ...employee,
        membership: nextMembership,
        status: "active",
      };

      yield* Ref.update(stateRef, (current) => {
        const employees = new Map(current.employees);
        const memberships = new Map(current.memberships);
        employees.set(input.membershipId, nextEmployee);
        memberships.set(input.membershipId, nextMembership);
        return appendAudit(
          {
            ...current,
            employees,
            memberships,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "employee-updated",
            summary: `${actor.displayName} updated ${employee.displayName}.`,
          }),
        );
      });
      yield* persist;

      return { employee: nextEmployee };
    });

  const disableEmployee: OrganizationServiceShape["disableEmployee"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const employee = yield* requireEmployee(state, input.organizationId, input.membershipId);
      const disabledAt = nowIso();
      const nextMembership: TenantMembership = {
        ...employee.membership,
        disabledAt,
      };
      const nextEmployee: OrganizationEmployee = {
        ...employee,
        membership: nextMembership,
        status: "disabled",
      };

      yield* Ref.update(stateRef, (current) => {
        const employees = new Map(current.employees);
        const memberships = new Map(current.memberships);
        employees.set(input.membershipId, nextEmployee);
        memberships.set(input.membershipId, nextMembership);
        return appendAudit(
          {
            ...current,
            employees,
            memberships,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "employee-disabled",
            summary: `${actor.displayName} disabled ${employee.displayName}.`,
          }),
        );
      });
      yield* persist;

      return { employee: nextEmployee };
    });

  const createTeam: OrganizationServiceShape["createTeam"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const team: OrganizationTeam = {
        id: OrganizationTeamId.make(`org-team:${crypto.randomUUID()}`),
        organizationId: input.organizationId,
        slug: input.slug,
        displayName: input.displayName,
        createdAt: nowIso(),
        archivedAt: null,
      };

      yield* Ref.update(stateRef, (current) => {
        const teams = new Map(current.teams);
        teams.set(team.id, team);
        return appendAudit(
          {
            ...current,
            teams,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "team-created",
            summary: `${actor.displayName} created team ${team.displayName}.`,
          }),
        );
      });
      yield* persist;

      return { team };
    });

  const createDepartment: OrganizationServiceShape["createDepartment"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const department: OrganizationDepartment = {
        id: OrganizationDepartmentId.make(`org-department:${crypto.randomUUID()}`),
        organizationId: input.organizationId,
        slug: input.slug,
        displayName: input.displayName,
        createdAt: nowIso(),
        archivedAt: null,
      };

      yield* Ref.update(stateRef, (current) => {
        const departments = new Map(current.departments);
        departments.set(department.id, department);
        return appendAudit(
          {
            ...current,
            departments,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "department-created",
            summary: `${actor.displayName} created department ${department.displayName}.`,
          }),
        );
      });
      yield* persist;

      return { department };
    });

  const grantAccess: OrganizationServiceShape["grantAccess"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      yield* requireEmployee(state, input.organizationId, input.membershipId);
      const grant: OrganizationAccessGrant = {
        id: OrganizationAccessGrantId.make(`org-access-grant:${crypto.randomUUID()}`),
        organizationId: input.organizationId,
        membershipId: input.membershipId,
        scope: input.scope,
        roles: input.roles,
        grantedByUserId: actor.userId,
        createdAt: nowIso(),
        revokedAt: null,
      };

      yield* Ref.update(stateRef, (current) => {
        const grants = new Map(current.grants);
        grants.set(grant.id, grant);
        return appendAudit(
          {
            ...current,
            grants,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "access-granted",
            summary: `${actor.displayName} granted scoped access.`,
          }),
        );
      });
      yield* persist;

      return { grant };
    });

  const revokeAccess: OrganizationServiceShape["revokeAccess"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const grant = state.grants.get(input.grantId);
      if (!grant || grant.organizationId !== input.organizationId) {
        return yield* organizationError("access-grant-not-found", "Access grant was not found.");
      }
      if (grant.revokedAt !== null) {
        return yield* organizationError(
          "access-grant-already-revoked",
          "Access grant has already been revoked.",
        );
      }

      const revokedGrant: OrganizationAccessGrant = {
        ...grant,
        revokedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (current) => {
        const grants = new Map(current.grants);
        grants.set(revokedGrant.id, revokedGrant);
        return appendAudit(
          {
            ...current,
            grants,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "access-revoked",
            summary: `${actor.displayName} revoked scoped access.`,
          }),
        );
      });
      yield* persist;

      return { grant: revokedGrant };
    });

  const createAccessReview: OrganizationServiceShape["createAccessReview"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const review = {
        id: OrganizationAccessReviewId.make(`org-access-review:${crypto.randomUUID()}`),
        organizationId: input.organizationId,
        requestedByUserId: actor.userId,
        status: "open" as const,
        membershipIds: input.membershipIds,
        createdAt: nowIso(),
        completedAt: null,
      };

      yield* Ref.update(stateRef, (current) => {
        const reviews = new Map(current.reviews);
        reviews.set(review.id, review);
        return appendAudit(
          {
            ...current,
            reviews,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "access-review-created",
            summary: `${actor.displayName} started an access review.`,
          }),
        );
      });
      yield* persist;

      return { review };
    });

  const completeAccessReview: OrganizationServiceShape["completeAccessReview"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      yield* requireOrganization(state, input.organizationId);
      const review = state.reviews.get(input.reviewId);
      if (!review || review.organizationId !== input.organizationId) {
        return yield* organizationError("access-review-not-found", "Access review was not found.");
      }
      if (review.status === "completed") {
        return yield* organizationError(
          "access-review-already-completed",
          "Access review has already been completed.",
        );
      }

      const completedReview: OrganizationAccessReview = {
        ...review,
        status: "completed",
        completedAt: nowIso(),
      };

      yield* Ref.update(stateRef, (current) => {
        const reviews = new Map(current.reviews);
        reviews.set(completedReview.id, completedReview);
        return appendAudit(
          {
            ...current,
            reviews,
          },
          makeAuditEvent({
            organizationId: input.organizationId,
            actorUserId: actor.userId,
            kind: "access-review-completed",
            summary: `${actor.displayName} completed an access review.`,
          }),
        );
      });
      yield* persist;

      return { review: completedReview };
    });

  const recordAuditEvent: OrganizationServiceShape["recordAuditEvent"] = (actor, input) =>
    Effect.gen(function* () {
      const state = yield* Ref.get(stateRef);
      const baseState = state.organizations.has(input.organizationId)
        ? state
        : yield* repository.loadOrganizations().pipe(
            Effect.map(stateFromSnapshot),
            Effect.mapError(
              (cause) =>
                new OrganizationError({
                  code: "organization-not-found",
                  message: "Failed to load persisted organization state.",
                  cause,
                }),
            ),
          );
      yield* requireOrganization(baseState, input.organizationId);
      const event = makeAuditEvent({
        organizationId: input.organizationId,
        actorUserId: actor.userId,
        kind: input.kind,
        summary: input.summary,
      });
      yield* Ref.set(stateRef, appendAudit(baseState, event));
      yield* persist;
      return event;
    });

  const listAuditEvents: OrganizationServiceShape["listAuditEvents"] = (input) =>
    Ref.get(stateRef).pipe(
      Effect.flatMap((state) =>
        requireOrganization(state, input.organizationId).pipe(
          Effect.as({
            events: state.auditEvents
              .filter((event) => event.organizationId === input.organizationId)
              .slice(-Math.min(input.limit ?? DEFAULT_AUDIT_LIMIT, MAX_AUDIT_LIMIT))
              .toReversed(),
          }),
        ),
      ),
    );

  return {
    createOrganization,
    listOrganizations,
    inviteEmployee,
    acceptEmployeeInvite,
    listEmployees,
    updateEmployee,
    disableEmployee,
    createTeam,
    createDepartment,
    grantAccess,
    revokeAccess,
    createAccessReview,
    completeAccessReview,
    recordAuditEvent,
    listAuditEvents,
  } satisfies OrganizationServiceShape;
});

export const OrganizationServiceLive = Layer.effect(OrganizationService, makeOrganizationService);
