import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  MembershipId,
  type OrchestrationReadModel,
  ProjectId,
  TenantId,
  ThreadId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { describe, expect, it as vitestIt } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { createAttachmentId } from "./attachmentStore.ts";
import { AuthError, ServerAuth, type AuthenticatedSession } from "./auth/Services/ServerAuth.ts";
import { ServerConfig } from "./config.ts";
import {
  attachmentsRouteLayer,
  isLoopbackHostname,
  projectFaviconRouteLayer,
  resolveDevRedirectUrl,
} from "./http.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { LocalAuthAccountRepository } from "./persistence/Services/LocalAuthAccounts.ts";
import { TenancyRepository } from "./persistence/Services/Tenancy.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";

/**
 * The two file-serving routes in `http.ts`, asked the question that being
 * signed in does not answer: whose bytes are these.
 *
 * `/attachments/*` resolves an id straight to a path under one flat,
 * process-wide `attachmentsDir`; `/api/project-favicon` reads a file out of a
 * directory the caller names. Neither is a path traversal — the attachment id
 * is well-formed and the favicon `cwd` is a real directory — which is exactly
 * why a containment check never caught them. Identity is stubbed here, because
 * who the caller is belongs to `ServerAuth`; project ownership and tenant
 * membership are the real data, because that is what the decision is made from.
 */

const OWNER_TENANT = TenantId.make("tenant-owner");
const OTHER_TENANT = TenantId.make("tenant-other");
const MEMBER_USER = UserId.make("user-member");
const STRANGER_USER = UserId.make("user-stranger");
const OWNING_THREAD = ThreadId.make("thread-owned-01");

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

/** One project owned by `OWNER_TENANT`, with one thread living inside it. */
const makeReadModel = (workspaceRoot: string): OrchestrationReadModel => ({
  snapshotSequence: 0,
  updatedAt: NOW,
  threads: [
    {
      id: OWNING_THREAD,
      projectId: ProjectId.make("project-owned"),
      title: "Owned Thread",
      modelSelection: { provider: "codex", model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
      session: null,
    },
  ],
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
 * The test config, published beyond loopback and pointed at a temp
 * `attachmentsDir`.
 *
 * `publishedBeyondLoopback` is the whole difference between a laptop and a
 * shared host: left false, every session here would own the machine and the
 * permission chain would correctly wave it through, testing nothing.
 */
const makeServerConfigLayer = (attachmentsDir: string) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return { ...config, publishedBeyondLoopback: true, attachmentsDir };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-http-config-" })));

const routes = Layer.mergeAll(attachmentsRouteLayer, projectFaviconRouteLayer);

const buildAppUnderTest = (options: {
  readonly session: AuthenticatedSession;
  readonly workspaceRoot: string;
  readonly attachmentsDir: string;
  readonly faviconPath: string | null;
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
      Layer.provide(makeServerConfigLayer(options.attachmentsDir)),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeReadModel(options.workspaceRoot)),
        }),
      ),
      Layer.provide(makeTenancyLayer(options.memberships)),
      Layer.provide(localAuthAccountsLayer),
      Layer.provide(
        Layer.mock(ProjectFaviconResolver)({
          resolvePath: () => Effect.succeed(options.faviconPath),
        }),
      ),
    ),
  );

const testEnvironment = NodeHttpServer.layerTest;

const serverUrl = Effect.gen(function* () {
  const server = yield* HttpServer.HttpServer;
  const address = server.address as HttpServer.TcpAddress;
  return `http://127.0.0.1:${address.port}`;
});

/**
 * One tenant's pasted screenshot, sitting in the flat directory every tenant's
 * attachments share, under an id built the way the real one is built.
 */
const seedAttachment = Effect.promise(async () => {
  const attachmentsDir = await mkdtemp(nodePath.join(os.tmpdir(), "t3-http-attachments-"));
  const attachmentId = createAttachmentId(OWNING_THREAD);
  if (attachmentId === null) {
    throw new Error("attachment id could not be built for the seeded thread");
  }
  await writeFile(nodePath.join(attachmentsDir, `${attachmentId}.png`), "screenshot bytes", "utf8");
  return { attachmentsDir, attachmentId };
});

const makeWorkspace = Effect.promise(async () => {
  const root = await mkdtemp(nodePath.join(os.tmpdir(), "t3-http-workspace-"));
  await writeFile(nodePath.join(root, "favicon.ico"), "icon bytes", "utf8");
  return root;
});

