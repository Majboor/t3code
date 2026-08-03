import { assert, it } from "@effect/vitest";
import {
  OrganizationAccessGrantId,
  OrganizationDepartmentId,
  OrganizationTeamId,
  UserId,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { OrganizationServiceLive } from "./OrganizationService.ts";
import { OrganizationService } from "../Services/OrganizationService.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import type {
  CollaborationPersistenceSnapshot,
  OrganizationPersistenceSnapshot,
  ProviderIsolationPersistenceSnapshot,
  TenantRuntimeLifecyclePersistenceSnapshot,
  WorkspacePersistenceSnapshot,
} from "../../persistence/Services/Tenancy.ts";

function emptyOrganizations(): OrganizationPersistenceSnapshot {
  return {
    organizations: [],
    tenants: [],
    employees: [],
    invites: [],
    memberships: [],
    teams: [],
    departments: [],
    grants: [],
    reviews: [],
    auditEvents: [],
  };
}

function makeRepositoryLayer() {
  let organizations = emptyOrganizations();
  const emptyCollaboration: CollaborationPersistenceSnapshot = {
    presence: [],
    invites: [],
    memberships: [],
    activities: [],
  };
  const emptyWorkspaces: WorkspacePersistenceSnapshot = {
    workspaces: [],
  };
  const emptyProviderIsolation: ProviderIsolationPersistenceSnapshot = {
    providerAccounts: [],
    providerSessions: [],
  };
  const emptyTenantRuntimeLifecycle: TenantRuntimeLifecyclePersistenceSnapshot = {
    runtimes: [],
    systemdUnits: [],
    completedSteps: [],
  };

  return Layer.succeed(TenancyRepository, {
    // Read lazily so reloads (e.g. listOrganizations) observe later writes, matching
    // the real repository's behaviour. `Effect.succeed(organizations)` would instead
    // freeze the empty snapshot captured when the service builds its reload effect.
    loadOrganizations: () => Effect.sync(() => organizations),
    saveOrganizations: (snapshot) =>
      Effect.sync(() => {
        organizations = snapshot;
      }),
    loadCollaboration: () => Effect.succeed(emptyCollaboration),
    saveCollaboration: () => Effect.void,
    loadWorkspaces: () => Effect.succeed(emptyWorkspaces),
    saveWorkspaces: () => Effect.void,
    loadProviderIsolation: () => Effect.succeed(emptyProviderIsolation),
    saveProviderIsolation: () => Effect.void,
    loadTenantRuntimeLifecycleState: () => Effect.succeed(emptyTenantRuntimeLifecycle),
    saveTenantRuntimeLifecycleState: () => Effect.void,
  });
}

