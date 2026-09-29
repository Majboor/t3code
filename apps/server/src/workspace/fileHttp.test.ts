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
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { AuthError, ServerAuth, type AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { LocalAuthAccountRepository } from "../persistence/Services/LocalAuthAccounts.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { WorkspaceEntries } from "./Services/WorkspaceEntries.ts";
import { workspaceFileRouteLayer, workspaceFileUploadRouteLayer } from "./fileHttp.ts";

/**
 * The two `/api/workspace/file` routes, asked the only question that matters
 * about them: whether being signed in is enough to name any `cwd` on the host.
 *
 * `cwd` is a query parameter, so the route's containment check ("path stays
 * inside cwd") proves nothing about which project the caller is allowed to
 * touch — `cwd=/` satisfies it. These tests stand in for the hosted case the
 * WS RPCs have always covered: identity is stubbed, because who the caller is
 * belongs to `ServerAuth`; ownership and membership are the real data, because
 * that is what the decision is made from.
 */

const OWNER_TENANT = TenantId.make("tenant-owner");
const OTHER_TENANT = TenantId.make("tenant-other");
const MEMBER_USER = UserId.make("user-member");
const STRANGER_USER = UserId.make("user-stranger");

const NOW = "2026-01-01T00:00:00.000Z";

/** A hosted session: signed in, carrying a tenant, guest of this machine. */
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

const makeReadModel = (workspaceRoot: string): OrchestrationReadModel => ({
  snapshotSequence: 0,
  updatedAt: NOW,
  threads: [],
  projects: [
    {
      id: ProjectId.make("project-owned"),
      title: "Owned Project",
      workspaceRoot,
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
});

/** Memberships as the tables hold them: only the ones passed in exist. */
// Two enabled accounts, so `isSoleOccupantSession` never short-circuits the
// authorization chain these tests exist to exercise. A single-account install
// is the desktop case and is covered by soleOccupant.test.ts.
const localAuthAccountsLayer = Layer.mock(LocalAuthAccountRepository)({
  countEnabled: () => Effect.succeed(2),
});

const makeTenancyLayer = (memberships: ReadonlyArray<{ userId: UserId; tenantId: TenantId }>) =>
  Layer.mock(TenancyRepository)({
    loadOrganizations: () =>
      Effect.succeed({
        organizations: [],
        tenants: [],
        employees: [],
        invites: [],
        memberships: memberships.map((membership, index) => ({
          id: MembershipId.make(`membership-${index}`),
          tenantId: membership.tenantId,
          userId: membership.userId,
          organizationId: null,
          roles: ["developer" as const] as const,
          createdAt: NOW,
          disabledAt: null,
        })),
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

const routes = Layer.mergeAll(workspaceFileRouteLayer, workspaceFileUploadRouteLayer);

const buildAppUnderTest = (options: {
  readonly session: AuthenticatedSession;
  readonly workspaceRoot: string;
  readonly memberships: ReadonlyArray<{ userId: UserId; tenantId: TenantId }>;
}) =>
  Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.provide(
        Layer.mock(ServerAuth)({
          authenticateHttpRequest: () =>
            options.session === null
              ? Effect.fail(new AuthError({ message: "Unauthorized request.", status: 401 }))
              : Effect.succeed(options.session),
        }),
      ),
      // Published beyond loopback: this is a shared host, not somebody's
      // laptop, so the machine-owner shortcut must not apply.
      Layer.provide(hostedServerConfigLayer),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeReadModel(options.workspaceRoot)),
        }),
      ),
      Layer.provide(makeTenancyLayer(options.memberships)),
      Layer.provide(localAuthAccountsLayer),
      Layer.provide(Layer.mock(WorkspaceEntries)({ invalidate: () => Effect.void })),
    ),
  );

const testEnvironment = NodeHttpServer.layerTest;

const serverUrl = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;
  return `http://127.0.0.1:${address.port}`;
});

