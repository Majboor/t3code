import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  MembershipId,
  type OrchestrationReadModel,
  ProjectId,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { LocalAuthAccountRepository } from "../persistence/Services/LocalAuthAccounts.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { notebookExecuteRouteLayer } from "./http.ts";

/**
 * `/api/notebook/execute` starts a kernel in the directory the caller names,
 * as the server process. Scoping the kernel id per user keeps two people's
 * variables apart and does nothing at all about the filesystem, so the only
 * thing standing between a signed-up stranger and every other tenant's files
 * is whether this route checks the `cwd` it was handed.
 *
 * The refusal has to land before `executeCell` is reached — a test that let a
 * kernel start would be testing Python, not the gate — so these cases all end
 * in a 403 and the happy path is left to the notebook e2e.
 */

const OWNER_TENANT = TenantId.make("tenant-owner");
const OTHER_TENANT = TenantId.make("tenant-other");
const MEMBER_USER = UserId.make("user-member");
const STRANGER_USER = UserId.make("user-stranger");
const WORKSPACE_ROOT = "/srv/t3/tenant-runtimes/tenant-owner/data/projects/acme";

const NOW = "2026-01-01T00:00:00.000Z";

const makeSession = (userId: UserId, tenantId: TenantId): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`session-${userId}`),
  subject: `local-user:${userId}`,
  method: "browser-session-cookie",
  role: "client",
  client: { deviceType: "desktop" },
  userId,
  tenantSessionContext: {
    authSessionId: AuthSessionId.make(`session-${userId}`),
    userId,
    tenantId,
    organizationId: null,
    membershipIds: [MembershipId.make(`membership-${userId}`)],
    roles: ["developer"],
    activeWorkspaceId: null,
    issuedAt: NOW,
    expiresAt: "2030-01-01T00:00:00.000Z",
  },
});

const readModel: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: NOW,
  threads: [],
  projects: [
    {
      id: ProjectId.make("project-owned"),
      title: "Owned Project",
      workspaceRoot: WORKSPACE_ROOT,
      ownership: {
        tenantId: OWNER_TENANT,
        tenantDisplayName: "Owner Tenant",
        workspaceId: WorkspaceId.make("workspace-owned"),
        workspaceTitle: "Owned Workspace",
        organizationId: null,
        organizationDisplayName: null,
        ownerUserId: MEMBER_USER,
        ownerDisplayName: "Member",
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
};

// Two enabled accounts, so `isSoleOccupantSession` never short-circuits the
// authorization chain these tests exist to exercise. A single-account install
// is the desktop case and is covered by soleOccupant.test.ts.
const localAuthAccountsLayer = Layer.mock(LocalAuthAccountRepository)({
  countEnabled: () => Effect.succeed(2),
});

const tenancyLayer = Layer.mock(TenancyRepository)({
  loadOrganizations: () =>
    Effect.succeed({
      organizations: [],
      tenants: [],
      employees: [],
      invites: [],
      memberships: [
        {
          id: MembershipId.make("membership-member"),
          tenantId: OWNER_TENANT,
          userId: MEMBER_USER,
          organizationId: null,
          roles: ["developer" as const] as const,
          createdAt: NOW,
          disabledAt: null,
        },
        {
          id: MembershipId.make("membership-stranger"),
          tenantId: OTHER_TENANT,
          userId: STRANGER_USER,
          organizationId: null,
          roles: ["developer" as const] as const,
          createdAt: NOW,
          disabledAt: null,
        },
      ],
      teams: [],
      departments: [],
      grants: [],
      reviews: [],
      auditEvents: [],
    }),
  loadCollaboration: () =>
    Effect.succeed({ presence: [], invites: [], memberships: [], activities: [] }),
  loadProviderIsolation: () => Effect.succeed({ providerAccounts: [], providerSessions: [] }),
});

/**
 * The test config, published beyond loopback.
 *
 * That one flag is the whole difference between a laptop and a shared host:
 * left false, every session here would be the machine's own owner and the
 * permission chain would correctly wave it through, testing nothing.
 */
const hostedServerConfigLayer = Layer.effect(
  ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    return { ...config, publishedBeyondLoopback: true };
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-hosted-config-" })));

const buildAppUnderTest = (session: AuthenticatedSession) =>
  Layer.build(
    HttpRouter.serve(notebookExecuteRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(ServerAuth)({
          authenticateHttpRequest: () =>
            session === null
              ? Effect.fail(new AuthError({ message: "Unauthorized request.", status: 401 }))
              : Effect.succeed(session),
        }),
      ),
      Layer.provide(hostedServerConfigLayer),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({ getReadModel: () => Effect.succeed(readModel) }),
      ),
      Layer.provide(tenancyLayer),
      Layer.provide(localAuthAccountsLayer),
    ),
  );

const testEnvironment = NodeHttpServer.layerTest;

const execute = (cwd: string) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const response = yield* Effect.promise(() =>
      fetch(`http://127.0.0.1:${address.port}/api/notebook/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kernelId: "nb-1", cwd, code: "print(1)" }),
      }),
    );
    return response.status;
  });

it.live("refuses to run a cell in a project the session holds no membership in", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest(makeSession(STRANGER_USER, OTHER_TENANT));

    assert.equal(yield* execute(WORKSPACE_ROOT), 403);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses to run a cell in a directory no workspace root contains", () =>
  Effect.gen(function* () {
    yield* buildAppUnderTest(makeSession(MEMBER_USER, OWNER_TENANT));

    // The original hole, in one line: a valid session, a legal-looking cwd,
    // and a kernel started at the root of the host.
    assert.equal(yield* execute("/"), 403);
  }).pipe(Effect.provide(testEnvironment)),
);