it.effect("accepts an employee invite for a newly authenticated user", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };
    const invitedActor = {
      userId: UserId.make("user-invited"),
      displayName: "Invited User",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme",
      displayName: "Acme",
    });
    const invited = yield* service.inviteEmployee(owner, {
      organizationId: created.organization.id,
      tenantId: created.tenant.id,
      email: "invited@example.com",
      displayName: "Invited Employee",
      roles: ["developer"] as const,
      organizationRoles: ["developer"] as const,
      teamIds: [],
      departmentId: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const accepted = yield* service.acceptEmployeeInvite(invitedActor, {
      inviteId: invited.invite.id,
    });

    assert.strictEqual(accepted.invite.acceptedAt !== null, true);
    assert.strictEqual(accepted.membership.userId, invitedActor.userId);
    assert.strictEqual(accepted.employee.status, "active");
    assert.strictEqual(accepted.employee.membership.userId, invitedActor.userId);

    const employees = yield* service.listEmployees({
      organizationId: created.organization.id,
    });
    const employee = employees.employees.find(
      (candidate) => candidate.membership.id === accepted.membership.id,
    );
    assert.deepStrictEqual(employee?.membership, accepted.membership);
    const audit = yield* service.listAuditEvents({
      organizationId: created.organization.id,
    });
    assert.strictEqual(
      audit.events.some((event) => event.summary.includes("accepted the employee invite")),
      true,
    );
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("rejects employee invite acceptance from a different local account email", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };
    const wrongAccountActor = {
      userId: UserId.make("user-wrong"),
      displayName: "Wrong User",
      email: "wrong@example.com",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-email-check",
      displayName: "Acme Email Check",
    });
    const invited = yield* service.inviteEmployee(owner, {
      organizationId: created.organization.id,
      tenantId: created.tenant.id,
      email: "invited@example.com",
      displayName: "Invited Employee",
      roles: ["developer"] as const,
      organizationRoles: ["developer"] as const,
      teamIds: [],
      departmentId: null,
      expiresAt: "2099-01-01T00:00:00.000Z",
    });

    const error = yield* Effect.flip(
      service.acceptEmployeeInvite(wrongAccountActor, {
        inviteId: invited.invite.id,
      }),
    );

    assert.strictEqual(error.code, "invalid-invite");
    assert.match(error.message, /email address that was invited/i);
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("rejects an invite that references a team outside the organization", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-team-check",
      displayName: "Acme Team Check",
    });

    const error = yield* Effect.flip(
      service.inviteEmployee(owner, {
        organizationId: created.organization.id,
        tenantId: created.tenant.id,
        email: "invited@example.com",
        displayName: "Invited Employee",
        roles: ["developer"] as const,
        organizationRoles: ["developer"] as const,
        teamIds: [OrganizationTeamId.make("org-team:does-not-exist")],
        departmentId: null,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    assert.strictEqual(error.code, "team-not-found");
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("rejects an invite that references a department outside the organization", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-dept-check",
      displayName: "Acme Department Check",
    });

    const error = yield* Effect.flip(
      service.inviteEmployee(owner, {
        organizationId: created.organization.id,
        tenantId: created.tenant.id,
        email: "invited@example.com",
        displayName: "Invited Employee",
        roles: ["developer"] as const,
        organizationRoles: ["developer"] as const,
        teamIds: [],
        departmentId: OrganizationDepartmentId.make("org-department:does-not-exist"),
        expiresAt: "2099-01-01T00:00:00.000Z",
      }),
    );

    assert.strictEqual(error.code, "department-not-found");
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("assigns an employee to a real team and department, but rejects unknown teams", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-scoped",
      displayName: "Acme Scoped",
    });
    const { team } = yield* service.createTeam(owner, {
      organizationId: created.organization.id,
      slug: "platform",
      displayName: "Platform",
    });
    const { department } = yield* service.createDepartment(owner, {
      organizationId: created.organization.id,
      slug: "engineering",
      displayName: "Engineering",
    });

    const updated = yield* service.updateEmployee(owner, {
      organizationId: created.organization.id,
      membershipId: created.ownerMembership.id,
      teamIds: [team.id],
      departmentId: department.id,
    });

    assert.deepStrictEqual(updated.employee.membership.teamIds, [team.id]);
    assert.strictEqual(updated.employee.membership.departmentId, department.id);

    const error = yield* Effect.flip(
      service.updateEmployee(owner, {
        organizationId: created.organization.id,
        membershipId: created.ownerMembership.id,
        teamIds: [OrganizationTeamId.make("org-team:ghost")],
      }),
    );

    assert.strictEqual(error.code, "team-not-found");

    const employees = yield* service.listEmployees({
      organizationId: created.organization.id,
    });
    const persisted = employees.employees.find(
      (candidate) => candidate.membership.id === created.ownerMembership.id,
    );
    assert.deepStrictEqual(persisted?.membership.teamIds, [team.id]);
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("revokes a scoped access grant and rejects revoking it twice", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-revoke",
      displayName: "Acme Revoke",
    });
    const { team } = yield* service.createTeam(owner, {
      organizationId: created.organization.id,
      slug: "platform",
      displayName: "Platform",
    });
    const { grant } = yield* service.grantAccess(owner, {
      organizationId: created.organization.id,
      membershipId: created.ownerMembership.id,
      scope: { type: "team", teamId: team.id },
      roles: ["developer"] as const,
    });
    assert.strictEqual(grant.revokedAt, null);

    const revoked = yield* service.revokeAccess(owner, {
      organizationId: created.organization.id,
      grantId: grant.id,
    });
    assert.strictEqual(revoked.grant.id, grant.id);
    assert.strictEqual(revoked.grant.revokedAt !== null, true);

    const listed = yield* service.listOrganizations();
    const persistedGrant = listed.grants.find((candidate) => candidate.id === grant.id);
    assert.strictEqual(persistedGrant?.revokedAt !== null, true);

    const audit = yield* service.listAuditEvents({
      organizationId: created.organization.id,
    });
    assert.strictEqual(
      audit.events.some((event) => event.kind === "access-revoked"),
      true,
    );

    const error = yield* Effect.flip(
      service.revokeAccess(owner, {
        organizationId: created.organization.id,
        grantId: grant.id,
      }),
    );
    assert.strictEqual(error.code, "access-grant-already-revoked");
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("rejects revoking an access grant that does not exist", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const created = yield* service.createOrganization(owner, {
      slug: "acme-revoke-missing",
      displayName: "Acme Revoke Missing",
    });

    const error = yield* Effect.flip(
      service.revokeAccess(owner, {
        organizationId: created.organization.id,
        grantId: OrganizationAccessGrantId.make("org-access-grant:does-not-exist"),
      }),
    );
    assert.strictEqual(error.code, "access-grant-not-found");
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);

it.effect("rejects revoking an access grant owned by a different organization", () =>
  Effect.gen(function* () {
    const service = yield* OrganizationService;
    const owner = {
      userId: UserId.make("user-owner"),
      displayName: "Owner",
    };

    const orgA = yield* service.createOrganization(owner, {
      slug: "acme-revoke-a",
      displayName: "Acme Revoke A",
    });
    const orgB = yield* service.createOrganization(owner, {
      slug: "acme-revoke-b",
      displayName: "Acme Revoke B",
    });
    const { team } = yield* service.createTeam(owner, {
      organizationId: orgA.organization.id,
      slug: "platform",
      displayName: "Platform",
    });
    const { grant } = yield* service.grantAccess(owner, {
      organizationId: orgA.organization.id,
      membershipId: orgA.ownerMembership.id,
      scope: { type: "team", teamId: team.id },
      roles: ["developer"] as const,
    });

    const error = yield* Effect.flip(
      service.revokeAccess(owner, {
        organizationId: orgB.organization.id,
        grantId: grant.id,
      }),
    );
    assert.strictEqual(error.code, "access-grant-not-found");

    const listed = yield* service.listOrganizations();
    const persistedGrant = listed.grants.find((candidate) => candidate.id === grant.id);
    assert.strictEqual(persistedGrant?.revokedAt, null);
  }).pipe(Effect.provide(OrganizationServiceLive.pipe(Layer.provide(makeRepositoryLayer())))),
);