const fileUrl = (base: string, cwd: string, relativePath: string) =>
  `${base}/api/workspace/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relativePath)}`;

const makeWorkspace = Effect.promise(async () => {
  const root = await mkdtemp(nodePath.join(os.tmpdir(), "t3-file-http-"));
  await writeFile(nodePath.join(root, "secret.txt"), "tenant secret", "utf8");
  return root;
});

it.live("refuses a read of a project root the session holds no membership in", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(STRANGER_USER, OTHER_TENANT),
      workspaceRoot,
      memberships: [{ userId: STRANGER_USER, tenantId: OTHER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() => fetch(fileUrl(base, workspaceRoot, "secret.txt")));

    assert.equal(response.status, 403);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("serves a file to a member of the tenant that owns the root", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() => fetch(fileUrl(base, workspaceRoot, "secret.txt")));
    const body = yield* Effect.promise(() => response.text());

    assert.equal(response.status, 200);
    assert.equal(body, "tenant secret");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses a read of a cwd that is not inside any known workspace root", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;
    // A directory that exists and is readable, and that the read model has
    // never heard of: the attack the containment check cannot see is that the
    // caller names the root as well as the path.
    const unregisteredRoot = yield* makeWorkspace;

    const response = yield* Effect.promise(() =>
      fetch(fileUrl(base, unregisteredRoot, "secret.txt")),
    );

    assert.equal(response.status, 403);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses an upload from a session with no membership, and writes nothing", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(STRANGER_USER, OTHER_TENANT),
      workspaceRoot,
      memberships: [{ userId: STRANGER_USER, tenantId: OTHER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() =>
      fetch(fileUrl(base, workspaceRoot, "planted.txt"), {
        method: "POST",
        body: "planted",
      }),
    );

    assert.equal(response.status, 403);
    const wrote = yield* Effect.promise(() =>
      stat(nodePath.join(workspaceRoot, "planted.txt")).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(wrote, false);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("writes an upload from a member of the owning tenant", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() =>
      fetch(fileUrl(base, workspaceRoot, "nested/model.glb"), {
        method: "POST",
        body: "glb bytes",
      }),
    );

    assert.equal(response.status, 200);
    const written = yield* Effect.promise(() =>
      readFile(nodePath.join(workspaceRoot, "nested/model.glb"), "utf8"),
    );
    assert.equal(written, "glb bytes");
  }).pipe(Effect.provide(testEnvironment)),
);

/**
 * The over-limit case, proven without sending half a gigabyte: the route must
 * answer from the declared length alone, before it has read the body. A client
 * that declares more than it sends gets its 413 immediately, which is only
 * possible if nothing is waiting on the body to finish arriving.
 */
it.live("answers 413 from the declared length without reading the body", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;
    const port = Number(new URL(base).port);

    const status = yield* Effect.promise(
      () =>
        new Promise<number>((resolve, reject) => {
          const outgoing = httpRequest(
            {
              host: "127.0.0.1",
              port,
              method: "POST",
              path: `/api/workspace/file?cwd=${encodeURIComponent(workspaceRoot)}&path=huge.bin`,
              headers: { "content-length": String(3 * 1024 * 1024 * 1024) },
            },
            (response) => {
              resolve(response.statusCode ?? 0);
              response.resume();
              outgoing.destroy();
            },
          );
          // A connection reset after the server has answered is the expected
          // end of a request whose body was never wanted.
          outgoing.on("error", (error) => {
            if (!outgoing.destroyed) {
              reject(error);
            }
          });
          outgoing.write("only a few bytes");
        }),
    );

    assert.equal(status, 413);
    const wrote = yield* Effect.promise(() =>
      stat(nodePath.join(workspaceRoot, "huge.bin")).then(
        () => true,
        () => false,
      ),
    );
    assert.equal(wrote, false);
  }).pipe(Effect.provide(testEnvironment)),
);