it.live("refuses another tenant's attachment to a signed-in stranger", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir, attachmentId } = yield* seedAttachment;
    yield* buildAppUnderTest({
      session: makeSession(STRANGER_USER, OTHER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: null,
      memberships: [{ userId: STRANGER_USER, tenantId: OTHER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() => fetch(`${base}/attachments/${attachmentId}`));

    assert.equal(response.status, 404);
    const body = yield* Effect.promise(() => response.text());
    assert.notInclude(body, "screenshot bytes");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses the same attachment asked for by its file name", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir, attachmentId } = yield* seedAttachment;
    yield* buildAppUnderTest({
      session: makeSession(STRANGER_USER, OTHER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: null,
      memberships: [{ userId: STRANGER_USER, tenantId: OTHER_TENANT }],
    });
    const base = yield* serverUrl;

    // The route has two lookup shapes and only one of them is an id; the
    // relative-path form reaches the same bytes and has to be authorized the
    // same way.
    const response = yield* Effect.promise(() => fetch(`${base}/attachments/${attachmentId}.png`));

    assert.equal(response.status, 404);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("serves the attachment to a member of the tenant that owns its thread", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir, attachmentId } = yield* seedAttachment;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: null,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() => fetch(`${base}/attachments/${attachmentId}`));
    const body = yield* Effect.promise(() => response.text());

    assert.equal(response.status, 200);
    assert.equal(body, "screenshot bytes");
    // A tenant's image must not be cacheable by anything shared.
    assert.include(response.headers.get("cache-control") ?? "", "private");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses an attachment id that belongs to no known thread", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir } = yield* seedAttachment;
    const orphanId = createAttachmentId(ThreadId.make("thread-never-seen"));
    if (orphanId === null) {
      throw new Error("attachment id could not be built");
    }
    yield* Effect.promise(() =>
      writeFile(nodePath.join(attachmentsDir, `${orphanId}.png`), "orphan bytes", "utf8"),
    );
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: null,
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() => fetch(`${base}/attachments/${orphanId}`));

    // Fail closed: an id nothing claims cannot be compared against anybody, so
    // on a published host it is served to nobody.
    assert.equal(response.status, 404);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses a favicon read of a directory the session has no membership in", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir } = yield* seedAttachment;
    yield* buildAppUnderTest({
      session: makeSession(STRANGER_USER, OTHER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: nodePath.join(workspaceRoot, "favicon.ico"),
      memberships: [{ userId: STRANGER_USER, tenantId: OTHER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() =>
      fetch(`${base}/api/project-favicon?cwd=${encodeURIComponent(workspaceRoot)}`),
    );
    const body = yield* Effect.promise(() => response.text());

    assert.equal(response.status, 403);
    assert.notInclude(body, "icon bytes");
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("refuses a favicon read of a directory no project claims", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir } = yield* seedAttachment;
    // A real, readable directory the read model has never heard of: `cwd` is
    // the caller's to choose, which is the whole of the attack.
    const unregisteredRoot = yield* makeWorkspace;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: nodePath.join(unregisteredRoot, "favicon.ico"),
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() =>
      fetch(`${base}/api/project-favicon?cwd=${encodeURIComponent(unregisteredRoot)}`),
    );

    assert.equal(response.status, 403);
  }).pipe(Effect.provide(testEnvironment)),
);

it.live("serves a favicon from a project root the session may read", () =>
  Effect.gen(function* () {
    const workspaceRoot = yield* makeWorkspace;
    const { attachmentsDir } = yield* seedAttachment;
    yield* buildAppUnderTest({
      session: makeSession(MEMBER_USER, OWNER_TENANT),
      workspaceRoot,
      attachmentsDir,
      faviconPath: nodePath.join(workspaceRoot, "favicon.ico"),
      memberships: [{ userId: MEMBER_USER, tenantId: OWNER_TENANT }],
    });
    const base = yield* serverUrl;

    const response = yield* Effect.promise(() =>
      fetch(`${base}/api/project-favicon?cwd=${encodeURIComponent(workspaceRoot)}`),
    );
    const body = yield* Effect.promise(() => response.text());

    assert.equal(response.status, 200);
    assert.equal(body, "icon bytes");
  }).pipe(Effect.provide(testEnvironment)),
);

/** The dev-routing helpers this module has always carried, unchanged. */
describe("http dev routing", () => {
  vitestIt("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  vitestIt("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  vitestIt("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});
