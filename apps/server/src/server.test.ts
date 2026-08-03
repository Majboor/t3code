import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Crypto from "node:crypto";

import { DEFAULT_PUBLIC_ACCESS_LIMITS } from "@t3tools/shared/tenancy";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  GitCommandError,
  KeybindingRule,
  MembershipId,
  MessageId,
  OpenError,
  type OrchestrationThreadShell,
  TerminalNotRunningError,
  type OrchestrationCommand,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  OrganizationId,
  ProviderAccountId,
  ProviderSessionId,
  ProjectId,
  ResolvedKeybindingRule,
  TenantId,
  TenantRuntimeId,
  type TerminalOpenInput,
  type TerminalWriteInput,
  type TenantMembership,
  ThreadId,
  TurnId,
  UserId,
  WorkspaceId,
  WS_METHODS,
  WsRpcGroup,
  EditorId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { assertFailure, assertInclude, assertTrue } from "@effect/vitest/utils";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Stream,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpRouter,
  HttpServer,
} from "effect/unstable/http";
import { OtlpSerialization, OtlpTracer } from "effect/unstable/observability";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";
import { vi } from "vitest";

import type { ServerConfigShape } from "./config.ts";
import { deriveServerPaths, ServerConfig } from "./config.ts";
import { makeRoutesLayer } from "./server.ts";
import { resolveAttachmentRelativePath } from "./attachmentPaths.ts";
import {
  CheckpointDiffQuery,
  type CheckpointDiffQueryShape,
} from "./checkpointing/Services/CheckpointDiffQuery.ts";
import { GitCore, type GitCoreShape } from "./git/Services/GitCore.ts";
import { GitManager, type GitManagerShape } from "./git/Services/GitManager.ts";
import { GitStatusBroadcasterLive } from "./git/Layers/GitStatusBroadcaster.ts";
import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "./git/Services/GitStatusBroadcaster.ts";
import { Keybindings, type KeybindingsShape } from "./keybindings.ts";
import { Open, type OpenShape } from "./open.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationListenerCallbackError } from "./orchestration/Errors.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "./provider/Services/ProviderRegistry.ts";
import { TenancyRepository, type TenancyRepositoryShape } from "./persistence/Services/Tenancy.ts";
import { ServerLifecycleEvents, type ServerLifecycleEventsShape } from "./serverLifecycleEvents.ts";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "./serverRuntimeStartup.ts";
import { ServerSettingsService, type ServerSettingsShape } from "./serverSettings.ts";
import { TerminalManager, type TerminalManagerShape } from "./terminal/Services/Manager.ts";
import {
  BrowserTraceCollector,
  type BrowserTraceCollectorShape,
} from "./observability/Services/BrowserTraceCollector.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { CollaborationServiceLive } from "./collaboration/Layers/CollaborationService.ts";
import { OrganizationServiceLive } from "./organizations/Layers/OrganizationService.ts";
import { TenancyRepositoryLive } from "./persistence/Layers/Tenancy.ts";
import { ProjectionThreadPreferenceRepositoryLive } from "./persistence/Layers/ProjectionThreadPreferences.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerShape,
} from "./project/Services/ProjectSetupScriptRunner.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolverShape,
} from "./project/Services/RepositoryIdentityResolver.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "./environment/Services/ServerEnvironment.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import type { AuthenticatedSession } from "./auth/Services/ServerAuth.ts";
import type { SupabaseJwtClaims, SupabaseJwks } from "./auth/supabaseJwt.ts";
import { __testWebSocketConnectionLimits } from "./ws.ts";

const defaultProjectId = ProjectId.make("project-default");
const defaultThreadId = ThreadId.make("thread-default");
const defaultDesktopBootstrapToken = "test-desktop-bootstrap-token";
const supabaseProjectUrl = "https://project-ref.supabase.co";
const supabaseIssuer = `${supabaseProjectUrl}/auth/v1`;
const supabaseSubject = "4d7ecde3-b641-4be2-8d62-0bf345fbfd1d";
const supabaseUserId = UserId.make(`supabase:${supabaseSubject}`);
const supabaseJwtExpiresInSeconds = 300;
const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;
const testEnvironmentDescriptor = {
  environmentId: EnvironmentId.make("environment-test"),
  label: "Test environment",
  platform: {
    os: "darwin" as const,
    arch: "arm64" as const,
  },
  serverVersion: "0.0.0-test",
  capabilities: {
    repositoryIdentity: true,
  },
};
const makeDefaultOrchestrationReadModel = () => {
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    updatedAt: now,
    projects: [
      {
        id: defaultProjectId,
        title: "Default Project",
        workspaceRoot: "/tmp/default-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: ProjectId.make("project-test-repo"),
        title: "Test Repo",
        workspaceRoot: "/tmp/repo",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
      {
        id: ProjectId.make("project-test-terminal"),
        title: "Test Terminal Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: [
      {
        id: defaultThreadId,
        projectId: defaultProjectId,
        title: "Default Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-test-terminal"),
        title: "Terminal Thread",
        modelSelection: defaultModelSelection,
        interactionMode: "default" as const,
        runtimeMode: "full-access" as const,
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        latestTurn: null,
        messages: [],
        session: null,
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
      },
    ],
  };
};

const makeDefaultOrchestrationThreadShell = (
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => {
  const now = new Date().toISOString();
  return {
    id: defaultThreadId,
    projectId: defaultProjectId,
    title: "Default Thread",
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
};

const makeReadModelWithWorkspaceRoot = (workspaceRoot: string) => {
  const readModel = makeDefaultOrchestrationReadModel();
  return {
    ...readModel,
    projects: [
      ...readModel.projects,
      {
        id: ProjectId.make(`project-${crypto.randomUUID()}`),
        title: "Registered Test Workspace",
        workspaceRoot,
        defaultModelSelection,
        scripts: [],
        createdAt: readModel.updatedAt,
        updatedAt: readModel.updatedAt,
        deletedAt: null,
      },
    ],
  };
};

const browserOtlpTracingLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  OtlpSerialization.layerJson,
  Layer.succeed(HttpClient.TracerDisabledWhen, () => true),
);

const authTestLayer = ServerAuthLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(ServerSecretStoreLive),
);

const tenancyRepositoryTestLayer = TenancyRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);

const collaborationTestLayer = CollaborationServiceLive.pipe(
  Layer.provide(tenancyRepositoryTestLayer),
);

const organizationTestLayer = OrganizationServiceLive.pipe(
  Layer.provide(tenancyRepositoryTestLayer),
);

const threadPreferenceTestLayer = ProjectionThreadPreferenceRepositoryLive.pipe(
  Layer.provide(SqlitePersistenceMemory),
);

const makeBrowserOtlpPayload = (spanName: string) =>
  Effect.gen(function* () {
    const collector = yield* Effect.acquireRelease(
      Effect.promise(async () => {
        const NodeHttp = await import("node:http");

        return await new Promise<{
          readonly close: () => Promise<void>;
          readonly firstRequest: Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>;
          readonly url: string;
        }>((resolve, reject) => {
          let resolveFirstRequest:
            | ((request: { readonly body: string; readonly contentType: string | null }) => void)
            | undefined;
          const firstRequest = new Promise<{
            readonly body: string;
            readonly contentType: string | null;
          }>((resolveRequest) => {
            resolveFirstRequest = resolveRequest;
          });

          const server = NodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", (chunk) => {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            });
            request.on("end", () => {
              resolveFirstRequest?.({
                body: Buffer.concat(chunks).toString("utf8"),
                contentType: request.headers["content-type"] ?? null,
              });
              resolveFirstRequest = undefined;
              response.statusCode = 204;
              response.end();
            });
          });

          server.on("error", reject);
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
              reject(new Error("Expected TCP collector address"));
              return;
            }

            resolve({
              url: `http://127.0.0.1:${address.port}/v1/traces`,
              firstRequest,
              close: () =>
                new Promise<void>((resolveClose, rejectClose) => {
                  server.close((error) => {
                    if (error) {
                      rejectClose(error);
                      return;
                    }
                    resolveClose();
                  });
                }),
            });
          });
        });
      }),
      ({ close }) => Effect.promise(close),
    );

    const runtime = ManagedRuntime.make(
      OtlpTracer.layer({
        url: collector.url,
        exportInterval: "10 millis",
        resource: {
          serviceName: "t3-web",
          attributes: {
            "service.runtime": "t3-web",
            "service.mode": "browser",
            "service.version": "test",
          },
        },
      }).pipe(Layer.provide(browserOtlpTracingLayer)),
    );

    try {
      yield* Effect.promise(() => runtime.runPromise(Effect.void.pipe(Effect.withSpan(spanName))));
    } finally {
      yield* Effect.promise(() => runtime.dispose());
    }

    const request = yield* Effect.promise(() =>
      Promise.race([
        collector.firstRequest,
        new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for OTLP trace export")), 1_000);
        }),
      ]),
    );

    return JSON.parse(request.body) as OtlpTracer.TraceData;
  });

const buildAppUnderTest = (options?: {
  config?: Partial<ServerConfigShape>;
  layers?: {
    keybindings?: Partial<KeybindingsShape>;
    providerRegistry?: Partial<ProviderRegistryShape>;
    serverSettings?: Partial<ServerSettingsShape>;
    open?: Partial<OpenShape>;
    gitCore?: Partial<GitCoreShape>;
    gitManager?: Partial<GitManagerShape>;
    gitStatusBroadcaster?: Partial<GitStatusBroadcasterShape>;
    projectSetupScriptRunner?: Partial<ProjectSetupScriptRunnerShape>;
    terminalManager?: Partial<TerminalManagerShape>;
    orchestrationEngine?: Partial<OrchestrationEngineShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQueryShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQueryShape>;
    browserTraceCollector?: Partial<BrowserTraceCollectorShape>;
    serverLifecycleEvents?: Partial<ServerLifecycleEventsShape>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartupShape>;
    serverEnvironment?: Partial<ServerEnvironmentShape>;
    repositoryIdentityResolver?: Partial<RepositoryIdentityResolverShape>;
  };
  seedTenancy?: (repository: TenancyRepositoryShape) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    const config: ServerConfigShape = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "t3-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      unsafeNoAuth: false,
      basicAuthUsername: undefined,
      basicAuthPassword: undefined,
      basicAuthRealm: "T3 Code",
      supabaseProjectUrl: undefined,
      supabaseAnonKey: undefined,
      supabaseJwtAudience: undefined,
      supabaseServiceRoleSecretName: undefined,
      localPasswordAuth: false,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      ...options?.config,
    };
    const layerConfig = Layer.succeed(ServerConfig, config);
    const gitCoreLayer = Layer.mock(GitCore)({
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      ...options?.layers?.gitCore,
    });
    const gitManagerLayer = Layer.mock(GitManager)({
      ...options?.layers?.gitManager,
    });
    const workspaceEntriesLayer = WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provideMerge(gitCoreLayer),
    );
    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePathsLive,
      workspaceEntriesLayer,
      WorkspaceFileSystemLive.pipe(
        Layer.provide(WorkspacePathsLive),
        Layer.provide(workspaceEntriesLayer),
      ),
      ProjectFaviconResolverLive,
    );
    const gitStatusBroadcasterLayer = options?.layers?.gitStatusBroadcaster
      ? Layer.mock(GitStatusBroadcaster)({
          ...options.layers.gitStatusBroadcaster,
        })
      : GitStatusBroadcasterLive.pipe(Layer.provide(gitManagerLayer));
    const seedTenancyLayer = Layer.effectDiscard(
      options?.seedTenancy
        ? Effect.service(TenancyRepository).pipe(Effect.flatMap(options.seedTenancy))
        : Effect.void,
    );

    const servedRoutesLayer = HttpRouter.serve(makeRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(
        Layer.mock(Keybindings)({
          loadConfigState: Effect.succeed({
            keybindings: [],
            issues: [],
          }),
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mock(ProviderRegistry)({
          getProviders: Effect.succeed([]),
          refresh: () => Effect.succeed([]),
          streamChanges: Stream.empty,
          ...options?.layers?.providerRegistry,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mock(Open)({
          ...options?.layers?.open,
        }),
      ),
      Layer.provide(gitCoreLayer),
      Layer.provide(gitManagerLayer),
      Layer.provideMerge(gitStatusBroadcasterLayer),
      Layer.provide(
        Layer.mock(ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" as const }),
          ...options?.layers?.projectSetupScriptRunner,
        }),
      ),
      Layer.provide(
        Layer.mock(TerminalManager)({
          ...options?.layers?.terminalManager,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.succeed({ sequence: 0 }),
          streamDomainEvents: Stream.empty,
          ...options?.layers?.orchestrationEngine,
        }),
      ),
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [],
              threads: [],
              updatedAt: new Date(0).toISOString(),
            }),
          getProjectShellById: () => Effect.succeed(Option.none()),
          getThreadShellById: () => Effect.succeed(Option.none()),
          getThreadDetailById: () => Effect.succeed(Option.none()),
          getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
          ...options?.layers?.projectionSnapshotQuery,
        }),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(
        Layer.mock(BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...(event as any), sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provideMerge(authTestLayer),
      Layer.provideMerge(seedTenancyLayer),
      Layer.provideMerge(tenancyRepositoryTestLayer),
      Layer.provideMerge(threadPreferenceTestLayer),
      Layer.provideMerge(collaborationTestLayer),
      Layer.provideMerge(organizationTestLayer),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(appLayer);
    return config;
  });

const parseSessionCookieFromWsUrl = (
  wsUrl: string,
): { readonly cookie: string | null; readonly url: string } => {
  const next = new URL(wsUrl);
  const cookie = next.hash.startsWith("#cookie=")
    ? decodeURIComponent(next.hash.slice("#cookie=".length))
    : null;
  next.hash = "";
  return {
    cookie,
    url: next.toString(),
  };
};

const wsRpcProtocolLayer = (
  wsUrl: string,
  options?: {
    readonly headers?: Record<string, string>;
  },
) => {
  const { cookie, url } = parseSessionCookieFromWsUrl(wsUrl);
  const headers = {
    ...(cookie ? { cookie } : {}),
    ...options?.headers,
  };
  const webSocketConstructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    (socketUrl, protocols) =>
      new NodeSocket.NodeWS.WebSocket(
        socketUrl,
        protocols,
        Object.keys(headers).length > 0 ? { headers } : undefined,
      ) as unknown as globalThis.WebSocket,
  );

  return RpcClient.layerProtocolSocket().pipe(
    Layer.provide(Socket.layerWebSocket(url).pipe(Layer.provide(webSocketConstructorLayer))),
    Layer.provide(RpcSerialization.layerJson),
  );
};

const makeWsRpcClient = RpcClient.make(WsRpcGroup);
type WsRpcClient =
  typeof makeWsRpcClient extends Effect.Effect<infer Client, any, any> ? Client : never;

const withWsRpcClient = <A, E, R>(
  wsUrl: string,
  f: (client: WsRpcClient) => Effect.Effect<A, E, R>,
  options?: {
    readonly headers?: Record<string, string>;
  },
) => makeWsRpcClient.pipe(Effect.flatMap(f), Effect.provide(wsRpcProtocolLayer(wsUrl, options)));

const appendSessionCookieToWsUrl = (url: string, sessionCookieHeader: string) => {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const next = new URL(url, "http://localhost");
  next.hash = `cookie=${encodeURIComponent(sessionCookieHeader)}`;
  return isAbsoluteUrl ? next.toString() : `${next.pathname}${next.search}${next.hash}`;
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signSupabaseJwt(input: {
  readonly keyPair: Crypto.KeyPairKeyObjectResult;
  readonly kid: string;
  readonly claims?: Partial<SupabaseJwtClaims>;
}): string {
  const signingInput = `${base64UrlJson({
    alg: "RS256",
    typ: "JWT",
    kid: input.kid,
  })}.${base64UrlJson({
    sub: supabaseSubject,
    iss: supabaseIssuer,
    aud: "authenticated",
    exp: Math.floor(Date.now() / 1000) + supabaseJwtExpiresInSeconds,
    email: "member@example.test",
    role: "authenticated",
    app_metadata: {
      provider: "email",
    },
    user_metadata: {
      full_name: "Supabase Member",
    },
    ...input.claims,
  })}`;
  const signature = Crypto.createSign("RSA-SHA256")
    .update(signingInput)
    .end()
    .sign(input.keyPair.privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

function makeSignedSupabaseFixture(claims?: Partial<SupabaseJwtClaims>): {
  readonly jwt: string;
  readonly jwks: SupabaseJwks;
} {
  const keyPair = Crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "server-e2e-supabase-key";
  return {
    jwt: signSupabaseJwt({ keyPair, kid, ...(claims ? { claims } : {}) }),
    jwks: {
      keys: [
        {
          ...keyPair.publicKey.export({ format: "jwk" }),
          kid,
          alg: "RS256",
          use: "sig",
        },
      ],
    },
  };
}

function makeSupabaseMembership(input: {
  readonly tenantId: TenantId;
  readonly userId?: UserId;
  readonly organizationId?: OrganizationId | null;
  readonly roles?: TenantMembership["roles"];
}): TenantMembership {
  return {
    id: MembershipId.make(`membership-supabase-${crypto.randomUUID()}`),
    tenantId: input.tenantId,
    userId: input.userId ?? supabaseUserId,
    organizationId: input.organizationId ?? null,
    roles: input.roles ?? ["developer"],
    createdAt: new Date().toISOString(),
    disabledAt: null,
  };
}

function mockSupabaseJwksFetch(jwks: SupabaseJwks) {
  const originalFetch = globalThis.fetch;
  return vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === `${supabaseProjectUrl}/auth/v1/.well-known/jwks.json`) {
      return Promise.resolve(
        new Response(JSON.stringify(jwks), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
      );
    }
    return originalFetch(input, init);
  });
}

const getHttpServerUrl = (pathname = "") =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    return `http://127.0.0.1:${address.port}${pathname}`;
  });

const bootstrapBrowserSession = (
  credential = defaultDesktopBootstrapToken,
  options?: {
    readonly headers?: Record<string, string>;
  },
) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...options?.headers,
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
    };
    return {
      response,
      body,
      cookie: response.headers.get("set-cookie"),
    };
  });

const bootstrapBearerSession = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const bootstrapUrl = yield* getHttpServerUrl("/api/auth/bootstrap/bearer");
    const response = yield* Effect.promise(() =>
      fetch(bootstrapUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          credential,
        }),
      }),
    );
    const body = (yield* Effect.promise(() => response.json())) as {
      readonly authenticated: boolean;
      readonly sessionMethod: string;
      readonly expiresAt: string;
      readonly sessionToken?: string;
      readonly error?: string;
    };
    return {
      response,
      body,
    };
  });

const getAuthenticatedSessionCookieHeader = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, cookie } = yield* bootstrapBrowserSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bootstrap session response to succeed, got ${response.status}`),
      );
    }

    if (!cookie) {
      return yield* Effect.fail(new Error("Expected bootstrap session response to set a cookie."));
    }

    return cookie.split(";")[0] ?? cookie;
  });

// Creates a durable local-account browser session via password signup.
// Requires buildAppUnderTest({ config: { localPasswordAuth: true } }).
// Unlike anonymous paired-client sessions, these sessions carry a userId and
// may accept collaboration invites.
const signUpLocalMemberSessionCookie = (input: {
  readonly email: string;
  readonly displayName: string;
}) =>
  Effect.gen(function* () {
    const passwordUrl = yield* getHttpServerUrl("/api/auth/password");
    const response = yield* Effect.promise(() =>
      fetch(passwordUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: input.email,
          password: "local-member-password-123",
          mode: "signup",
          displayName: input.displayName,
        }),
      }),
    );
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected local password signup to succeed, got ${response.status}`),
      );
    }
    const cookie = response.headers.get("set-cookie");
    if (!cookie) {
      return yield* Effect.fail(new Error("Expected local password signup to set a cookie."));
    }
    return cookie.split(";")[0] ?? cookie;
  });

const getAuthenticatedBearerSessionToken = (credential = defaultDesktopBootstrapToken) =>
  Effect.gen(function* () {
    const { response, body } = yield* bootstrapBearerSession(credential);
    if (!response.ok) {
      return yield* Effect.fail(
        new Error(`Expected bearer bootstrap response to succeed, got ${response.status}`),
      );
    }

    if (!body.sessionToken) {
      return yield* Effect.fail(
        new Error("Expected bearer bootstrap response to include a session token."),
      );
    }

    return body.sessionToken;
  });

const extractSessionTokenFromSetCookie = (cookieHeader: string): string => {
  const [nameValue] = cookieHeader.split(";", 1);
  const token = nameValue?.split("=", 2)[1];
  if (!token) {
    throw new Error("Expected session cookie header to contain a token value.");
  }
  return token;
};

const splitHeaderTokens = (value: string | null) =>
  (value ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .toSorted();

const getWsServerUrl = (
  pathname = "",
  options?: { authenticated?: boolean; credential?: string },
) =>
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    const address = server.address as HttpServer.TcpAddress;
    const baseUrl = `ws://127.0.0.1:${address.port}${pathname}`;
    if (options?.authenticated === false) {
      return baseUrl;
    }
    return appendSessionCookieToWsUrl(
      baseUrl,
      yield* getAuthenticatedSessionCookieHeader(options?.credential),
    );
  });

const withCleanBrowserContext = async <A>(
  browser: Awaited<ReturnType<typeof import("playwright").chromium.launch>>,
  appUrl: string,
  sessionCookieHeader: string | null,
  run: (page: import("playwright").Page) => Promise<A>,
): Promise<A> => {
  const context = await browser.newContext();
  try {
    await context.clearCookies();
    const page = await context.newPage();
    if (sessionCookieHeader) {
      const [cookieName, cookieValue] = sessionCookieHeader.split("=", 2);
      if (!cookieName || !cookieValue) {
        throw new Error("Expected session cookie header to contain a name and value.");
      }
      const origin = new URL(appUrl);
      await context.addCookies([
        {
          name: cookieName,
          value: cookieValue,
          domain: origin.hostname,
          path: "/",
          httpOnly: true,
          sameSite: "Lax",
          secure: origin.protocol === "https:",
        },
      ]);
    }
    return await run(page);
  } finally {
    await Promise.race([
      context.close(),
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
};

const reserveTcpPort = async (): Promise<number> => {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Expected reserved TCP port address.")));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
};

const restoreProcessEnvValue = (name: string, value: string | undefined) => {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
};

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("serves static index content for GET / when staticDir is configured", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const staticDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-static-" });
      const indexPath = path.join(staticDir, "index.html");
      yield* fileSystem.writeFileString(indexPath, "<html>router-static-ok</html>");

      yield* buildAppUnderTest({ config: { staticDir } });

      const response = yield* HttpClient.get("/");
      assert.equal(response.status, 200);
      assert.include(yield* response.text, "router-static-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("redirects to dev URL when configured", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const url = yield* getHttpServerUrl("/foo/bar?token=test-token");
      const response = yield* Effect.promise(() => fetch(url, { redirect: "manual" }));

      assert.equal(response.status, 302);
      assert.equal(
        response.headers.get("location"),
        "http://127.0.0.1:5173/foo/bar?token=test-token",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves project favicon requests before the dev URL redirect", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-",
      });
      yield* fileSystem.writeFileString(
        path.join(projectDir, "favicon.svg"),
        "<svg>router-project-favicon</svg>",
      );

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "<svg>router-project-favicon</svg>");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the fallback project favicon when no icon exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const projectDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-router-project-favicon-fallback-",
      });

      yield* buildAppUnderTest({
        config: { devUrl: new URL("http://127.0.0.1:5173") },
      });

      const response = yield* HttpClient.get(
        `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}`,
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );

      assert.equal(response.status, 200);
      assert.include(yield* response.text, 'data-fallback="project-favicon"');
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves the public environment descriptor without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/.well-known/t3/environment");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() =>
        response.json(),
      )) as typeof testEnvironmentDescriptor;

      assert.equal(response.status, 200);
      assert.deepEqual(body, testEnvironmentDescriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("reports unauthenticated session state without requiring auth", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly authenticated: boolean;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
          readonly sessionMethods: ReadonlyArray<string>;
          readonly sessionCookieName: string;
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.equal(body.auth.policy, "desktop-managed-local");
      assert.deepEqual(body.auth.bootstrapMethods, ["desktop-bootstrap"]);
      assert.deepEqual(body.auth.sessionMethods, [
        "browser-session-cookie",
        "bearer-session-token",
      ]);
      assert.isTrue(body.auth.sessionCookieName.startsWith("t3_session_"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("advertises public Supabase auth config without service-role secrets", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseAnonKey: "anon-public-key",
          supabaseJwtAudience: "authenticated",
          supabaseServiceRoleSecretName: "supabase/service-role",
        },
      });

      const url = yield* getHttpServerUrl("/api/auth/session");
      const response = yield* Effect.promise(() => fetch(url));
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly authenticated: boolean;
        readonly auth: {
          readonly supabase?: {
            readonly projectUrl: string;
            readonly anonKey: string;
            readonly audience?: string;
          };
        };
      };

      assert.equal(response.status, 200);
      assert.equal(body.authenticated, false);
      assert.deepEqual(body.auth.supabase, {
        projectUrl: `${supabaseProjectUrl}/`,
        anonKey: "anon-public-key",
        audience: "authenticated",
      });
      assert.notInclude(JSON.stringify(body), "service-role");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves authenticated profile and onboarding endpoints to a browser user", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const cookie = yield* getAuthenticatedSessionCookieHeader();
      const profileUrl = yield* getHttpServerUrl("/api/auth/profile");
      const profileResponse = yield* Effect.promise(() =>
        fetch(profileUrl, {
          headers: { cookie },
        }),
      );
      const profile = (yield* Effect.promise(() => profileResponse.json())) as {
        readonly userId: string;
        readonly displayName: string;
        readonly role: string;
        readonly sessionMethod: string;
        readonly sessionId: string;
        readonly tenantStatus: string;
      };

      assert.equal(profileResponse.status, 200);
      assert.isTrue(profile.userId.startsWith("auth:"));
      assert.equal(profile.role, "owner");
      assert.equal(profile.sessionMethod, "browser-session-cookie");
      assert.equal(profile.tenantStatus, "none");
      assert.isTrue(profile.sessionId.length > 0);
      assert.isTrue(profile.displayName.length > 0);

      const onboardingUrl = yield* getHttpServerUrl("/api/auth/onboarding");
      const onboardingResponse = yield* Effect.promise(() =>
        fetch(onboardingUrl, {
          headers: { cookie },
        }),
      );
      const onboarding = (yield* Effect.promise(() => onboardingResponse.json())) as {
        readonly authenticated: boolean;
        readonly nextStep: string;
        readonly profile: typeof profile;
      };

      assert.equal(onboardingResponse.status, 200);
      assert.equal(onboarding.authenticated, true);
      assert.equal(onboarding.nextStep, "create-workspace");
      assert.equal(onboarding.profile.sessionId, profile.sessionId);
      assert.equal(onboarding.profile.tenantStatus, "none");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("provisions personal tenants for new Supabase users in session and onboarding", () =>
    Effect.gen(function* () {
      const fixture = makeSignedSupabaseFixture();
      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const headers = {
          authorization: `Bearer ${fixture.jwt}`,
        };
        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* Effect.promise(() =>
          fetch(sessionUrl, {
            headers,
          }),
        );
        const session = (yield* Effect.promise(() => sessionResponse.json())) as {
          readonly authenticated: boolean;
          readonly role: string;
          readonly sessionMethod: string;
          readonly tenantStatus?: string;
          readonly tenantSession?: unknown;
        };

        assert.equal(sessionResponse.status, 200);
        assert.equal(session.authenticated, true);
        assert.equal(session.role, "client");
        assert.equal(session.sessionMethod, "bearer-session-token");
        assert.equal(session.tenantStatus, "active");
        assert.isDefined(session.tenantSession);

        const profileUrl = yield* getHttpServerUrl("/api/auth/profile");
        const profileResponse = yield* Effect.promise(() =>
          fetch(profileUrl, {
            headers,
          }),
        );
        const profile = (yield* Effect.promise(() => profileResponse.json())) as {
          readonly userId: string;
          readonly displayName: string;
          readonly tenantStatus: string;
          readonly tenantSession?: unknown;
        };

        assert.equal(profileResponse.status, 200);
        assert.equal(profile.userId, supabaseUserId);
        assert.equal(profile.displayName, "Supabase Member");
        assert.equal(profile.tenantStatus, "active");
        assert.isDefined(profile.tenantSession);

        const onboardingUrl = yield* getHttpServerUrl("/api/auth/onboarding");
        const onboardingResponse = yield* Effect.promise(() =>
          fetch(onboardingUrl, {
            headers,
          }),
        );
        const onboarding = (yield* Effect.promise(() => onboardingResponse.json())) as {
          readonly authenticated: boolean;
          readonly nextStep: string;
          readonly profile: typeof profile;
        };

        assert.equal(onboardingResponse.status, 200);
        assert.equal(onboarding.authenticated, true);
        assert.equal(onboarding.nextStep, "paired");
        assert.equal(onboarding.profile.tenantStatus, "active");
        assert.equal(onboarding.profile.userId, supabaseUserId);
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("auto-authenticates loopback web sessions on first load", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          mode: "web",
          host: "127.0.0.1",
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() => fetch(sessionUrl));
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly role?: string;
        readonly sessionMethod?: string;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
        };
      };
      const cookie = sessionResponse.headers.get("set-cookie");

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.role, "owner");
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
      assert.equal(sessionBody.auth.policy, "loopback-browser");
      assert.deepEqual(sessionBody.auth.bootstrapMethods, ["one-time-token"]);
      assert.isDefined(cookie);

      const pairingUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const pairingResponse = yield* Effect.promise(() =>
        fetch(pairingUrl, {
          method: "POST",
          headers: {
            cookie: cookie?.split(";")[0] ?? "",
          },
        }),
      );
      const pairingBody = (yield* Effect.promise(() => pairingResponse.json())) as {
        readonly credential: string;
      };

      assert.equal(pairingResponse.status, 200);
      assert.equal(typeof pairingBody.credential, "string");
      assert.isTrue(pairingBody.credential.length > 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("auto-authenticates remote sessions when unsafe no-auth is enabled", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          mode: "web",
          host: "0.0.0.0",
          unsafeNoAuth: true,
          basicAuthUsername: undefined,
          basicAuthPassword: undefined,
          basicAuthRealm: "T3 Code",
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() => fetch(sessionUrl));
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly role?: string;
        readonly sessionMethod?: string;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
        };
      };
      const cookie = sessionResponse.headers.get("set-cookie");

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.role, "owner");
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
      assert.equal(sessionBody.auth.policy, "unsafe-no-auth");
      assert.deepEqual(sessionBody.auth.bootstrapMethods, []);
      assert.isDefined(cookie);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("requires Basic Auth before unsafe no-auth session bootstrap", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          mode: "web",
          host: "0.0.0.0",
          unsafeNoAuth: false,
          basicAuthUsername: "admin",
          basicAuthPassword: "secret",
          basicAuthRealm: "T3 Staging",
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const unauthenticatedResponse = yield* Effect.promise(() => fetch(sessionUrl));

      assert.equal(unauthenticatedResponse.status, 401);
      assert.equal(
        unauthenticatedResponse.headers.get("www-authenticate"),
        'Basic realm="T3 Staging", charset="UTF-8"',
      );

      const basicCredential = Buffer.from("admin:secret", "utf8").toString("base64");
      const authenticatedResponse = yield* Effect.promise(() =>
        fetch(sessionUrl, {
          headers: {
            authorization: `Basic ${basicCredential}`,
          },
        }),
      );
      const authenticatedBody = (yield* Effect.promise(() => authenticatedResponse.json())) as {
        readonly authenticated: boolean;
        readonly role?: string;
        readonly auth: {
          readonly policy: string;
          readonly bootstrapMethods: ReadonlyArray<string>;
        };
      };

      assert.equal(authenticatedResponse.status, 200);
      assert.equal(authenticatedBody.authenticated, true);
      assert.equal(authenticatedBody.role, "owner");
      assert.equal(authenticatedBody.auth.policy, "unsafe-no-auth");
      assert.deepEqual(authenticatedBody.auth.bootstrapMethods, []);
      assert.isDefined(authenticatedResponse.headers.get("set-cookie"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("bootstraps a browser session and authenticates the session endpoint via cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const {
        response: bootstrapResponse,
        body: bootstrapBody,
        cookie: setCookie,
      } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.equal(bootstrapBody.authenticated, true);
      assert.equal(bootstrapBody.sessionMethod, "browser-session-cookie");
      assert.isUndefined((bootstrapBody as { readonly sessionToken?: string }).sessionToken);
      assert.isDefined(setCookie);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
      const sessionResponse = yield* Effect.promise(() =>
        fetch(sessionUrl, {
          headers: {
            cookie: setCookie?.split(";")[0] ?? "",
          },
        }),
      );
      const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      };

      assert.equal(sessionResponse.status, 200);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "browser-session-cookie");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps a bearer session and authenticates the session endpoint via authorization header",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { response: bootstrapResponse, body: bootstrapBody } =
          yield* bootstrapBearerSession();

        assert.equal(bootstrapResponse.status, 200);
        assert.equal(bootstrapBody.authenticated, true);
        assert.equal(bootstrapBody.sessionMethod, "bearer-session-token");
        assert.equal(typeof bootstrapBody.sessionToken, "string");
        assert.isTrue((bootstrapBody.sessionToken?.length ?? 0) > 0);

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");
        const sessionResponse = yield* Effect.promise(() =>
          fetch(sessionUrl, {
            headers: {
              authorization: `Bearer ${bootstrapBody.sessionToken ?? ""}`,
            },
          }),
        );
        const sessionBody = (yield* Effect.promise(() => sessionResponse.json())) as {
          readonly authenticated: boolean;
          readonly sessionMethod?: string;
        };

        assert.equal(sessionResponse.status, 200);
        assert.equal(sessionBody.authenticated, true);
        assert.equal(sessionBody.sessionMethod, "bearer-session-token");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues short-lived websocket tokens for authenticated bearer sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const bearerToken = yield* getAuthenticatedBearerSessionToken();
      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const wsTokenResponse = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            authorization: `Bearer ${bearerToken}`,
          },
        }),
      );
      const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
        readonly token: string;
        readonly expiresAt: string;
      };

      assert.equal(wsTokenResponse.status, 200);
      assert.equal(typeof wsTokenBody.token, "string");
      assert.isTrue(wsTokenBody.token.length > 0);
      assert.equal(typeof wsTokenBody.expiresAt, "string");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-token preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const response = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "OPTIONS",
            headers: {
              origin: "http://192.168.86.35:3773",
              "access-control-request-method": "POST",
              "access-control-request-headers": "authorization",
            },
          }),
        );

        assert.equal(response.status, 204);
        assert.equal(response.headers.get("access-control-allow-origin"), "*");
        assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-methods")), [
          "GET",
          "OPTIONS",
          "POST",
        ]);
        assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-headers")), [
          "authorization",
          "b3",
          "content-type",
          "traceparent",
        ]);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote websocket-token auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
      const response = yield* Effect.promise(() =>
        fetch(wsTokenUrl, {
          method: "POST",
          headers: {
            origin: "http://192.168.86.35:3773",
          },
        }),
      );
      const body = (yield* Effect.promise(() => response.json())) as {
        readonly error?: string;
      };

      assert.equal(response.status, 401);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.equal(body.error, "Authentication required.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("issues authenticated one-time pairing credentials for additional clients", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const body = (yield* response.json) as {
        readonly credential: string;
        readonly expiresAt: string;
      };

      assert.equal(response.status, 200);
      assert.equal(typeof body.credential, "string");
      assert.isTrue(body.credential.length > 0);
      assert.equal(typeof body.expiresAt, "string");

      const bootstrapResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(bootstrapResult.response.status, 200);

      const reusedResult = yield* bootstrapBrowserSession(body.credential);
      assert.equal(reusedResult.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects unauthenticated pairing credential requests", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.post("/api/auth/pairing-token");
      assert.equal(response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and revokes pairing links for owner sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const createdResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const createdBody = (yield* createdResponse.json) as {
        readonly id: string;
        readonly credential: string;
      };

      const listResponse = yield* HttpClient.get("/api/auth/pairing-links", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const listedLinks = (yield* listResponse.json) as ReadonlyArray<{
        readonly id: string;
        readonly credential: string;
      }>;

      const revokeUrl = yield* getHttpServerUrl("/api/auth/pairing-links/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: createdBody.id }),
        }),
      );
      const revokedBootstrap = yield* bootstrapBrowserSession(createdBody.credential);

      assert.equal(createdResponse.status, 200);
      assert.equal(listResponse.status, 200);
      assert.isTrue(listedLinks.some((entry) => entry.id === createdBody.id));
      assert.equal(revokeResponse.status, 200);
      assert.equal(revokedBootstrap.response.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects pairing credential requests from non-owner paired sessions", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      const ownerBody = (yield* ownerResponse.json) as {
        readonly credential: string;
      };
      assert.equal(ownerResponse.status, 200);

      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(ownerBody.credential);
      const pairedResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });
      const pairedBody = (yield* pairedResponse.json) as {
        readonly error: string;
      };

      assert.equal(pairedResponse.status, 403);
      assert.equal(pairedBody.error, "Only owner sessions can create pairing credentials.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists paired clients and revokes other sessions while keeping the owner", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingTokenUrl = yield* getHttpServerUrl("/api/auth/pairing-token");
      const ownerPairingResponse = yield* Effect.promise(() =>
        fetch(pairingTokenUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            label: "Julius iPhone",
          }),
        }),
      );
      const ownerPairingBody = (yield* Effect.promise(() => ownerPairingResponse.json())) as {
        readonly credential: string;
        readonly label?: string;
      };
      assert.equal(ownerPairingResponse.status, 200);
      const pairedSessionBootstrap = yield* bootstrapBrowserSession(ownerPairingBody.credential, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        },
      });
      const pairedSessionCookie = pairedSessionBootstrap.cookie?.split(";")[0];
      assert.isDefined(pairedSessionCookie);

      const pairedSessionCookieHeader = pairedSessionCookie ?? "";
      const listClientsUrl = yield* getHttpServerUrl("/api/auth/clients");
      const listBeforeResponse = yield* Effect.promise(() =>
        fetch(listClientsUrl, {
          headers: {
            cookie: ownerCookie,
          },
        }),
      );
      const clientsBefore = (yield* Effect.promise(() =>
        listBeforeResponse.json(),
      )) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
        readonly client: {
          readonly label?: string;
          readonly deviceType: string;
          readonly ipAddress?: string;
          readonly os?: string;
          readonly browser?: string;
        };
      }>;
      const pairedClientBefore = clientsBefore.find((entry) => !entry.current);
      const pairedSessionId = clientsBefore.find((entry) => !entry.current)?.sessionId;

      const revokeOthersResponse = yield* HttpClient.post("/api/auth/clients/revoke-others", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const revokeOthersBody = (yield* revokeOthersResponse.json) as {
        readonly revokedCount: number;
      };

      const listAfterResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clientsAfter = (yield* listAfterResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;

      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookieHeader,
        },
      });
      const pairedClientPairingBody = (yield* pairedClientPairingResponse.json) as {
        readonly error: string;
      };

      assert.equal(listBeforeResponse.status, 200);
      assert.equal(ownerPairingBody.label, "Julius iPhone");
      assert.lengthOf(clientsBefore, 2);
      assert.isDefined(pairedSessionId);
      assert.isDefined(pairedClientBefore);
      assert.deepInclude(pairedClientBefore?.client, {
        label: "Julius iPhone",
        deviceType: "mobile",
        os: "iOS",
        browser: "Safari",
        ipAddress: "127.0.0.1",
      });
      assert.equal(revokeOthersResponse.status, 200);
      assert.equal(revokeOthersBody.revokedCount, 1);
      assert.equal(listAfterResponse.status, 200);
      assert.lengthOf(clientsAfter, 1);
      assert.equal(clientsAfter[0]?.current, true);
      assert.equal(pairedClientPairingResponse.status, 401);
      assert.equal(pairedClientPairingBody.error, "Unauthorized request.");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes an individual paired client session", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          host: "0.0.0.0",
        },
      });

      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const pairingBody = (yield* pairingResponse.json) as {
        readonly credential: string;
      };
      const pairedSessionCookie = yield* getAuthenticatedSessionCookieHeader(
        pairingBody.credential,
      );

      const clientsResponse = yield* HttpClient.get("/api/auth/clients", {
        headers: {
          cookie: ownerCookie,
        },
      });
      const clients = (yield* clientsResponse.json) as ReadonlyArray<{
        readonly sessionId: string;
        readonly current: boolean;
      }>;
      const pairedSessionId = clients.find((entry) => !entry.current)?.sessionId;
      assert.isDefined(pairedSessionId);

      const revokeUrl = yield* getHttpServerUrl("/api/auth/clients/revoke");
      const revokeResponse = yield* Effect.promise(() =>
        fetch(revokeUrl, {
          method: "POST",
          headers: {
            cookie: ownerCookie,
            "content-type": "application/json",
          },
          body: JSON.stringify({ sessionId: pairedSessionId }),
        }),
      );
      const pairedClientPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          cookie: pairedSessionCookie,
        },
      });

      assert.equal(revokeResponse.status, 200);
      assert.equal(pairedClientPairingResponse.status, 401);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects reusing the same bootstrap credential after it has been exchanged", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const first = yield* bootstrapBrowserSession();
      const second = yield* bootstrapBrowserSession();

      assert.equal(first.response.status, 200);
      assert.equal(second.response.status, 401);
      assert.equal(
        (second.body as { readonly error?: string }).error,
        "Invalid bootstrap credential.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "does not accept session tokens via query parameters on authenticated HTTP routes",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const projectDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-router-project-favicon-query-token-",
        });

        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");

        const response = yield* HttpClient.get(
          `/api/project-favicon?cwd=${encodeURIComponent(projectDir)}&token=${encodeURIComponent(sessionToken)}`,
        );

        assert.equal(response.status, 401);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts websocket rpc handshake with a bootstrapped browser session cookie", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: bootstrapResponse, cookie } = yield* bootstrapBrowserSession();

      assert.equal(bootstrapResponse.status, 200);
      assert.isDefined(cookie);

      const wsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        cookie?.split(";")[0] ?? "",
      );
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
      );

      assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
      assert.equal(response.auth.policy, "desktop-managed-local");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("limits active websocket connection slots by the public per-user policy", () =>
    Effect.gen(function* () {
      __testWebSocketConnectionLimits.reset();
      const request = {
        remoteAddress: Option.some("127.0.0.1"),
      } as never;
      const session = {
        sessionId: "auth-session-ws-limit",
        subject: "same-user",
        method: "browser-session-cookie",
        role: "owner",
        client: {},
      } as AuthenticatedSession;

      const slots = yield* Effect.all(
        Array.from({ length: DEFAULT_PUBLIC_ACCESS_LIMITS.maxWebSocketConnectionsPerUser }, () =>
          __testWebSocketConnectionLimits.acquireActiveWebSocketConnectionSlot(request, session),
        ),
      );
      const error = yield* Effect.flip(
        __testWebSocketConnectionLimits.acquireActiveWebSocketConnectionSlot(request, session),
      );

      assert.equal(error.status, 429);
      assertInclude(error.message, "WebSocket connection limit exceeded");
      yield* Effect.forEach(slots, (slot) =>
        __testWebSocketConnectionLimits.releaseActiveWebSocketConnectionSlot(slot),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "rejects websocket rpc handshake when a session token is only provided via query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const { cookie } = yield* bootstrapBrowserSession();
        assert.isDefined(cookie);
        const sessionToken = extractSessionTokenFromSetCookie(cookie ?? "");
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?token=${encodeURIComponent(sessionToken)}`;

        const error = yield* Effect.flip(
          Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
        );

        assert.equal(error._tag, "RpcClientError");
        assertInclude(String(error), "SocketOpenError");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "accepts websocket rpc handshake with a dedicated websocket token in the query string",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const bearerToken = yield* getAuthenticatedBearerSessionToken();
        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const wsTokenResponse = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${bearerToken}`,
            },
          }),
        );
        const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
          readonly token: string;
        };
        const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsToken=${encodeURIComponent(wsTokenBody.token)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({})),
        );

        assert.equal(response.environment.environmentId, testEnvironmentDescriptor.environmentId);
        assert.equal(response.auth.policy, "desktop-managed-local");
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts Supabase bearer websocket tokens with tenant session context", () =>
    Effect.gen(function* () {
      const fixture = makeSignedSupabaseFixture();
      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        yield* buildAppUnderTest({
          config: {
            supabaseProjectUrl: new URL(supabaseProjectUrl),
            supabaseAnonKey: "public-anon-key",
            supabaseJwtAudience: "authenticated",
          },
          seedTenancy: (repository) =>
            repository
              .saveCollaboration({
                presence: [],
                invites: [],
                memberships: [makeSupabaseMembership({ tenantId: TenantId.make("tenant-ws") })],
                activities: [],
              })
              .pipe(Effect.orDie),
        });

        const wsTokenUrl = yield* getHttpServerUrl("/api/auth/ws-token");
        const wsTokenResponse = yield* Effect.promise(() =>
          fetch(wsTokenUrl, {
            method: "POST",
            headers: {
              authorization: `Bearer ${fixture.jwt}`,
            },
          }),
        );
        const wsTokenBody = (yield* Effect.promise(() => wsTokenResponse.json())) as {
          readonly token: string;
        };
        const wsUrl = `${yield* getWsServerUrl("/ws", {
          authenticated: false,
        })}?wsToken=${encodeURIComponent(wsTokenBody.token)}`;

        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) => client[WS_METHODS.providerAccountsList]({})),
        );

        assert.equal(wsTokenResponse.status, 200);
        assert.deepEqual(response.accounts, []);
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files from state dir", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-11111111-1111-4111-8111-111111111111";

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId}.bin`,
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-ok");

      const response = yield* HttpClient.get(`/attachments/${attachmentId}`, {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
        },
      });
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("serves attachment files for URL-encoded paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const config = yield* buildAppUnderTest();
      const attachmentPath = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: "thread%20folder/message%20folder/file%20name.png",
      });
      assert.isNotNull(attachmentPath, "Attachment path should be resolvable");

      yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true });
      yield* fileSystem.writeFileString(attachmentPath, "attachment-encoded-ok");

      const response = yield* HttpClient.get(
        "/attachments/thread%20folder/message%20folder/file%20name.png",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "attachment-encoded-ok");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("proxies browser OTLP trace exports through the server", () =>
    Effect.gen(function* () {
      const upstreamRequests: Array<{
        readonly body: string;
        readonly contentType: string | null;
      }> = [];
      const localTraceRecords: Array<unknown> = [];
      const payload = {
        resourceSpans: [
          {
            resource: {
              attributes: [
                {
                  key: "service.name",
                  value: { stringValue: "t3-web" },
                },
              ],
            },
            scopeSpans: [
              {
                scope: {
                  name: "effect",
                  version: "4.0.0-beta.43",
                },
                spans: [
                  {
                    traceId: "11111111111111111111111111111111",
                    spanId: "2222222222222222",
                    parentSpanId: "3333333333333333",
                    name: "RpcClient.server.getSettings",
                    kind: 3,
                    startTimeUnixNano: "1000000",
                    endTimeUnixNano: "2000000",
                    attributes: [
                      {
                        key: "rpc.method",
                        value: { stringValue: "server.getSettings" },
                      },
                    ],
                    events: [
                      {
                        name: "http.request",
                        timeUnixNano: "1500000",
                        attributes: [
                          {
                            key: "http.status_code",
                            value: { intValue: "200" },
                          },
                        ],
                      },
                    ],
                    links: [],
                    status: {
                      code: "STATUS_CODE_OK",
                    },
                    flags: 1,
                  },
                ],
              },
            ],
          },
        ],
      };

      const collector = yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const NodeHttp = await import("node:http");

          return await new Promise<{
            readonly close: () => Promise<void>;
            readonly url: string;
          }>((resolve, reject) => {
            const server = NodeHttp.createServer((request, response) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk) => {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
              });
              request.on("end", () => {
                upstreamRequests.push({
                  body: Buffer.concat(chunks).toString("utf8"),
                  contentType: request.headers["content-type"] ?? null,
                });
                response.statusCode = 204;
                response.end();
              });
            });

            server.on("error", reject);
            server.listen(0, "127.0.0.1", () => {
              const address = server.address();
              if (!address || typeof address === "string") {
                reject(new Error("Expected TCP collector address"));
                return;
              }

              resolve({
                url: `http://127.0.0.1:${address.port}/v1/traces`,
                close: () =>
                  new Promise<void>((resolveClose, rejectClose) => {
                    server.close((error) => {
                      if (error) {
                        rejectClose(error);
                        return;
                      }
                      resolveClose();
                    });
                  }),
              });
            });
          });
        }),
        ({ close }) => Effect.promise(close),
      );

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: collector.url,
        },
        layers: {
          browserTraceCollector: {
            record: (records) =>
              Effect.sync(() => {
                localTraceRecords.push(...records);
              }),
          },
        },
      });

      const response = yield* HttpClient.post("/api/observability/v1/traces", {
        headers: {
          cookie: yield* getAuthenticatedSessionCookieHeader(),
          "content-type": "application/json",
          origin: "http://localhost:5733",
        },
        body: HttpBody.text(JSON.stringify(payload), "application/json"),
      });

      assert.equal(response.status, 204);
      assert.equal(response.headers["access-control-allow-origin"], "*");
      assert.deepEqual(localTraceRecords, [
        {
          type: "otlp-span",
          name: "RpcClient.server.getSettings",
          traceId: "11111111111111111111111111111111",
          spanId: "2222222222222222",
          parentSpanId: "3333333333333333",
          sampled: true,
          kind: "client",
          startTimeUnixNano: "1000000",
          endTimeUnixNano: "2000000",
          durationMs: 1,
          attributes: {
            "rpc.method": "server.getSettings",
          },
          resourceAttributes: {
            "service.name": "t3-web",
          },
          scope: {
            name: "effect",
            version: "4.0.0-beta.43",
            attributes: {},
          },
          events: [
            {
              name: "http.request",
              timeUnixNano: "1500000",
              attributes: {
                "http.status_code": "200",
              },
            },
          ],
          links: [],
          status: {
            code: "STATUS_CODE_OK",
          },
        },
      ]);
      assert.deepEqual(upstreamRequests, [
        {
          body: JSON.stringify(payload),
          contentType: "application/json",
        },
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("responds to browser OTLP trace preflight requests with CORS headers", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const url = yield* getHttpServerUrl("/api/observability/v1/traces");
      const response = yield* Effect.promise(() =>
        fetch(url, {
          method: "OPTIONS",
          headers: {
            origin: "http://localhost:5733",
            "access-control-request-method": "POST",
            "access-control-request-headers": "content-type",
          },
        }),
      );

      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-methods")), [
        "GET",
        "OPTIONS",
        "POST",
      ]);
      assert.deepEqual(splitHeaderTokens(response.headers.get("access-control-allow-headers")), [
        "authorization",
        "b3",
        "content-type",
        "traceparent",
      ]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores browser OTLP trace exports locally when no upstream collector is configured",
    () =>
      Effect.gen(function* () {
        const localTraceRecords: Array<unknown> = [];
        const payload = yield* makeBrowserOtlpPayload("client.test");
        const resourceSpan = payload.resourceSpans[0];
        const scopeSpan = resourceSpan?.scopeSpans[0];
        const span = scopeSpan?.spans[0];

        assert.notEqual(resourceSpan, undefined);
        assert.notEqual(scopeSpan, undefined);
        assert.notEqual(span, undefined);
        if (!resourceSpan || !scopeSpan || !span) {
          return;
        }

        yield* buildAppUnderTest({
          layers: {
            browserTraceCollector: {
              record: (records) =>
                Effect.sync(() => {
                  localTraceRecords.push(...records);
                }),
            },
          },
        });

        const response = yield* HttpClient.post("/api/observability/v1/traces", {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
            "content-type": "application/json",
          },
          body: HttpBody.text(JSON.stringify(payload), "application/json"),
        });

        assert.equal(response.status, 204);
        assert.equal(localTraceRecords.length, 1);
        const record = localTraceRecords[0] as {
          readonly type: string;
          readonly name: string;
          readonly traceId: string;
          readonly spanId: string;
          readonly kind: string;
          readonly attributes: Readonly<Record<string, unknown>>;
          readonly events: ReadonlyArray<unknown>;
          readonly links: ReadonlyArray<unknown>;
          readonly scope: {
            readonly name?: string;
            readonly attributes: Readonly<Record<string, unknown>>;
          };
          readonly resourceAttributes: Readonly<Record<string, unknown>>;
          readonly status?: {
            readonly code?: string;
          };
        };

        assert.equal(record.type, "otlp-span");
        assert.equal(record.name, span.name);
        assert.equal(record.traceId, span.traceId);
        assert.equal(record.spanId, span.spanId);
        assert.equal(record.kind, "internal");
        assert.deepEqual(record.attributes, {});
        assert.deepEqual(record.events, []);
        assert.deepEqual(record.links, []);
        assert.equal(record.scope.name, scopeSpan.scope.name);
        assert.deepEqual(record.scope.attributes, {});
        assert.equal(record.resourceAttributes["service.name"], "t3-web");
        assert.equal(record.status?.code, String(span.status.code));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("returns 404 for missing attachment id lookups", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const response = yield* HttpClient.get(
        "/attachments/missing-11111111-1111-4111-8111-111111111111",
        {
          headers: {
            cookie: yield* getAuthenticatedSessionCookieHeader(),
          },
        },
      );
      assert.equal(response.status, 404);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc server.upsertKeybinding", () =>
    Effect.gen(function* () {
      const rule: KeybindingRule = {
        command: "terminal.toggle",
        key: "ctrl+k",
      };
      const resolved: ResolvedKeybindingRule = {
        command: "terminal.toggle",
        shortcut: {
          key: "k",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false,
          modKey: true,
        },
      };

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            upsertKeybindingRule: () => Effect.succeed([resolved]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverUpsertKeybinding](rule)),
      );

      assert.deepEqual(response.issues, []);
      assert.deepEqual(response.keybindings, [resolved]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects websocket rpc handshake when session authentication is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-auth-required-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertInclude(String(result.failure), "SocketOpenError");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig streams snapshot then update", () =>
    Effect.gen(function* () {
      const providers = [
        {
          provider: "codex" as const,
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;
      const changeEvent = {
        keybindings: [],
        issues: [],
      } as const;

      yield* buildAppUnderTest({
        config: {
          otlpTracesUrl: "http://localhost:4318/v1/traces",
          otlpMetricsUrl: "http://localhost:4318/v1/metrics",
        },
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.succeed(changeEvent),
          },
          providerRegistry: {
            getProviders: Effect.succeed(providers),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.equal(first.version, 1);
        assert.deepEqual(first.config.keybindings, []);
        assert.deepEqual(first.config.issues, []);
        assert.deepEqual(first.config.providers, providers);
        assert.equal(first.config.observability.logsDirectoryPath.endsWith("/logs"), true);
        assert.equal(first.config.observability.localTracingEnabled, true);
        assert.equal(first.config.observability.otlpTracesUrl, "http://localhost:4318/v1/traces");
        assert.equal(first.config.observability.otlpTracesEnabled, true);
        assert.equal(first.config.observability.otlpMetricsUrl, "http://localhost:4318/v1/metrics");
        assert.equal(first.config.observability.otlpMetricsEnabled, true);
        assert.deepEqual(first.config.settings, DEFAULT_SERVER_SETTINGS);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "keybindingsUpdated",
        payload: { issues: [] },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exposes collaboration presence, invites, shared prompts, and activity over websocket rpc",
    () =>
      Effect.gen(function* () {
        // Invite acceptance now requires a durable identity, so the invited
        // member authenticates with a Supabase bearer token instead of the
        // owner self-accepting the invite.
        const fixture = makeSignedSupabaseFixture();
        yield* buildAppUnderTest({
          config: {
            supabaseProjectUrl: new URL(supabaseProjectUrl),
            supabaseAnonKey: "public-anon-key",
            supabaseJwtAudience: "authenticated",
          },
        });

        const workspaceId = WorkspaceId.make("workspace-accessible-collab");
        const threadId = ThreadId.make("thread-accessible-collab");
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");

        const setup = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const organization = yield* client[WS_METHODS.organizationsCreate]({
                slug: "collab-acme",
                displayName: "Collab Acme",
              });
              const tenantId = organization.tenant.id;
              const presence = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                tenantId,
                workspaceId,
                threadId,
                status: "active",
              });
              const users = yield* client[WS_METHODS.collaborationPresenceList]({
                tenantId,
                workspaceId,
                threadId,
              });
              const createdInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
                tenantId,
                workspaceId,
                email: "member@example.test",
                scope: "workspace",
                roles: ["developer"],
                expiresAt,
              });
              const listedInvites = yield* client[WS_METHODS.collaborationInvitesList]({
                tenantId,
                workspaceId,
              });

              return {
                tenantId,
                presence,
                users,
                createdInvite,
                listedInvites,
              };
            }),
          ),
        );

        const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
        try {
          const memberWsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
          const acceptedInvite = yield* Effect.scoped(
            withWsRpcClient(
              memberWsUrl,
              (client) =>
                client[WS_METHODS.collaborationInvitesAccept]({
                  inviteId: setup.createdInvite.invite.id,
                }),
              {
                headers: {
                  authorization: `Bearer ${fixture.jwt}`,
                },
              },
            ),
          );

          const result = yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const promptActivity = yield* client[WS_METHODS.collaborationSharedPromptRecord]({
                  tenantId: setup.tenantId,
                  workspaceId,
                  threadId,
                  prompt: "Review the tenant-safe auth bridge implementation.",
                });
                const activity = yield* client[WS_METHODS.collaborationActivityList]({
                  tenantId: setup.tenantId,
                  workspaceId,
                  threadId,
                  limit: 10,
                });
                return {
                  promptActivity,
                  activity,
                };
              }),
            ),
          );

          assert.equal(setup.presence.presence.tenantId, setup.tenantId);
          assert.equal(setup.presence.presence.workspaceId, workspaceId);
          assert.equal(setup.users.users.length, 1);
          assert.equal(setup.users.users[0]?.status, "active");
          assert.equal(setup.createdInvite.invite.email, "member@example.test");
          assert.include(
            setup.createdInvite.acceptUrlPath,
            encodeURIComponent(setup.createdInvite.invite.id),
          );
          assert.equal(setup.listedInvites.invites.length, 1);
          assert.equal(acceptedInvite.membership.roles[0], "developer");
          assert.equal(acceptedInvite.membership.userId, supabaseUserId);
          assert.equal(acceptedInvite.invite.acceptedAt !== null, true);
          assert.equal(result.promptActivity.activity.kind, "prompted");
          assert.equal(result.activity.activities[0]?.kind, "prompted");
        } finally {
          fetchSpy.mockRestore();
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects collaboration rpc calls for tenants without membership", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.collaborationPresenceUpsert]({
            tenantId: TenantId.make("tenant-forbidden-collab"),
            workspaceId: WorkspaceId.make("workspace-forbidden-collab"),
            threadId: ThreadId.make("thread-forbidden-collab"),
            status: "active",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "CollaborationError");
      assertInclude(
        result.failure.message,
        "Forbidden: authenticated session does not have workspace.view.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "allows first-time Supabase websocket users to accept an invite before membership",
    () =>
      Effect.gen(function* () {
        const workspaceId = WorkspaceId.make("workspace-supabase-first-invite");
        const threadId = ThreadId.make("thread-supabase-first-invite");
        const expiresAt = new Date(Date.now() + 60_000).toISOString();
        const fixture = makeSignedSupabaseFixture();

        yield* buildAppUnderTest({
          config: {
            supabaseProjectUrl: new URL(supabaseProjectUrl),
            supabaseAnonKey: "public-anon-key",
            supabaseJwtAudience: "authenticated",
          },
        });

        const ownerWsUrl = yield* getWsServerUrl("/ws");
        const setup = yield* Effect.scoped(
          withWsRpcClient(ownerWsUrl, (client) =>
            Effect.gen(function* () {
              const organization = yield* client[WS_METHODS.organizationsCreate]({
                slug: "supabase-first-invite",
                displayName: "Supabase First Invite",
              });
              const invite = yield* client[WS_METHODS.collaborationInvitesCreate]({
                tenantId: organization.tenant.id,
                workspaceId,
                email: "member@example.test",
                scope: "workspace",
                roles: ["developer"],
                expiresAt,
              });
              return {
                organization,
                invite,
              };
            }),
          ),
        );

        const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
        try {
          assert.equal(
            setup.invite.accountSetupUrlPath,
            `/invite?inviteId=${encodeURIComponent(setup.invite.invite.id)}`,
          );
          assert.notInclude(setup.invite.accountSetupUrlPath ?? "", "token=");
          const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
          const result = yield* Effect.scoped(
            withWsRpcClient(
              wsUrl,
              (client) =>
                Effect.gen(function* () {
                  const beforeAccept = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                    tenantId: setup.organization.tenant.id,
                    workspaceId,
                    threadId,
                    status: "active",
                  }).pipe(Effect.result);
                  const acceptedInvite = yield* client[WS_METHODS.collaborationInvitesAccept]({
                    inviteId: setup.invite.invite.id,
                  });
                  const afterAccept = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                    tenantId: setup.organization.tenant.id,
                    workspaceId,
                    threadId,
                    status: "active",
                  });
                  return {
                    beforeAccept,
                    acceptedInvite,
                    afterAccept,
                  };
                }),
              {
                headers: {
                  authorization: `Bearer ${fixture.jwt}`,
                },
              },
            ),
          );

          assertTrue(result.beforeAccept._tag === "Failure");
          assertTrue(result.beforeAccept.failure._tag === "CollaborationError");
          assertInclude(
            result.beforeAccept.failure.message,
            "Forbidden: authenticated session does not have workspace.view.",
          );
          assert.equal(result.acceptedInvite.membership.userId, supabaseUserId);
          assert.equal(result.acceptedInvite.membership.tenantId, setup.organization.tenant.id);
          assert.equal(result.acceptedInvite.membership.roles[0], "developer");
          assert.equal(result.afterAccept.presence.userId, supabaseUserId);
          assert.equal(result.afterAccept.presence.displayName, "Supabase Member");
        } finally {
          fetchSpy.mockRestore();
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects Supabase websocket rpc payloads that swap tenant ids", () =>
    Effect.gen(function* () {
      const allowedTenantId = TenantId.make("tenant-supabase-allowed-collab");
      const forbiddenTenantId = TenantId.make("tenant-supabase-forbidden-collab");
      const workspaceId = WorkspaceId.make("workspace-supabase-collab");
      const threadId = ThreadId.make("thread-supabase-collab");
      const fixture = makeSignedSupabaseFixture();

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) =>
          repository
            .saveCollaboration({
              presence: [],
              invites: [],
              memberships: [makeSupabaseMembership({ tenantId: allowedTenantId })],
              activities: [],
            })
            .pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.gen(function* () {
                const allowedPresence = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                  tenantId: allowedTenantId,
                  workspaceId,
                  threadId,
                  status: "active",
                });
                const forbiddenPresence = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                  tenantId: forbiddenTenantId,
                  workspaceId,
                  threadId,
                  status: "active",
                }).pipe(Effect.result);
                const forbiddenPrompt = yield* client[WS_METHODS.collaborationSharedPromptRecord]({
                  tenantId: forbiddenTenantId,
                  workspaceId,
                  threadId,
                  prompt: "This should not cross tenant boundaries.",
                }).pipe(Effect.result);
                return {
                  allowedPresence,
                  forbiddenPresence,
                  forbiddenPrompt,
                };
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(result.allowedPresence.presence.tenantId, allowedTenantId);
        assert.equal(result.allowedPresence.presence.userId, supabaseUserId);
        assert.equal(result.allowedPresence.presence.displayName, "Supabase Member");
        assertTrue(result.forbiddenPresence._tag === "Failure");
        assertTrue(result.forbiddenPresence.failure._tag === "CollaborationError");
        assertInclude(
          result.forbiddenPresence.failure.message,
          "Forbidden: authenticated session does not have workspace.view.",
        );
        assertTrue(result.forbiddenPrompt._tag === "Failure");
        assertTrue(result.forbiddenPrompt.failure._tag === "CollaborationError");
        assertInclude(
          result.forbiddenPrompt.failure.message,
          "Forbidden: authenticated session does not have session.prompt.",
        );
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects Supabase file RPC access to unauthorized provider workspaces", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const allowedTenantId = TenantId.make("tenant-supabase-file-allowed");
      const forbiddenTenantId = TenantId.make("tenant-supabase-file-forbidden");
      const otherUserId = UserId.make("supabase:other-private-provider-user");
      const allowedProjectId = ProjectId.make("project-supabase-file-allowed");
      const allowedThreadId = ThreadId.make("thread-supabase-file-allowed");
      const allowedWorkspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-file-allowed-",
      });
      const privateWorkspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-file-private-",
      });
      const forbiddenWorkspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-file-forbidden-",
      });
      yield* fs.writeFileString(path.join(allowedWorkspaceDir, "allowed.txt"), "allowed");
      yield* fs.writeFileString(
        path.join(allowedWorkspaceDir, "oversized-read.txt"),
        "x".repeat(DEFAULT_PUBLIC_ACCESS_LIMITS.maxFileReadBytes + 1),
      );
      yield* Effect.forEach(
        Array.from(
          { length: DEFAULT_PUBLIC_ACCESS_LIMITS.maxDirectoryEntries + 1 },
          (_, index) => `entry-${String(index).padStart(4, "0")}.txt`,
        ),
        (fileName) => fs.writeFileString(path.join(allowedWorkspaceDir, fileName), "entry"),
        { concurrency: 32, discard: true },
      );
      yield* fs.writeFileString(path.join(privateWorkspaceDir, "private.txt"), "private");
      yield* fs.writeFileString(path.join(forbiddenWorkspaceDir, "secret.txt"), "forbidden");
      const fixture = makeSignedSupabaseFixture();
      const oversizedDiff = "x".repeat(DEFAULT_PUBLIC_ACCESS_LIMITS.maxDiffBytes + 1);

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        layers: {
          orchestrationEngine: {
            getReadModel: () => {
              const readModel = makeDefaultOrchestrationReadModel();
              return Effect.succeed({
                ...readModel,
                projects: [
                  ...readModel.projects,
                  {
                    id: allowedProjectId,
                    title: "Allowed Supabase Workspace",
                    workspaceRoot: allowedWorkspaceDir,
                    defaultModelSelection,
                    scripts: [],
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    deletedAt: null,
                  },
                  {
                    id: ProjectId.make("project-supabase-file-forbidden"),
                    title: "Forbidden Supabase Workspace",
                    workspaceRoot: forbiddenWorkspaceDir,
                    defaultModelSelection,
                    scripts: [],
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    deletedAt: null,
                  },
                  {
                    id: ProjectId.make("project-supabase-file-private"),
                    title: "Private Same-Tenant Supabase Workspace",
                    workspaceRoot: privateWorkspaceDir,
                    defaultModelSelection,
                    scripts: [],
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    deletedAt: null,
                  },
                ],
                threads: [
                  ...readModel.threads,
                  {
                    id: allowedThreadId,
                    projectId: allowedProjectId,
                    title: "Allowed Supabase Thread",
                    modelSelection: defaultModelSelection,
                    interactionMode: "default",
                    runtimeMode: "full-access",
                    branch: null,
                    worktreePath: null,
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    archivedAt: null,
                    latestTurn: null,
                    messages: [],
                    session: null,
                    activities: [],
                    proposedPlans: [],
                    checkpoints: [],
                    deletedAt: null,
                  },
                ],
              });
            },
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: allowedThreadId,
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: oversizedDiff,
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: allowedThreadId,
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: oversizedDiff,
              }),
          },
        },
        seedTenancy: (repository) =>
          Effect.all(
            [
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [makeSupabaseMembership({ tenantId: allowedTenantId })],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: ProviderAccountId.make("provider-account-supabase-file-allowed"),
                    provider: "codex",
                    tenantId: allowedTenantId,
                    owner: { type: "user", userId: supabaseUserId },
                    sharing: "private",
                    authHomeDir: path.join(allowedWorkspaceDir, ".provider-home"),
                    configDir: path.join(allowedWorkspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(allowedWorkspaceDir, ".secrets"),
                    createdAt: new Date().toISOString(),
                    disabledAt: null,
                  },
                  {
                    id: ProviderAccountId.make("provider-account-supabase-file-private"),
                    provider: "codex",
                    tenantId: allowedTenantId,
                    owner: { type: "user", userId: otherUserId },
                    sharing: "private",
                    authHomeDir: path.join(privateWorkspaceDir, ".provider-home"),
                    configDir: path.join(privateWorkspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(privateWorkspaceDir, ".secrets"),
                    createdAt: new Date().toISOString(),
                    disabledAt: null,
                  },
                  {
                    id: ProviderAccountId.make("provider-account-supabase-file-forbidden"),
                    provider: "codex",
                    tenantId: forbiddenTenantId,
                    owner: { type: "tenant", tenantId: forbiddenTenantId },
                    sharing: "tenant-shared",
                    authHomeDir: path.join(forbiddenWorkspaceDir, ".provider-home"),
                    configDir: path.join(forbiddenWorkspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(forbiddenWorkspaceDir, ".secrets"),
                    createdAt: new Date().toISOString(),
                    disabledAt: null,
                  },
                ],
                providerSessions: [
                  {
                    id: ProviderSessionId.make("provider-session-supabase-file-allowed"),
                    tenantId: allowedTenantId,
                    userId: supabaseUserId,
                    providerAccountId: ProviderAccountId.make(
                      "provider-account-supabase-file-allowed",
                    ),
                    provider: "codex",
                    providerHomeDir: path.join(allowedWorkspaceDir, ".provider-home"),
                    cwd: allowedWorkspaceDir,
                    createdAt: new Date().toISOString(),
                    endedAt: null,
                  },
                  {
                    id: ProviderSessionId.make("provider-session-supabase-file-private"),
                    tenantId: allowedTenantId,
                    userId: otherUserId,
                    providerAccountId: ProviderAccountId.make(
                      "provider-account-supabase-file-private",
                    ),
                    provider: "codex",
                    providerHomeDir: path.join(privateWorkspaceDir, ".provider-home"),
                    cwd: privateWorkspaceDir,
                    createdAt: new Date().toISOString(),
                    endedAt: null,
                  },
                  {
                    id: ProviderSessionId.make("provider-session-supabase-file-forbidden"),
                    tenantId: forbiddenTenantId,
                    userId: UserId.make("supabase:forbidden-user"),
                    providerAccountId: ProviderAccountId.make(
                      "provider-account-supabase-file-forbidden",
                    ),
                    provider: "codex",
                    providerHomeDir: path.join(forbiddenWorkspaceDir, ".provider-home"),
                    cwd: forbiddenWorkspaceDir,
                    createdAt: new Date().toISOString(),
                    endedAt: null,
                  },
                ],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.gen(function* () {
                const allowedRead = yield* client[WS_METHODS.projectsReadFile]({
                  cwd: allowedWorkspaceDir,
                  relativePath: "allowed.txt",
                });
                const forbiddenRead = yield* client[WS_METHODS.projectsReadFile]({
                  cwd: forbiddenWorkspaceDir,
                  relativePath: "secret.txt",
                }).pipe(Effect.result);
                const privateRead = yield* client[WS_METHODS.projectsReadFile]({
                  cwd: privateWorkspaceDir,
                  relativePath: "private.txt",
                }).pipe(Effect.result);
                const oversizedRead = yield* client[WS_METHODS.projectsReadFile]({
                  cwd: allowedWorkspaceDir,
                  relativePath: "oversized-read.txt",
                }).pipe(Effect.result);
                const oversizedWrite = yield* client[WS_METHODS.projectsWriteFile]({
                  cwd: allowedWorkspaceDir,
                  relativePath: "oversized-write.txt",
                  contents: "x".repeat(DEFAULT_PUBLIC_ACCESS_LIMITS.maxFileUploadBytes + 1),
                }).pipe(Effect.result);
                const oversizedDirectory = yield* client[WS_METHODS.projectsListDirectory]({
                  cwd: allowedWorkspaceDir,
                }).pipe(Effect.result);
                const oversizedTurnDiff = yield* client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
                  threadId: allowedThreadId,
                  fromTurnCount: 0,
                  toTurnCount: 1,
                }).pipe(Effect.result);
                const oversizedFullThreadDiff = yield* client[
                  ORCHESTRATION_WS_METHODS.getFullThreadDiff
                ]({
                  threadId: allowedThreadId,
                  toTurnCount: 1,
                }).pipe(Effect.result);
                return {
                  allowedRead,
                  forbiddenRead,
                  privateRead,
                  oversizedRead,
                  oversizedWrite,
                  oversizedDirectory,
                  oversizedTurnDiff,
                  oversizedFullThreadDiff,
                };
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(result.allowedRead.contents, "allowed");
        assertTrue(result.forbiddenRead._tag === "Failure");
        assertTrue(result.forbiddenRead.failure._tag === "ProjectReadFileError");
        assertInclude(
          result.forbiddenRead.failure.message,
          "Forbidden: authenticated session does not have file.read.",
        );
        assertTrue(result.privateRead._tag === "Failure");
        assertTrue(result.privateRead.failure._tag === "ProjectReadFileError");
        assertInclude(
          result.privateRead.failure.message,
          "Forbidden: authenticated session does not have file.read.",
        );
        assertTrue(result.oversizedRead._tag === "Failure");
        assertTrue(result.oversizedRead.failure._tag === "ProjectReadFileError");
        assertInclude(result.oversizedRead.failure.message, "File read exceeds public read limit:");
        assertTrue(result.oversizedWrite._tag === "Failure");
        assertTrue(result.oversizedWrite.failure._tag === "ProjectWriteFileError");
        assertInclude(
          result.oversizedWrite.failure.message,
          "File write exceeds public upload limit:",
        );
        assertTrue(result.oversizedDirectory._tag === "Failure");
        assertTrue(result.oversizedDirectory.failure._tag === "ProjectListDirectoryError");
        assertInclude(
          result.oversizedDirectory.failure.message,
          "Directory listing exceeds public entry limit:",
        );
        assertTrue(result.oversizedTurnDiff._tag === "Failure");
        assertTrue(result.oversizedTurnDiff.failure._tag === "OrchestrationGetTurnDiffError");
        assertInclude(
          result.oversizedTurnDiff.failure.message,
          "Diff response exceeds public size limit:",
        );
        assertTrue(result.oversizedFullThreadDiff._tag === "Failure");
        assertTrue(
          result.oversizedFullThreadDiff.failure._tag === "OrchestrationGetFullThreadDiffError",
        );
        assertInclude(
          result.oversizedFullThreadDiff.failure.message,
          "Diff response exceeds public size limit:",
        );
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("authorizes Supabase runtime mode changes with runtime.manage", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-runtime-mode");
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-runtime-mode-",
      });
      const projectId = ProjectId.make("project-supabase-runtime-mode");
      const threadId = ThreadId.make("thread-supabase-runtime-mode");
      const ownerSubject = "11111111-2222-4333-8444-555555555555";
      const ownerUserId = UserId.make(`supabase:${ownerSubject}`);
      const keyPair = Crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      const kid = "server-e2e-supabase-runtime-key";
      const developerJwt = signSupabaseJwt({ keyPair, kid });
      const ownerJwt = signSupabaseJwt({
        keyPair,
        kid,
        claims: {
          sub: ownerSubject,
          email: "runtime-owner@example.test",
          user_metadata: { full_name: "Runtime Owner" },
        },
      });
      const jwks: SupabaseJwks = {
        keys: [
          {
            ...keyPair.publicKey.export({ format: "jwk" }),
            kid,
            alg: "RS256",
            use: "sig",
          },
        ],
      };

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        layers: {
          orchestrationEngine: {
            getReadModel: () => {
              const readModel = makeDefaultOrchestrationReadModel();
              return Effect.succeed({
                ...readModel,
                projects: [
                  ...readModel.projects,
                  {
                    id: projectId,
                    title: "Runtime Mode Supabase Workspace",
                    workspaceRoot: workspaceDir,
                    defaultModelSelection,
                    scripts: [],
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    deletedAt: null,
                  },
                ],
                threads: [
                  ...readModel.threads,
                  {
                    id: threadId,
                    projectId,
                    title: "Runtime Mode Supabase Thread",
                    modelSelection: defaultModelSelection,
                    interactionMode: "default" as const,
                    runtimeMode: "full-access" as const,
                    branch: null,
                    worktreePath: null,
                    createdAt: readModel.updatedAt,
                    updatedAt: readModel.updatedAt,
                    archivedAt: null,
                    latestTurn: null,
                    messages: [],
                    session: null,
                    activities: [],
                    proposedPlans: [],
                    checkpoints: [],
                    deletedAt: null,
                  },
                ],
              });
            },
          },
        },
        seedTenancy: (repository) =>
          Effect.all(
            [
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [
                  makeSupabaseMembership({ tenantId, roles: ["developer"] }),
                  makeSupabaseMembership({ tenantId, userId: ownerUserId, roles: ["owner"] }),
                ],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: ProviderAccountId.make("provider-account-supabase-runtime-mode"),
                    provider: "codex",
                    tenantId,
                    owner: { type: "tenant", tenantId },
                    sharing: "tenant-shared",
                    authHomeDir: path.join(workspaceDir, ".provider-home"),
                    configDir: path.join(workspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(workspaceDir, ".secrets"),
                    createdAt: new Date().toISOString(),
                    disabledAt: null,
                  },
                ],
                providerSessions: [
                  {
                    id: ProviderSessionId.make("provider-session-supabase-runtime-mode"),
                    tenantId,
                    userId: ownerUserId,
                    providerAccountId: ProviderAccountId.make(
                      "provider-account-supabase-runtime-mode",
                    ),
                    provider: "codex",
                    providerHomeDir: path.join(workspaceDir, ".provider-home"),
                    cwd: workspaceDir,
                    createdAt: new Date().toISOString(),
                    endedAt: null,
                  },
                ],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const developer = yield* withWsRpcClient(
              wsUrl,
              (client) =>
                client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("cmd-supabase-runtime-mode-developer-denied"),
                  threadId,
                  runtimeMode: "approval-required",
                  createdAt: new Date().toISOString(),
                }).pipe(Effect.result),
              {
                headers: {
                  authorization: `Bearer ${developerJwt}`,
                },
              },
            );
            const owner = yield* withWsRpcClient(
              wsUrl,
              (client) =>
                client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                  type: "thread.runtime-mode.set",
                  commandId: CommandId.make("cmd-supabase-runtime-mode-owner-allowed"),
                  threadId,
                  runtimeMode: "approval-required",
                  createdAt: new Date().toISOString(),
                }),
              {
                headers: {
                  authorization: `Bearer ${ownerJwt}`,
                },
              },
            );
            return { developer, owner };
          }),
        );

        assertTrue(result.developer._tag === "Failure");
        assertTrue(result.developer.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(
          result.developer.failure.message,
          "Forbidden: authenticated session does not have runtime.manage.",
        );
        assert.isAtLeast(result.owner.sequence, 0);
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rate limits hosted Supabase RPC calls with the public access policy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-rpc-rate-limit");
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-rpc-rate-limit-",
      });
      const subject = "22222222-3333-4444-8555-666666666666";
      const userId = UserId.make(`supabase:${subject}`);
      const fixture = makeSignedSupabaseFixture({
        sub: subject,
        email: "rpc-rate-limit@example.test",
        user_metadata: { full_name: "RPC Rate Limit" },
      });
      const allowedCount = DEFAULT_PUBLIC_ACCESS_LIMITS.maxRpcRequestsPerMinutePerUser;

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) =>
          repository
            .saveCollaboration({
              presence: [],
              invites: [],
              memberships: [makeSupabaseMembership({ tenantId, userId })],
              activities: [],
            })
            .pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const attempts = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.forEach(
                Array.from({ length: allowedCount + 1 }, (_, index) => index),
                (index) =>
                  client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                    type: "project.create",
                    commandId: CommandId.make(`cmd-supabase-rpc-rate-limit-${index}`),
                    projectId: ProjectId.make(`project-supabase-rpc-rate-limit-${index}`),
                    title: `RPC Rate Limit ${index}`,
                    workspaceRoot: path.join(workspaceDir, `project-${index}`),
                    createWorkspaceRootIfMissing: true,
                    defaultModelSelection,
                    createdAt: new Date().toISOString(),
                  }).pipe(Effect.result),
                { concurrency: 1 },
              ),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );
        const lastAttempt = attempts[attempts.length - 1];

        assert.isTrue(
          attempts.slice(0, allowedCount).every((attempt) => attempt._tag === "Success"),
        );
        assertTrue(lastAttempt?._tag === "Failure");
        assertTrue(lastAttempt.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(
          lastAttempt.failure.message,
          `Rate limit exceeded: ${allowedCount} RPC requests per minute are allowed for this user.`,
        );
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects hosted Supabase oversized RPC request bodies", () =>
    Effect.gen(function* () {
      const tenantId = TenantId.make("tenant-supabase-rpc-payload-limit");
      const subject = "33333333-4444-4555-8666-777777777777";
      const userId = UserId.make(`supabase:${subject}`);
      const fixture = makeSignedSupabaseFixture({
        sub: subject,
        email: "rpc-payload-limit@example.test",
        user_metadata: { full_name: "RPC Payload Limit" },
      });

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) =>
          repository
            .saveCollaboration({
              presence: [],
              invites: [],
              memberships: [makeSupabaseMembership({ tenantId, userId })],
              activities: [],
            })
            .pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-supabase-rpc-payload-limit"),
                threadId: ThreadId.make("thread-supabase-rpc-payload-limit"),
                message: {
                  messageId: MessageId.make("msg-supabase-rpc-payload-limit"),
                  role: "user",
                  text: "x".repeat(DEFAULT_PUBLIC_ACCESS_LIMITS.maxRpcRequestBytes + 1),
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: new Date().toISOString(),
              }).pipe(Effect.result),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(
          result.failure.message,
          "orchestration.dispatchCommand request exceeds public payload limit:",
        );
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists provider isolation records before hosted Supabase turn dispatch", () =>
    Effect.gen(function* () {
      const tenantId = TenantId.make("tenant-supabase-provider-start-persist");
      const organizationId = OrganizationId.make("org-supabase-provider-start-persist");
      // Personal provider account creation now requires provider.connect, which
      // the developer role no longer grants; use admin so the turn dispatch can
      // provision the isolation records under test.
      const membership = makeSupabaseMembership({
        tenantId,
        organizationId,
        roles: ["admin"],
      });
      const fixture = makeSignedSupabaseFixture();
      let capturedRepository: TenancyRepositoryShape | undefined;

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return Effect.all(
            [
              repository.saveOrganizations({
                organizations: [
                  {
                    id: organizationId,
                    slug: "provider-start-persist",
                    displayName: "Provider Start Persist",
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                tenants: [
                  {
                    id: tenantId,
                    slug: "provider-start-persist",
                    displayName: "Provider Start Persist",
                    kind: "corporate",
                    organizationId,
                    runtimeId: TenantRuntimeId.make("runtime-supabase-provider-start-persist"),
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                employees: [
                  {
                    membership,
                    email: "provider-start@example.com",
                    displayName: "Provider Start",
                    status: "active",
                  },
                ],
                invites: [],
                memberships: [membership],
                teams: [],
                departments: [],
                grants: [],
                reviews: [],
                auditEvents: [],
              }),
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [membership],
                activities: [],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie);
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-supabase-provider-start-persist"),
                threadId: defaultThreadId,
                message: {
                  messageId: MessageId.make("msg-supabase-provider-start-persist"),
                  role: "user",
                  text: "start hosted turn",
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: new Date().toISOString(),
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(result.sequence, 0);
        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const providerIsolation = yield* capturedRepository.loadProviderIsolation();
        assert.equal(providerIsolation.providerAccounts.length, 1);
        assert.equal(providerIsolation.providerSessions.length, 1);
        const account = providerIsolation.providerAccounts[0];
        const providerSession = providerIsolation.providerSessions[0];
        assert.equal(account?.id, `provider-account:${tenantId}:${supabaseUserId}:codex`);
        assert.equal(account?.tenantId, tenantId);
        assert.equal(account?.provider, "codex");
        assert.equal(account?.sharing, "private");
        assertTrue(account?.owner.type === "user");
        assert.equal(account.owner.userId, supabaseUserId);
        assert.equal(providerSession?.providerAccountId, account.id);
        assert.equal(providerSession?.tenantId, tenantId);
        assert.equal(providerSession?.userId, supabaseUserId);
        assert.equal(providerSession?.cwd, "/tmp/default-project");
        assert.equal(providerSession?.endedAt, null);
        const organizations = yield* capturedRepository.loadOrganizations();
        const providerAuditKinds = organizations.auditEvents.map((event) => event.kind);
        assert.include(providerAuditKinds, "provider-account-created");
        assert.include(providerAuditKinds, "provider-account-launch-used");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("lists and disconnects hosted provider accounts without exposing local secrets", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-provider-account-status");
      const organizationId = OrganizationId.make("org-supabase-provider-account-status");
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-provider-account-status-",
      });
      const accountId = ProviderAccountId.make("provider-account-supabase-status");
      const providerSessionId = ProviderSessionId.make("provider-session-supabase-status");
      const membership = makeSupabaseMembership({
        tenantId,
        organizationId,
        roles: ["admin"],
      });
      const fixture = makeSignedSupabaseFixture();
      let capturedRepository: TenancyRepositoryShape | undefined;
      const terminalOpenInputs: TerminalOpenInput[] = [];
      const terminalWriteInputs: TerminalWriteInput[] = [];

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        layers: {
          terminalManager: {
            open: (input) => {
              terminalOpenInputs.push(input);
              return Effect.succeed({
                threadId: input.threadId,
                terminalId: input.terminalId ?? "terminal-default",
                cwd: input.cwd,
                worktreePath: input.worktreePath ?? null,
                status: "running" as const,
                pid: 12345,
                history: "",
                exitCode: null,
                exitSignal: null,
                updatedAt: "2026-05-09T01:02:00.000Z",
              });
            },
            write: (input) => {
              terminalWriteInputs.push(input);
              return Effect.void;
            },
          },
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return Effect.all(
            [
              repository.saveOrganizations({
                organizations: [
                  {
                    id: organizationId,
                    slug: "provider-account-status",
                    displayName: "Provider Account Status",
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                tenants: [
                  {
                    id: tenantId,
                    slug: "provider-account-status",
                    displayName: "Provider Account Status",
                    kind: "corporate",
                    organizationId,
                    runtimeId: TenantRuntimeId.make("runtime-supabase-provider-account-status"),
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                employees: [
                  {
                    membership,
                    email: "provider-status@example.com",
                    displayName: "Provider Status",
                    status: "active",
                  },
                ],
                invites: [],
                memberships: [membership],
                teams: [],
                departments: [],
                grants: [],
                reviews: [],
                auditEvents: [],
              }),
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [membership],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: accountId,
                    provider: "codex",
                    tenantId,
                    owner: { type: "user", userId: supabaseUserId },
                    sharing: "private",
                    authHomeDir: path.join(workspaceDir, ".provider-home"),
                    configDir: path.join(workspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(workspaceDir, ".secrets"),
                    createdAt: "2026-05-09T01:00:00.000Z",
                    disabledAt: null,
                  },
                ],
                providerSessions: [
                  {
                    id: providerSessionId,
                    tenantId,
                    userId: supabaseUserId,
                    providerAccountId: accountId,
                    provider: "codex",
                    providerHomeDir: path.join(workspaceDir, ".provider-session-home"),
                    cwd: workspaceDir,
                    createdAt: "2026-05-09T01:01:00.000Z",
                    endedAt: null,
                  },
                ],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie);
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.gen(function* () {
                const connect = yield* client[WS_METHODS.providerAccountsConnect]({
                  provider: "codex",
                });
                const authTerminal = yield* client[WS_METHODS.providerAccountsOpenAuthTerminal]({
                  provider: "codex",
                  threadId: defaultThreadId,
                });
                const listedBefore = yield* client[WS_METHODS.providerAccountsList]({});
                const disconnected = yield* client[WS_METHODS.providerAccountsDisconnect]({
                  providerAccountId: accountId,
                });
                const listedAfter = yield* client[WS_METHODS.providerAccountsList]({});
                return { connect, authTerminal, listedBefore, disconnected, listedAfter };
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(result.connect.instructions.provider, "codex");
        assert.equal(result.connect.instructions.authCommand, "codex login --device-auth");
        assert.equal(result.connect.instructions.statusCommand, "codex login status");
        assert.isFalse("authHomeDir" in result.connect.instructions);
        assert.isFalse("secretsDir" in result.connect.instructions);
        assert.equal(result.authTerminal.instructions.provider, "codex");
        assert.equal(result.authTerminal.instructions.authCommand, "codex login --device-auth");
        assert.equal(result.authTerminal.terminal.terminalId, "provider-auth-codex");
        assert.include(result.authTerminal.terminal.cwd, "/provider-homes/");
        assert.include(result.authTerminal.terminal.cwd, `${tenantId}`);
        assert.include(result.authTerminal.terminal.cwd, `supabase-${supabaseSubject}`);
        assert.equal(terminalOpenInputs.length, 1);
        assert.equal(terminalOpenInputs[0]?.threadId, defaultThreadId);
        assert.equal(terminalOpenInputs[0]?.terminalId, "provider-auth-codex");
        assert.equal(terminalOpenInputs[0]?.cwd, result.authTerminal.terminal.cwd);
        assert.equal(terminalOpenInputs[0]?.env?.CODEX_HOME, result.authTerminal.terminal.cwd);
        assert.equal(
          terminalOpenInputs[0]?.env?.T3_PROVIDER_HOME,
          result.authTerminal.terminal.cwd,
        );
        // The auth terminal now reuses the already-seeded provider account for
        // this tenant/owner/provider instead of deriving a fresh account id.
        assert.equal(terminalOpenInputs[0]?.env?.T3_PROVIDER_ACCOUNT_ID, accountId);
        assert.isUndefined(terminalOpenInputs[0]?.env?.OPENAI_API_KEY);
        assert.equal(terminalWriteInputs.length, 1);
        assert.equal(terminalWriteInputs[0]?.threadId, defaultThreadId);
        assert.equal(terminalWriteInputs[0]?.terminalId, "provider-auth-codex");
        assert.equal(terminalWriteInputs[0]?.data, "codex login --device-auth\n");
        assert.equal(result.listedBefore.accounts.length, 1);
        const beforeAccount = result.listedBefore.accounts[0];
        if (!beforeAccount) {
          throw new Error("Expected provider account status before disconnect.");
        }
        assert.equal(beforeAccount.id, accountId);
        assert.equal(beforeAccount.status, "connected");
        assert.equal(beforeAccount.activeSessionCount, 1);
        assert.isFalse("authHomeDir" in beforeAccount);
        assert.isFalse("configDir" in beforeAccount);
        assert.isFalse("secretsDir" in beforeAccount);
        assert.equal(result.disconnected.account.status, "disabled");
        assert.equal(result.disconnected.account.activeSessionCount, 0);
        assert.equal(result.listedAfter.accounts[0]?.status, "disabled");
        assert.equal(result.listedAfter.accounts[0]?.activeSessionCount, 0);

        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const persisted = yield* capturedRepository.loadProviderIsolation();
        const persistedAccount = persisted.providerAccounts.find(
          (account) => account.id === accountId,
        );
        const persistedSession = persisted.providerSessions.find(
          (providerSession) => providerSession.id === providerSessionId,
        );
        assert.notEqual(persistedAccount?.disabledAt, null);
        assert.notEqual(persistedSession?.endedAt, null);
        const organizations = yield* capturedRepository.loadOrganizations();
        const providerAuditKinds = organizations.auditEvents.map((event) => event.kind);
        assert.equal(
          providerAuditKinds.filter((kind) => kind === "provider-account-status-checked").length,
          2,
        );
        assert.include(providerAuditKinds, "provider-account-disconnected");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("confirms hosted provider auth before persisting provider account access", () =>
    Effect.gen(function* () {
      const tenantId = TenantId.make("tenant-supabase-provider-account-confirm");
      const organizationId = OrganizationId.make("org-supabase-provider-account-confirm");
      const membership = makeSupabaseMembership({
        tenantId,
        organizationId,
        roles: ["admin"],
      });
      const fixture = makeSignedSupabaseFixture();
      let capturedRepository: TenancyRepositoryShape | undefined;

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return Effect.all(
            [
              repository.saveOrganizations({
                organizations: [
                  {
                    id: organizationId,
                    slug: "provider-account-confirm",
                    displayName: "Provider Account Confirm",
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                tenants: [
                  {
                    id: tenantId,
                    slug: "provider-account-confirm",
                    displayName: "Provider Account Confirm",
                    kind: "corporate",
                    organizationId,
                    runtimeId: TenantRuntimeId.make("runtime-supabase-provider-account-confirm"),
                    createdAt: "2026-05-09T01:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                employees: [
                  {
                    membership,
                    email: "provider-confirm@example.com",
                    displayName: "Provider Confirm",
                    status: "active",
                  },
                ],
                invites: [],
                memberships: [membership],
                teams: [],
                departments: [],
                grants: [],
                reviews: [],
                auditEvents: [],
              }),
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [membership],
                activities: [],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie);
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.gen(function* () {
                const failed = yield* client[WS_METHODS.providerAccountsConfirm]({
                  provider: "codex",
                  threadId: defaultThreadId,
                  statusOutput: "Not logged in",
                }).pipe(Effect.result);
                const listedAfterFailure = yield* client[WS_METHODS.providerAccountsList]({});
                const confirmed = yield* client[WS_METHODS.providerAccountsConfirm]({
                  provider: "codex",
                  threadId: defaultThreadId,
                  statusOutput: "Logged in as hosted-user@example.test",
                });
                const listedAfterConfirm = yield* client[WS_METHODS.providerAccountsList]({});
                return { failed, listedAfterFailure, confirmed, listedAfterConfirm };
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assertTrue(result.failed._tag === "Failure");
        assertTrue(result.failed.failure._tag === "ProviderAccountError");
        assert.equal(result.failed.failure.code, "not-authenticated");
        assertInclude(result.failed.failure.message, "not logged in");
        assert.equal(result.listedAfterFailure.accounts.length, 0);
        assert.equal(
          result.confirmed.account.id,
          `provider-account:${tenantId}:${supabaseUserId}:codex`,
        );
        assert.equal(result.confirmed.account.status, "connected");
        assert.equal(result.confirmed.account.activeSessionCount, 1);
        assert.isFalse("authHomeDir" in result.confirmed.account);
        assert.equal(result.listedAfterConfirm.accounts.length, 1);
        assert.equal(result.listedAfterConfirm.accounts[0]?.status, "connected");

        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const persisted = yield* capturedRepository.loadProviderIsolation();
        assert.equal(persisted.providerAccounts.length, 1);
        assert.equal(persisted.providerSessions.length, 1);
        assert.include(persisted.providerAccounts[0]?.authHomeDir ?? "", "/provider-homes/");
        assert.equal(persisted.providerSessions[0]?.cwd, "/tmp/default-project");

        const organizations = yield* capturedRepository.loadOrganizations();
        const providerAuditKinds = organizations.auditEvents.map((event) => event.kind);
        assert.include(providerAuditKinds, "provider-account-connect-failed");
        assert.include(providerAuditKinds, "provider-account-created");
        assert.include(providerAuditKinds, "provider-account-connect-confirmed");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("locks hosted provider confirmation after repeated failed status checks", () =>
    Effect.gen(function* () {
      const tenantId = TenantId.make("tenant-supabase-provider-confirm-lockout");
      const subject = `provider-confirm-lockout-${crypto.randomUUID()}`;
      const userId = UserId.make(`supabase:${subject}`);
      const fixture = makeSignedSupabaseFixture({
        sub: subject,
        email: `${subject}@example.test`,
        user_metadata: { full_name: "Provider Confirm Lockout" },
      });
      let capturedRepository: TenancyRepositoryShape | undefined;

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return repository
            .saveCollaboration({
              presence: [],
              invites: [],
              memberships: [
                makeSupabaseMembership({
                  tenantId,
                  userId,
                  roles: ["admin"],
                }),
              ],
              activities: [],
            })
            .pipe(Effect.orDie);
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.gen(function* () {
                const failedAttempts = yield* Effect.forEach(
                  Array.from({
                    length: DEFAULT_PUBLIC_ACCESS_LIMITS.maxProviderConnectFailuresPerUser,
                  }),
                  () =>
                    client[WS_METHODS.providerAccountsConfirm]({
                      provider: "codex",
                      threadId: defaultThreadId,
                      statusOutput: "Not logged in",
                    }).pipe(Effect.result),
                  { concurrency: 1 },
                );
                const blockedSuccess = yield* client[WS_METHODS.providerAccountsConfirm]({
                  provider: "codex",
                  threadId: defaultThreadId,
                  statusOutput: "Logged in as locked@example.test",
                }).pipe(Effect.result);
                const listedAfterLockout = yield* client[WS_METHODS.providerAccountsList]({});
                return { failedAttempts, blockedSuccess, listedAfterLockout };
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.isTrue(
          result.failedAttempts.every(
            (attempt) =>
              attempt._tag === "Failure" &&
              attempt.failure._tag === "ProviderAccountError" &&
              attempt.failure.code === "not-authenticated",
          ),
        );
        assertTrue(result.blockedSuccess._tag === "Failure");
        assertTrue(result.blockedSuccess.failure._tag === "ProviderAccountError");
        assert.equal(result.blockedSuccess.failure.code, "rate-limited");
        assertInclude(
          result.blockedSuccess.failure.message,
          "Provider connect confirmation is temporarily locked",
        );
        assert.equal(result.listedAfterLockout.accounts.length, 0);

        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const persisted = yield* capturedRepository.loadProviderIsolation();
        assert.equal(persisted.providerAccounts.length, 0);
        assert.equal(persisted.providerSessions.length, 0);
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "browser verifies manual hosted provider connect, returning status, failed confirmation, and disconnect",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const runId = crypto.randomUUID();
        const uniqueSubject = `provider-browser-${runId}`;
        const uniqueEmail = `provider-browser-${runId}@example.test`;
        const uniqueName = `Provider Browser ${runId.slice(0, 8)}`;
        const userId = UserId.make(`supabase:${uniqueSubject}`);
        const tenantId = TenantId.make(`tenant-provider-browser-${runId}`);
        const organizationId = OrganizationId.make(`org-provider-browser-${runId}`);
        const membership = makeSupabaseMembership({
          tenantId,
          userId,
          organizationId,
          roles: ["admin"],
        });
        const fixture = makeSignedSupabaseFixture({
          sub: uniqueSubject,
          email: uniqueEmail,
          user_metadata: {
            full_name: uniqueName,
          },
        });
        let capturedRepository: TenancyRepositoryShape | undefined;
        const baseReadModel = makeDefaultOrchestrationReadModel();
        const tenantOwnership = {
          tenantId,
          tenantDisplayName: `Provider Browser ${runId}`,
          workspaceId: WorkspaceId.make(`workspace-provider-browser-${runId}`),
          workspaceTitle: `Provider Browser Workspace ${runId}`,
          organizationId,
          organizationDisplayName: `Provider Browser ${runId}`,
          ownerUserId: userId,
          ownerDisplayName: uniqueName,
        };
        const readModel = {
          ...baseReadModel,
          projects: baseReadModel.projects.map((project) => ({
            ...project,
            ownership: tenantOwnership,
          })),
        };
        const terminalOpenInputs: TerminalOpenInput[] = [];
        const terminalWriteInputs: TerminalWriteInput[] = [];

        yield* buildAppUnderTest({
          config: {
            supabaseProjectUrl: new URL(supabaseProjectUrl),
            supabaseAnonKey: "public-anon-key",
            supabaseJwtAudience: "authenticated",
          },
          layers: {
            projectionSnapshotQuery: {
              getSnapshot: () => Effect.succeed(readModel),
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: readModel.snapshotSequence,
                  projects: readModel.projects,
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: readModel.updatedAt,
                }),
              getProjectShellById: (projectId) =>
                Effect.succeed(
                  (() => {
                    const project = readModel.projects.find(
                      (candidate) => candidate.id === projectId,
                    );
                    return project ? Option.some(project) : Option.none();
                  })(),
                ),
              getThreadShellById: (threadId) =>
                Effect.succeed(
                  threadId === defaultThreadId
                    ? Option.some(makeDefaultOrchestrationThreadShell())
                    : Option.none(),
                ),
            },
            terminalManager: {
              open: (input) => {
                terminalOpenInputs.push(input);
                return Effect.succeed({
                  threadId: input.threadId,
                  terminalId: input.terminalId ?? "terminal-default",
                  cwd: input.cwd,
                  worktreePath: input.worktreePath ?? null,
                  status: "running" as const,
                  pid: 12345,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  updatedAt: "2026-05-09T01:02:00.000Z",
                });
              },
              write: (input) => {
                terminalWriteInputs.push(input);
                return Effect.void;
              },
            },
          },
          seedTenancy: (repository) => {
            capturedRepository = repository;
            return Effect.all(
              [
                repository.saveOrganizations({
                  organizations: [
                    {
                      id: organizationId,
                      slug: `provider-browser-${runId}`,
                      displayName: `Provider Browser ${runId}`,
                      createdAt: "2026-05-09T01:00:00.000Z",
                      archivedAt: null,
                    },
                  ],
                  tenants: [
                    {
                      id: tenantId,
                      slug: `provider-browser-${runId}`,
                      displayName: `Provider Browser ${runId}`,
                      kind: "corporate",
                      organizationId,
                      runtimeId: TenantRuntimeId.make(`runtime-provider-browser-${runId}`),
                      createdAt: "2026-05-09T01:00:00.000Z",
                      archivedAt: null,
                    },
                  ],
                  employees: [
                    {
                      membership,
                      email: uniqueEmail,
                      displayName: uniqueName,
                      status: "active",
                    },
                  ],
                  invites: [],
                  memberships: [membership],
                  teams: [],
                  departments: [],
                  grants: [],
                  reviews: [],
                  auditEvents: [],
                }),
                repository.saveCollaboration({
                  presence: [],
                  invites: [],
                  memberships: [membership],
                  activities: [],
                }),
              ],
              { discard: true },
            ).pipe(Effect.orDie);
          },
        });

        const serverHttpBaseUrl = yield* getHttpServerUrl("/");
        const serverWsBaseUrl = yield* getWsServerUrl("/", { authenticated: false });
        const webRoot = path.resolve(import.meta.dirname, "../../web");
        const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);

        const withAccountSettingsBrowser = <A>(
          run: (page: import("playwright").Page, appUrl: string) => Promise<A>,
        ) =>
          Effect.promise(async () => {
            const originalViteHttpUrl = process.env.VITE_HTTP_URL;
            const originalViteWsUrl = process.env.VITE_WS_URL;
            const originalViteDevServerUrl = process.env.VITE_DEV_SERVER_URL;
            const originalPort = process.env.PORT;
            const originalHost = process.env.HOST;
            const originalCwd = process.cwd();
            const vitePort = await reserveTcpPort();
            const appUrl = `http://127.0.0.1:${vitePort}/`;
            process.env.VITE_HTTP_URL = serverHttpBaseUrl;
            process.env.VITE_WS_URL = serverWsBaseUrl;
            process.env.VITE_DEV_SERVER_URL = appUrl;
            process.env.PORT = String(vitePort);
            process.env.HOST = "127.0.0.1";

            const [{ createServer }, { chromium }] = await Promise.all([
              import("vite"),
              import("playwright"),
            ]);
            process.chdir(webRoot);
            const viteServer = await createServer({
              root: webRoot,
              configFile: path.join(webRoot, "vite.config.ts"),
              server: {
                host: "127.0.0.1",
                port: vitePort,
                strictPort: true,
              },
              clearScreen: false,
              logLevel: "error",
            });
            const browser = await chromium.launch({ headless: true });
            try {
              await viteServer.listen();
              return await withCleanBrowserContext(browser, appUrl, null, async (page) => {
                await page.goto(appUrl, { waitUntil: "domcontentloaded" });
                await page.evaluate(async (token) => {
                  localStorage.clear();
                  sessionStorage.clear();
                  const browserGlobal = globalThis as typeof globalThis & {
                    caches?: {
                      keys: () => Promise<string[]>;
                      delete: (cacheName: string) => Promise<boolean>;
                    };
                    indexedDB?: {
                      databases?: () => Promise<Array<{ name?: string | undefined }>>;
                      deleteDatabase: (name: string) => {
                        addEventListener: (type: string, listener: () => void) => void;
                      };
                    };
                  };
                  if (browserGlobal.caches) {
                    const cacheNames = await browserGlobal.caches.keys();
                    await Promise.all(
                      cacheNames.map((cacheName) => browserGlobal.caches?.delete(cacheName)),
                    );
                  }
                  if (typeof browserGlobal.indexedDB?.databases === "function") {
                    const databases = await browserGlobal.indexedDB.databases();
                    await Promise.all(
                      databases
                        .map((database) => database.name)
                        .filter(
                          (name): name is string => typeof name === "string" && name.length > 0,
                        )
                        .map(
                          (name) =>
                            new Promise<void>((resolve) => {
                              const request = browserGlobal.indexedDB?.deleteDatabase(name);
                              if (!request) {
                                resolve();
                                return;
                              }
                              request.addEventListener("success", () => resolve());
                              request.addEventListener("error", () => resolve());
                              request.addEventListener("blocked", () => resolve());
                            }),
                        ),
                    );
                  }
                  localStorage.setItem("t3code.supabase.accessToken", token);
                }, fixture.jwt);
                return await run(page, appUrl);
              });
            } finally {
              await Promise.race([
                browser.close().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
              ]);
              await Promise.race([
                viteServer.close().catch(() => undefined),
                new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
              ]);
              restoreProcessEnvValue("VITE_HTTP_URL", originalViteHttpUrl);
              restoreProcessEnvValue("VITE_WS_URL", originalViteWsUrl);
              restoreProcessEnvValue("VITE_DEV_SERVER_URL", originalViteDevServerUrl);
              restoreProcessEnvValue("PORT", originalPort);
              restoreProcessEnvValue("HOST", originalHost);
              process.chdir(originalCwd);
            }
          });

        try {
          yield* withAccountSettingsBrowser(async (page, appUrl) => {
            const pageMessages: string[] = [];
            page.on("console", (message) => {
              pageMessages.push(`${message.type()}: ${message.text()}`);
            });
            page.on("pageerror", (error) => {
              pageMessages.push(`pageerror: ${error.message}`);
            });
            await page.goto(`${appUrl}settings/account`, { waitUntil: "domcontentloaded" });
            await page
              .getByText(uniqueSubject)
              .waitFor({ timeout: 20_000 })
              .catch(async (error) => {
                const bodyText = await page
                  .locator("body")
                  .innerText()
                  .catch(() => "");
                throw new Error(
                  [
                    error instanceof Error ? error.message : String(error),
                    `url=${page.url()}`,
                    `body=${bodyText}`,
                    `console=${pageMessages.join(" | ")}`,
                  ].join("\n"),
                );
              });
            await page.evaluate(
              async ({ environmentId, projectId, threadId }) => {
                const { useStore } = (await new Function('return import("/src/store.ts")')()) as {
                  useStore: {
                    setState: (state: unknown) => void;
                  };
                };
                useStore.setState({
                  activeEnvironmentId: environmentId,
                  environmentStateById: {
                    [environmentId]: {
                      projectIds: [projectId],
                      projectById: {
                        [projectId]: {
                          id: projectId,
                          environmentId,
                          name: "Default Project",
                          cwd: "/tmp/default-project",
                          defaultModelSelection: null,
                          scripts: [],
                        },
                      },
                      threadIds: [threadId],
                      threadIdsByProjectId: { [projectId]: [threadId] },
                      threadShellById: {
                        [threadId]: {
                          id: threadId,
                          environmentId,
                          codexThreadId: null,
                          projectId,
                          title: "Default Thread",
                          modelSelection: { provider: "codex", model: "gpt-5-codex" },
                          runtimeMode: "full-access",
                          interactionMode: "default",
                          error: null,
                          createdAt: "2026-05-09T00:00:00.000Z",
                          updatedAt: "2026-05-09T00:05:00.000Z",
                          archivedAt: null,
                          branch: null,
                          worktreePath: null,
                        },
                      },
                      threadSessionById: {},
                      threadTurnStateById: {},
                      messageIdsByThreadId: {},
                      messageByThreadId: {},
                      activityIdsByThreadId: {},
                      activityByThreadId: {},
                      proposedPlanIdsByThreadId: {},
                      proposedPlanByThreadId: {},
                      turnDiffIdsByThreadId: {},
                      turnDiffSummaryByThreadId: {},
                      sidebarThreadSummaryById: {},
                      bootstrapComplete: true,
                    },
                  },
                });
              },
              {
                environmentId: testEnvironmentDescriptor.environmentId,
                projectId: defaultProjectId,
                threadId: defaultThreadId,
              },
            );
            await page.getByText("No provider accounts connected.").waitFor({ timeout: 20_000 });
            await page.getByRole("button", { name: "Connect Codex" }).click();
            await page
              .getByText("provider-auth-codex")
              .waitFor({ timeout: 20_000 })
              .catch(async (error) => {
                const bodyText = await page
                  .locator("body")
                  .innerText()
                  .catch(() => "");
                throw new Error(
                  [
                    error instanceof Error ? error.message : String(error),
                    `url=${page.url()}`,
                    `body=${bodyText}`,
                    `console=${pageMessages.join(" | ")}`,
                  ].join("\n"),
                );
              });
            await page.getByText("codex login --device-auth", { exact: true }).waitFor();
            await page.getByText("codex login status", { exact: true }).waitFor();
            await page.getByLabel("Status output").fill("Device code expired");
            await page.getByRole("button", { name: "Confirm status" }).click();
            await page
              .getByText("Codex status output did not report an authenticated account.")
              .waitFor({ timeout: 20_000 });
            await page.getByLabel("Status output").fill(`Logged in as ${uniqueEmail}`);
            await page.getByRole("button", { name: "Confirm status" }).click();
            await page
              .getByText("Connected, 1 active session")
              .waitFor({ timeout: 20_000 })
              .catch(async (error) => {
                const bodyText = await page
                  .locator("body")
                  .innerText()
                  .catch(() => "");
                throw new Error(
                  [
                    error instanceof Error ? error.message : String(error),
                    `url=${page.url()}`,
                    `body=${bodyText}`,
                    `console=${pageMessages.join(" | ")}`,
                  ].join("\n"),
                );
              });
            await page.reload({ waitUntil: "domcontentloaded" });
            await page.getByText("Connected, 1 active session").waitFor({ timeout: 20_000 });
            await page.getByRole("button", { name: "Disconnect" }).click();
            await page.getByText("Disconnected", { exact: true }).waitFor({ timeout: 20_000 });
          });

          assert.equal(terminalOpenInputs.length, 1);
          assert.equal(terminalOpenInputs[0]?.threadId, defaultThreadId);
          assert.equal(terminalOpenInputs[0]?.terminalId, "provider-auth-codex");
          assert.include(terminalOpenInputs[0]?.cwd ?? "", "/provider-homes/");
          assert.equal(terminalWriteInputs.length, 1);
          assert.equal(terminalWriteInputs[0]?.threadId, defaultThreadId);
          assert.equal(terminalWriteInputs[0]?.terminalId, "provider-auth-codex");
          assert.equal(terminalWriteInputs[0]?.data, "codex login --device-auth\n");

          if (!capturedRepository) {
            throw new Error("Tenancy repository was not captured.");
          }
          const providerIsolation = yield* capturedRepository.loadProviderIsolation();
          const account = providerIsolation.providerAccounts.find(
            (candidate) => candidate.id === `provider-account:${tenantId}:${userId}:codex`,
          );
          const providerSession = providerIsolation.providerSessions.find(
            (candidate) => candidate.providerAccountId === account?.id,
          );
          assert.notEqual(account?.disabledAt, null);
          assert.notEqual(providerSession?.endedAt, null);
        } finally {
          fetchSpy.mockRestore();
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects provider account disconnects without connect permission", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-provider-account-forbidden");
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-provider-account-forbidden-",
      });
      const accountId = ProviderAccountId.make("provider-account-supabase-forbidden");
      const fixture = makeSignedSupabaseFixture();

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) =>
          Effect.all(
            [
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [makeSupabaseMembership({ tenantId, roles: ["developer"] })],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: accountId,
                    provider: "codex",
                    tenantId,
                    owner: { type: "user", userId: supabaseUserId },
                    sharing: "private",
                    authHomeDir: path.join(workspaceDir, ".provider-home"),
                    configDir: path.join(workspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(workspaceDir, ".secrets"),
                    createdAt: "2026-05-09T01:00:00.000Z",
                    disabledAt: null,
                  },
                ],
                providerSessions: [],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              Effect.all({
                connect: client[WS_METHODS.providerAccountsConnect]({ provider: "codex" }).pipe(
                  Effect.result,
                ),
                openAuthTerminal: client[WS_METHODS.providerAccountsOpenAuthTerminal]({
                  provider: "codex",
                  threadId: defaultThreadId,
                }).pipe(Effect.result),
                confirm: client[WS_METHODS.providerAccountsConfirm]({
                  provider: "codex",
                  threadId: defaultThreadId,
                  statusOutput: "Logged in",
                }).pipe(Effect.result),
                disconnect: client[WS_METHODS.providerAccountsDisconnect]({
                  providerAccountId: accountId,
                }).pipe(Effect.result),
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assertTrue(result.connect._tag === "Failure");
        assertTrue(result.connect.failure._tag === "ProviderAccountError");
        assert.equal(result.connect.failure.code, "forbidden");
        assertInclude(result.connect.failure.message, "provider.connect");
        assertTrue(result.openAuthTerminal._tag === "Failure");
        assertTrue(result.openAuthTerminal.failure._tag === "ProviderAccountError");
        assert.equal(result.openAuthTerminal.failure.code, "forbidden");
        assertInclude(result.openAuthTerminal.failure.message, "provider.connect");
        assertTrue(result.confirm._tag === "Failure");
        assertTrue(result.confirm.failure._tag === "ProviderAccountError");
        assert.equal(result.confirm.failure.code, "forbidden");
        assertInclude(result.confirm.failure.message, "provider.connect");
        assertTrue(result.disconnect._tag === "Failure");
        assertTrue(result.disconnect.failure._tag === "ProviderAccountError");
        assert.equal(result.disconnect.failure.code, "forbidden");
        assertInclude(result.disconnect.failure.message, "provider.connect");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects hosted Supabase turns over the active turn limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-active-turn-limit");
      const subject = "44444444-5555-4666-8777-888888888888";
      const userId = UserId.make(`supabase:${subject}`);
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-active-turn-limit-",
      });
      const fixture = makeSignedSupabaseFixture({
        sub: subject,
        email: "active-turn-limit@example.test",
        user_metadata: { full_name: "Active Turn Limit" },
      });
      const now = new Date().toISOString();
      const activeTurnCount = DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveTurnsPerUser;
      const activeProjects = Array.from({ length: activeTurnCount }, (_, index) => ({
        id: ProjectId.make(`project-supabase-active-turn-limit-${index}`),
        title: `Active Turn Project ${index}`,
        workspaceRoot: path.join(workspaceDir, `active-${index}`),
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      }));
      const targetProject = {
        id: ProjectId.make("project-supabase-active-turn-limit-target"),
        title: "Active Turn Target",
        workspaceRoot: path.join(workspaceDir, "target"),
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const targetThreadId = ThreadId.make("thread-supabase-active-turn-limit-target");

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        layers: {
          orchestrationEngine: {
            getReadModel: () => {
              const readModel = makeDefaultOrchestrationReadModel();
              return Effect.succeed({
                ...readModel,
                projects: [...readModel.projects, ...activeProjects, targetProject],
                threads: [
                  ...readModel.threads,
                  ...activeProjects.map((project, index) => ({
                    id: ThreadId.make(`thread-supabase-active-turn-limit-${index}`),
                    projectId: project.id,
                    title: `Active Turn Thread ${index}`,
                    modelSelection: defaultModelSelection,
                    interactionMode: "default" as const,
                    runtimeMode: "full-access" as const,
                    branch: null,
                    worktreePath: null,
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                    latestTurn: {
                      turnId: TurnId.make(`turn-supabase-active-turn-limit-${index}`),
                      state: "running" as const,
                      requestedAt: now,
                      startedAt: now,
                      completedAt: null,
                      assistantMessageId: null,
                    },
                    messages: [],
                    session: null,
                    activities: [],
                    proposedPlans: [],
                    checkpoints: [],
                    deletedAt: null,
                  })),
                  {
                    id: targetThreadId,
                    projectId: targetProject.id,
                    title: "Active Turn Target Thread",
                    modelSelection: defaultModelSelection,
                    interactionMode: "default",
                    runtimeMode: "full-access",
                    branch: null,
                    worktreePath: null,
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                    latestTurn: null,
                    messages: [],
                    session: null,
                    activities: [],
                    proposedPlans: [],
                    checkpoints: [],
                    deletedAt: null,
                  },
                ],
              });
            },
            dispatch: () => Effect.succeed({ sequence: 1 }),
          },
        },
        seedTenancy: (repository) =>
          Effect.all(
            [
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [makeSupabaseMembership({ tenantId, userId })],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: ProviderAccountId.make("provider-account-supabase-active-turn-limit"),
                    provider: "codex",
                    tenantId,
                    owner: { type: "tenant", tenantId },
                    sharing: "tenant-shared",
                    authHomeDir: path.join(workspaceDir, ".provider-home"),
                    configDir: path.join(workspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(workspaceDir, ".secrets"),
                    createdAt: now,
                    disabledAt: null,
                  },
                ],
                providerSessions: activeProjects.map((project, index) => ({
                  id: ProviderSessionId.make(
                    `provider-session-supabase-active-turn-limit-${index}`,
                  ),
                  tenantId,
                  userId,
                  providerAccountId: ProviderAccountId.make(
                    "provider-account-supabase-active-turn-limit",
                  ),
                  provider: "codex" as const,
                  providerHomeDir: path.join(workspaceDir, ".provider-home"),
                  cwd: project.workspaceRoot,
                  createdAt: now,
                  endedAt: null,
                })),
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-supabase-active-turn-limit"),
                threadId: targetThreadId,
                message: {
                  messageId: MessageId.make("msg-supabase-active-turn-limit"),
                  role: "user",
                  text: "start another turn",
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: now,
              }).pipe(Effect.result),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(result.failure.message, "Active turn limit exceeded:");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects hosted Supabase turns over the active provider session limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tenantId = TenantId.make("tenant-supabase-provider-session-limit");
      const subject = "55555555-6666-4777-8888-999999999999";
      const userId = UserId.make(`supabase:${subject}`);
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-provider-session-limit-",
      });
      const fixture = makeSignedSupabaseFixture({
        sub: subject,
        email: "provider-session-limit@example.test",
        user_metadata: { full_name: "Provider Session Limit" },
      });
      const now = new Date().toISOString();
      const targetProject = {
        id: ProjectId.make("project-supabase-provider-session-limit-target"),
        title: "Provider Session Limit Target",
        workspaceRoot: path.join(workspaceDir, "target"),
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      const targetThreadId = ThreadId.make("thread-supabase-provider-session-limit-target");

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        layers: {
          orchestrationEngine: {
            getReadModel: () => {
              const readModel = makeDefaultOrchestrationReadModel();
              return Effect.succeed({
                ...readModel,
                projects: [...readModel.projects, targetProject],
                threads: [
                  ...readModel.threads,
                  {
                    id: targetThreadId,
                    projectId: targetProject.id,
                    title: "Provider Session Limit Target Thread",
                    modelSelection: defaultModelSelection,
                    interactionMode: "default",
                    runtimeMode: "full-access",
                    branch: null,
                    worktreePath: null,
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                    latestTurn: null,
                    messages: [],
                    session: null,
                    activities: [],
                    proposedPlans: [],
                    checkpoints: [],
                    deletedAt: null,
                  },
                ],
              });
            },
            dispatch: () => Effect.succeed({ sequence: 1 }),
          },
        },
        seedTenancy: (repository) =>
          Effect.all(
            [
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [makeSupabaseMembership({ tenantId, userId })],
                activities: [],
              }),
              repository.saveProviderIsolation({
                providerAccounts: [
                  {
                    id: ProviderAccountId.make("provider-account-supabase-provider-session-limit"),
                    provider: "codex",
                    tenantId,
                    owner: { type: "tenant", tenantId },
                    sharing: "tenant-shared",
                    authHomeDir: path.join(workspaceDir, ".provider-home"),
                    configDir: path.join(workspaceDir, ".provider-home", "config"),
                    secretsDir: path.join(workspaceDir, ".secrets"),
                    createdAt: now,
                    disabledAt: null,
                  },
                ],
                providerSessions: Array.from(
                  { length: DEFAULT_PUBLIC_ACCESS_LIMITS.maxActiveProviderSessionsPerUser },
                  (_, index) => ({
                    id: ProviderSessionId.make(
                      `provider-session-supabase-provider-session-limit-${index}`,
                    ),
                    tenantId,
                    userId,
                    providerAccountId: ProviderAccountId.make(
                      "provider-account-supabase-provider-session-limit",
                    ),
                    provider: "codex" as const,
                    providerHomeDir: path.join(workspaceDir, ".provider-home"),
                    cwd:
                      index === 0
                        ? targetProject.workspaceRoot
                        : path.join(workspaceDir, `session-${index}`),
                    createdAt: now,
                    endedAt: null,
                  }),
                ),
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie),
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const result = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.turn.start",
                commandId: CommandId.make("cmd-supabase-provider-session-limit"),
                threadId: targetThreadId,
                message: {
                  messageId: MessageId.make("msg-supabase-provider-session-limit"),
                  role: "user",
                  text: "start with too many sessions",
                  attachments: [],
                },
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: now,
              }).pipe(Effect.result),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assertTrue(result._tag === "Failure");
        assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
        assertInclude(result.failure.message, "Active provider session limit exceeded:");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("rejects invite rpc calls without membership and malformed scoped invites", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const forbiddenTenantId = TenantId.make("tenant-forbidden-invite-collab");
      const forbiddenWorkspaceId = WorkspaceId.make("workspace-forbidden-invite-collab");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const createWithoutMembership = yield* client[WS_METHODS.collaborationInvitesCreate]({
              tenantId: forbiddenTenantId,
              workspaceId: forbiddenWorkspaceId,
              email: "forbidden@example.com",
              scope: "workspace",
              roles: ["developer"],
              expiresAt,
            }).pipe(Effect.result);
            const listWithoutMembership = yield* client[WS_METHODS.collaborationInvitesList]({
              tenantId: forbiddenTenantId,
              workspaceId: forbiddenWorkspaceId,
            }).pipe(Effect.result);

            const organization = yield* client[WS_METHODS.organizationsCreate]({
              slug: "scoped-invite-rules",
              displayName: "Scoped Invite Rules",
            });
            const workspaceInviteWithoutWorkspace = yield* client[
              WS_METHODS.collaborationInvitesCreate
            ]({
              tenantId: organization.tenant.id,
              workspaceId: null,
              email: "workspace-missing@example.com",
              scope: "workspace",
              roles: ["developer"],
              expiresAt,
            }).pipe(Effect.result);
            const projectInviteWithoutWorkspace = yield* client[
              WS_METHODS.collaborationInvitesCreate
            ]({
              tenantId: organization.tenant.id,
              workspaceId: null,
              email: "project-missing@example.com",
              scope: "project",
              roles: ["developer"],
              expiresAt,
            }).pipe(Effect.result);

            return {
              createWithoutMembership,
              listWithoutMembership,
              workspaceInviteWithoutWorkspace,
              projectInviteWithoutWorkspace,
            };
          }),
        ),
      );

      assertTrue(result.createWithoutMembership._tag === "Failure");
      assertTrue(result.createWithoutMembership.failure._tag === "CollaborationError");
      assertInclude(
        result.createWithoutMembership.failure.message,
        "Forbidden: authenticated session does not have workspace.invite.",
      );
      assertTrue(result.listWithoutMembership._tag === "Failure");
      assertTrue(result.listWithoutMembership.failure._tag === "CollaborationError");
      assertInclude(
        result.listWithoutMembership.failure.message,
        "Forbidden: authenticated session does not have workspace.invite.",
      );
      assertTrue(result.workspaceInviteWithoutWorkspace._tag === "Failure");
      assertTrue(result.workspaceInviteWithoutWorkspace.failure._tag === "CollaborationError");
      assertInclude(
        result.workspaceInviteWithoutWorkspace.failure.message,
        "Workspace-scoped collaboration invites must include a workspace.",
      );
      assertTrue(result.projectInviteWithoutWorkspace._tag === "Failure");
      assertTrue(result.projectInviteWithoutWorkspace.failure._tag === "CollaborationError");
      assertInclude(
        result.projectInviteWithoutWorkspace.failure.message,
        "Workspace-scoped collaboration invites must include a workspace.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("revokes collaboration invites and blocks revoked invite acceptance", () =>
    Effect.gen(function* () {
      // Invite acceptance now requires a durable identity, so the revoked
      // invite is exercised by a Supabase-authenticated member instead of the
      // anonymous owner session.
      const fixture = makeSignedSupabaseFixture();
      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseAnonKey: "public-anon-key",
          supabaseJwtAudience: "authenticated",
        },
      });

      const workspaceId = WorkspaceId.make("workspace-revoke-invite-collab");
      const wsUrl = yield* getWsServerUrl("/ws");
      const expiresAt = new Date(Date.now() + 60_000).toISOString();

      const setup = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const organization = yield* client[WS_METHODS.organizationsCreate]({
              slug: "revoke-invite-collab",
              displayName: "Revoke Invite Collab",
            });
            const createdInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
              tenantId: organization.tenant.id,
              workspaceId,
              email: "member@example.test",
              scope: "workspace",
              roles: ["developer"],
              expiresAt,
            });
            const revokedInvite = yield* client[WS_METHODS.collaborationInvitesRevoke]({
              tenantId: organization.tenant.id,
              inviteId: createdInvite.invite.id,
            });
            return {
              organization,
              createdInvite,
              revokedInvite,
            };
          }),
        ),
      );

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      const acceptRevokedInvite = yield* Effect.scoped(
        withWsRpcClient(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          (client) =>
            client[WS_METHODS.collaborationInvitesAccept]({
              inviteId: setup.createdInvite.invite.id,
            }).pipe(Effect.result),
          {
            headers: {
              authorization: `Bearer ${fixture.jwt}`,
            },
          },
        ),
      ).pipe(Effect.ensuring(Effect.sync(() => fetchSpy.mockRestore())));

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const listedInvites = yield* client[WS_METHODS.collaborationInvitesList]({
              tenantId: setup.organization.tenant.id,
              workspaceId,
            });
            const activity = yield* client[WS_METHODS.collaborationActivityList]({
              tenantId: setup.organization.tenant.id,
              workspaceId,
              limit: 10,
            });

            return {
              createdInvite: setup.createdInvite,
              revokedInvite: setup.revokedInvite,
              acceptRevokedInvite,
              listedInvites,
              activity,
            };
          }),
        ),
      );

      assert.equal(result.revokedInvite.invite.id, result.createdInvite.invite.id);
      assertTrue(result.revokedInvite.invite.revokedAt !== null);
      assert.equal(
        result.listedInvites.invites[0]?.revokedAt,
        result.revokedInvite.invite.revokedAt,
      );
      assertTrue(result.acceptRevokedInvite._tag === "Failure");
      assertTrue(result.acceptRevokedInvite.failure._tag === "CollaborationError");
      assertInclude(
        result.acceptRevokedInvite.failure.message,
        "Collaboration invite has been revoked.",
      );
      assert.isTrue(
        result.activity.activities.some((activity) => activity.kind === "revoked-invite"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "lets a paired member accept a workspace invite and share presence and prompts with the owner",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            localPasswordAuth: true,
          },
        });

        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const ownerProfileUrl = yield* getHttpServerUrl("/api/auth/profile");
        const ownerProfileResponse = yield* Effect.promise(() =>
          fetch(ownerProfileUrl, {
            method: "PATCH",
            headers: {
              cookie: ownerCookie,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              displayName: "Updated Collab Owner",
              avatarInitials: "UO",
            }),
          }),
        );
        assert.equal(ownerProfileResponse.status, 200);

        const ownerWsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          ownerCookie,
        );
        const workspaceId = WorkspaceId.make("workspace-two-user-collab");
        const threadId = ThreadId.make("thread-two-user-collab");
        const expiresAt = new Date(Date.now() + 60_000).toISOString();

        const setup = yield* Effect.scoped(
          withWsRpcClient(ownerWsUrl, (client) =>
            Effect.gen(function* () {
              const organization = yield* client[WS_METHODS.organizationsCreate]({
                slug: "two-user-collab",
                displayName: "Two User Collab",
              });
              const team = yield* client[WS_METHODS.organizationTeamsCreate]({
                organizationId: organization.organization.id,
                slug: "platform",
                displayName: "Platform",
              });
              const invite = yield* client[WS_METHODS.collaborationInvitesCreate]({
                tenantId: organization.tenant.id,
                workspaceId,
                email: "member@example.com",
                scope: "workspace",
                roles: ["developer"],
                expiresAt,
              });
              return {
                organization,
                team,
                invite,
              };
            }),
          ),
        );

        // Anonymous paired-client sessions can no longer accept invites, so the
        // paired teammate signs in with a durable local account before pairing
        // its browser session to the workspace invite.
        const memberCookie = yield* signUpLocalMemberSessionCookie({
          email: "member@example.com",
          displayName: "Teammate Browser",
        });
        const memberWsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          memberCookie,
        );

        const memberResult = yield* Effect.scoped(
          withWsRpcClient(memberWsUrl, (client) =>
            Effect.gen(function* () {
              const accepted = yield* client[WS_METHODS.collaborationInvitesAccept]({
                inviteId: setup.invite.invite.id,
              });
              const presence = yield* client[WS_METHODS.collaborationPresenceUpsert]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
                status: "active",
              });
              const promptActivity = yield* client[WS_METHODS.collaborationSharedPromptRecord]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
                prompt: "Member prompt from the shared workspace.",
              });
              return {
                accepted,
                presence,
                promptActivity,
              };
            }),
          ),
        );

        const ownerResult = yield* Effect.scoped(
          withWsRpcClient(ownerWsUrl, (client) =>
            Effect.gen(function* () {
              yield* client[WS_METHODS.collaborationPresenceUpsert]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
                status: "active",
              });
              const ownerPrompt = yield* client[WS_METHODS.collaborationSharedPromptRecord]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
                prompt: "Owner prompt from the shared workspace.",
              });
              const presence = yield* client[WS_METHODS.collaborationPresenceList]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
              });
              const activity = yield* client[WS_METHODS.collaborationActivityList]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                threadId,
                limit: 20,
              });
              return {
                ownerPrompt,
                presence,
                activity,
              };
            }),
          ),
        );

        assert.equal(setup.team.team.slug, "platform");
        assert.include(setup.invite.acceptUrlPath, encodeURIComponent(setup.invite.invite.id));
        assert.equal(memberResult.accepted.membership.roles[0], "developer");
        assert.equal(memberResult.presence.presence.displayName, "Teammate Browser");
        assert.equal(memberResult.promptActivity.activity.kind, "prompted");
        assert.equal(ownerResult.ownerPrompt.activity.kind, "prompted");
        assert.isTrue(
          ownerResult.presence.users.some((user) => user.displayName === "Teammate Browser"),
        );
        assert.isTrue(
          ownerResult.presence.users.some(
            (user) => user.userId === ownerResult.ownerPrompt.activity.userId,
          ),
        );
        assert.isTrue(
          ownerResult.presence.users.some(
            (user) => user.displayName === "Updated Collab Owner" && user.avatarInitials === "UO",
          ),
        );
        assert.isTrue(
          ownerResult.activity.activities.some((activity) =>
            activity.summary.includes("Teammate Browser shared a prompt"),
          ),
        );
        assert.isTrue(
          ownerResult.activity.activities.some(
            (activity) =>
              activity.userId === ownerResult.ownerPrompt.activity.userId &&
              activity.kind === "prompted",
          ),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "stores websocket thread favorites as user preferences without dispatching shared metadata",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: OrchestrationCommand[] = [];
        const threadShell = makeDefaultOrchestrationThreadShell({
          id: defaultThreadId,
          favorite: false,
        });
        const readModel = {
          ...makeDefaultOrchestrationReadModel(),
          snapshotSequence: 42,
        };

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              getReadModel: () => Effect.succeed(readModel),
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: readModel.snapshotSequence + dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: (threadId) =>
                Effect.succeed(
                  threadId === defaultThreadId ? Option.some(threadShell) : Option.none(),
                ),
              getShellSnapshot: () =>
                Effect.succeed({
                  snapshotSequence: readModel.snapshotSequence,
                  projects: [],
                  threads: [threadShell],
                  updatedAt: new Date(0).toISOString(),
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const favoriteResult = yield* client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "thread.meta.update",
                commandId: CommandId.make("cmd-user-favorite"),
                threadId: defaultThreadId,
                favorite: true,
              });
              const shellEvents = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
                Stream.take(1),
                Stream.runCollect,
                Effect.map((events) => Array.from(events)),
              );
              return { favoriteResult, shellEvents };
            }),
          ),
        );

        assert.equal(result.favoriteResult.sequence, readModel.snapshotSequence);
        assert.deepEqual(dispatchedCommands, []);
        const snapshotEvent = result.shellEvents[0];
        assert.equal(snapshotEvent?.kind, "snapshot");
        assert.equal(
          snapshotEvent?.kind === "snapshot" ? snapshotEvent.snapshot.threads[0]?.favorite : false,
          true,
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exercises invite e2e server fixture with fresh browser members and revoked links",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: {
            localPasswordAuth: true,
          },
        });

        const runId = crypto.randomUUID();
        const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
        const ownerWsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          ownerCookie,
        );
        const workspaceId = WorkspaceId.make(`workspace-invite-e2e-${runId}`);
        const expiresAt = new Date(Date.now() + 60_000).toISOString();

        const setup = yield* Effect.scoped(
          withWsRpcClient(ownerWsUrl, (client) =>
            Effect.gen(function* () {
              const organization = yield* client[WS_METHODS.organizationsCreate]({
                slug: `invite-e2e-${runId}`,
                displayName: "Invite E2E Fixture",
              });
              const acceptedInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
                tenantId: organization.tenant.id,
                workspaceId,
                email: `fresh-${runId}@example.test`,
                scope: "workspace",
                roles: ["developer"],
                expiresAt,
              });
              const revokedInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
                tenantId: organization.tenant.id,
                workspaceId,
                email: `revoked-${runId}@example.test`,
                scope: "workspace",
                roles: ["viewer"],
                expiresAt,
              });
              const adminRevoked = yield* client[WS_METHODS.collaborationInvitesRevoke]({
                tenantId: organization.tenant.id,
                inviteId: revokedInvite.invite.id,
              });
              return {
                organization,
                acceptedInvite,
                adminRevoked,
              };
            }),
          ),
        );

        // Fresh browser members need a durable identity to accept invites, so
        // the member signs up with a local account instead of an anonymous
        // paired-client credential.
        const freshMemberCookie = yield* signUpLocalMemberSessionCookie({
          email: `fresh-${runId}@example.test`,
          displayName: `Fresh Invite Browser ${runId}`,
        });
        const freshMemberWsUrl = appendSessionCookieToWsUrl(
          yield* getWsServerUrl("/ws", { authenticated: false }),
          freshMemberCookie,
        );
        const freshMemberResult = yield* Effect.scoped(
          withWsRpcClient(freshMemberWsUrl, (client) =>
            Effect.gen(function* () {
              const firstAccept = yield* client[WS_METHODS.collaborationInvitesAccept]({
                inviteId: setup.acceptedInvite.invite.id,
              });
              const returningAccept = yield* client[WS_METHODS.collaborationInvitesAccept]({
                inviteId: setup.acceptedInvite.invite.id,
              }).pipe(Effect.result);
              const revokedAccept = yield* client[WS_METHODS.collaborationInvitesAccept]({
                inviteId: setup.adminRevoked.invite.id,
              }).pipe(Effect.result);
              return {
                firstAccept,
                returningAccept,
                revokedAccept,
              };
            }),
          ),
        );

        const ownerResult = yield* Effect.scoped(
          withWsRpcClient(ownerWsUrl, (client) =>
            Effect.gen(function* () {
              const listedInvites = yield* client[WS_METHODS.collaborationInvitesList]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
              });
              const activity = yield* client[WS_METHODS.collaborationActivityList]({
                tenantId: setup.organization.tenant.id,
                workspaceId,
                limit: 20,
              });
              return {
                listedInvites,
                activity,
              };
            }),
          ),
        );

        assert.equal(freshMemberResult.firstAccept.membership.roles[0], "developer");
        assert.equal(freshMemberResult.firstAccept.invite.acceptedAt !== null, true);
        assertTrue(freshMemberResult.returningAccept._tag === "Failure");
        assertTrue(freshMemberResult.returningAccept.failure._tag === "CollaborationError");
        assertInclude(
          freshMemberResult.returningAccept.failure.message,
          "Collaboration invite has already been accepted.",
        );
        assertTrue(freshMemberResult.revokedAccept._tag === "Failure");
        assertTrue(freshMemberResult.revokedAccept.failure._tag === "CollaborationError");
        assertInclude(
          freshMemberResult.revokedAccept.failure.message,
          "Collaboration invite has been revoked.",
        );
        assert.equal(ownerResult.listedInvites.invites.length, 2);
        assert.isTrue(
          ownerResult.listedInvites.invites.some(
            (invite) => invite.id === setup.acceptedInvite.invite.id && invite.acceptedAt !== null,
          ),
        );
        assert.isTrue(
          ownerResult.listedInvites.invites.some(
            (invite) => invite.id === setup.adminRevoked.invite.id && invite.revokedAt !== null,
          ),
        );
        assert.isTrue(
          ownerResult.activity.activities.some((activity) => activity.kind === "accepted-invite"),
        );
        assert.isTrue(
          ownerResult.activity.activities.some((activity) => activity.kind === "revoked-invite"),
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("accepts invite links through the real browser route against the server fixture", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: {
          localPasswordAuth: true,
        },
      });

      const path = yield* Path.Path;
      const runId = crypto.randomUUID();
      const ownerCookie = yield* getAuthenticatedSessionCookieHeader();
      const ownerWsUrl = appendSessionCookieToWsUrl(
        yield* getWsServerUrl("/ws", { authenticated: false }),
        ownerCookie,
      );
      const serverHttpBaseUrl = yield* getHttpServerUrl("/");
      const serverWsBaseUrl = yield* getWsServerUrl("/", { authenticated: false });
      const workspaceId = WorkspaceId.make(`workspace-invite-route-e2e-${runId}`);
      const expiresAt = new Date(Date.now() + 60_000).toISOString();

      const setup = yield* Effect.scoped(
        withWsRpcClient(ownerWsUrl, (client) =>
          Effect.gen(function* () {
            const organization = yield* client[WS_METHODS.organizationsCreate]({
              slug: `invite-route-e2e-${runId}`,
              displayName: "Invite Route E2E Fixture",
            });
            const invite = yield* client[WS_METHODS.collaborationInvitesCreate]({
              tenantId: organization.tenant.id,
              workspaceId,
              email: `browser-route-${runId}@example.test`,
              scope: "workspace",
              roles: ["developer"],
              expiresAt,
            });
            const revokedInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
              tenantId: organization.tenant.id,
              workspaceId,
              email: `browser-route-revoked-${runId}@example.test`,
              scope: "workspace",
              roles: ["viewer"],
              expiresAt,
            });
            const adminUiInvite = yield* client[WS_METHODS.collaborationInvitesCreate]({
              tenantId: organization.tenant.id,
              workspaceId,
              email: `browser-route-admin-revoke-${runId}@example.test`,
              scope: "workspace",
              roles: ["developer"],
              expiresAt,
            });
            const adminRevoked = yield* client[WS_METHODS.collaborationInvitesRevoke]({
              tenantId: organization.tenant.id,
              inviteId: revokedInvite.invite.id,
            });
            return {
              organization,
              invite,
              adminUiInvite,
              adminRevoked,
            };
          }),
        ),
      );

      // Browser members need durable identities to accept invites through the
      // real /invite route, so each browser signs up with a local account
      // instead of exchanging an anonymous paired-client credential.
      const freshSessionCookie = yield* signUpLocalMemberSessionCookie({
        email: `browser-route-${runId}@example.test`,
        displayName: `Fresh Invite Browser ${runId}`,
      });
      const returningSessionCookie = yield* signUpLocalMemberSessionCookie({
        email: `browser-route-returning-${runId}@example.test`,
        displayName: `Returning Invite Browser ${runId}`,
      });
      const revokedSessionCookie = yield* signUpLocalMemberSessionCookie({
        email: `browser-route-revoked-member-${runId}@example.test`,
        displayName: `Revoked Invite Browser ${runId}`,
      });
      const webRoot = path.resolve(import.meta.dirname, "../../web");

      yield* Effect.promise(async () => {
        const originalViteHttpUrl = process.env.VITE_HTTP_URL;
        const originalViteWsUrl = process.env.VITE_WS_URL;
        const originalViteDevServerUrl = process.env.VITE_DEV_SERVER_URL;
        const originalPort = process.env.PORT;
        const originalHost = process.env.HOST;
        const originalCwd = process.cwd();
        const vitePort = await reserveTcpPort();
        const appUrl = `http://127.0.0.1:${vitePort}/`;
        process.env.VITE_HTTP_URL = serverHttpBaseUrl;
        process.env.VITE_WS_URL = serverWsBaseUrl;
        process.env.VITE_DEV_SERVER_URL = appUrl;
        process.env.PORT = String(vitePort);
        process.env.HOST = "127.0.0.1";

        const [{ createServer }, { chromium }] = await Promise.all([
          import("vite"),
          import("playwright"),
        ]);
        process.chdir(webRoot);
        const viteServer = await createServer({
          root: webRoot,
          configFile: path.join(webRoot, "vite.config.ts"),
          server: {
            host: "127.0.0.1",
            port: vitePort,
            strictPort: true,
          },
          clearScreen: false,
          logLevel: "error",
        });
        const browser = await chromium.launch({ headless: true });
        try {
          await viteServer.listen();

          await withCleanBrowserContext(browser, appUrl, freshSessionCookie, async (page) => {
            const pageMessages: string[] = [];
            page.on("console", (message) => {
              pageMessages.push(`${message.type()}: ${message.text()}`);
            });
            page.on("pageerror", (error) => {
              pageMessages.push(`pageerror: ${error.message}`);
            });
            await page.goto(
              `${appUrl}invite?invite=${encodeURIComponent(setup.invite.invite.id)}`,
              { waitUntil: "domcontentloaded" },
            );
            await page
              .getByText("Invite accepted")
              .waitFor({ timeout: 20_000 })
              .catch(async (error) => {
                const bodyText = await page
                  .locator("body")
                  .innerText()
                  .catch(() => "");
                throw new Error(
                  [
                    error instanceof Error ? error.message : String(error),
                    `url=${page.url()}`,
                    `body=${bodyText}`,
                    `console=${pageMessages.join(" | ")}`,
                  ].join("\n"),
                );
              });
            await page
              .getByText(
                `${setup.invite.invite.email} now has access. You can return to the workspace.`,
              )
              .waitFor({ timeout: 5_000 });
          });

          await withCleanBrowserContext(browser, appUrl, returningSessionCookie, async (page) => {
            await page.goto(
              `${appUrl}invite?invite=${encodeURIComponent(setup.invite.invite.id)}`,
              { waitUntil: "domcontentloaded" },
            );
            await page.getByText("Invite could not be accepted").waitFor({ timeout: 20_000 });
            await page
              .getByText("Collaboration invite has already been accepted.")
              .waitFor({ timeout: 5_000 });
          });

          await withCleanBrowserContext(browser, appUrl, revokedSessionCookie, async (page) => {
            await page.goto(
              `${appUrl}invite?invite=${encodeURIComponent(setup.adminRevoked.invite.id)}`,
              { waitUntil: "domcontentloaded" },
            );
            await page.getByText("Invite could not be accepted").waitFor({ timeout: 20_000 });
            await page
              .getByText("Collaboration invite has been revoked.")
              .waitFor({ timeout: 5_000 });
          });

          await withCleanBrowserContext(browser, appUrl, ownerCookie, async (page) => {
            const pageMessages: string[] = [];
            page.on("console", (message) => {
              pageMessages.push(`${message.type()}: ${message.text()}`);
            });
            page.on("pageerror", (error) => {
              pageMessages.push(`pageerror: ${error.message}`);
            });
            const revokeButton = page.getByRole("button", {
              name: `Revoke invite for ${setup.adminUiInvite.invite.email}`,
            });
            await page.goto(`${appUrl}settings/organization`, { waitUntil: "domcontentloaded" });
            await page
              .getByText(setup.adminUiInvite.invite.email)
              .waitFor({ timeout: 20_000 })
              .catch(async (error) => {
                const bodyText = await page
                  .locator("body")
                  .innerText()
                  .catch(() => "");
                throw new Error(
                  [
                    error instanceof Error ? error.message : String(error),
                    `url=${page.url()}`,
                    `body=${bodyText}`,
                    `console=${pageMessages.join(" | ")}`,
                  ].join("\n"),
                );
              });
            await revokeButton.click();
            await page
              .locator(
                `button[aria-label="Revoke invite for ${setup.adminUiInvite.invite.email}"]:disabled`,
              )
              .waitFor({ timeout: 20_000 });
          });
        } finally {
          await browser.close().catch(() => undefined);
          await viteServer.close().catch(() => undefined);
          restoreProcessEnvValue("VITE_HTTP_URL", originalViteHttpUrl);
          restoreProcessEnvValue("VITE_WS_URL", originalViteWsUrl);
          restoreProcessEnvValue("VITE_DEV_SERVER_URL", originalViteDevServerUrl);
          restoreProcessEnvValue("PORT", originalPort);
          restoreProcessEnvValue("HOST", originalHost);
          process.chdir(originalCwd);
        }
      });

      const ownerResult = yield* Effect.scoped(
        withWsRpcClient(ownerWsUrl, (client) =>
          Effect.gen(function* () {
            const listedInvites = yield* client[WS_METHODS.collaborationInvitesList]({
              tenantId: setup.organization.tenant.id,
              workspaceId,
            });
            const activity = yield* client[WS_METHODS.collaborationActivityList]({
              tenantId: setup.organization.tenant.id,
              workspaceId,
              limit: 20,
            });
            return {
              listedInvites,
              activity,
            };
          }),
        ),
      );

      assert.isTrue(
        ownerResult.listedInvites.invites.some(
          (invite) => invite.id === setup.invite.invite.id && invite.acceptedAt !== null,
        ),
      );
      assert.isTrue(
        ownerResult.listedInvites.invites.some(
          (invite) => invite.id === setup.adminRevoked.invite.id && invite.revokedAt !== null,
        ),
      );
      assert.isTrue(
        ownerResult.listedInvites.invites.some(
          (invite) => invite.id === setup.adminUiInvite.invite.id && invite.revokedAt !== null,
        ),
      );
      assert.isTrue(
        ownerResult.activity.activities.some((activity) => activity.kind === "accepted-invite"),
      );
      assert.isTrue(
        ownerResult.activity.activities.some((activity) => activity.kind === "revoked-invite"),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "exposes organization creation, employee lifecycle, scoped access, and audit over websocket rpc",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsUrl = yield* getWsServerUrl("/ws");
        const expiresAt = new Date(Date.now() + 60_000).toISOString();

        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            Effect.gen(function* () {
              const created = yield* client[WS_METHODS.organizationsCreate]({
                slug: "accessible-acme",
                displayName: "Accessible Acme",
              });
              const listedOrganizations = yield* client[WS_METHODS.organizationsList]({});
              const team = yield* client[WS_METHODS.organizationTeamsCreate]({
                organizationId: created.organization.id,
                slug: "platform",
                displayName: "Platform",
              });
              const department = yield* client[WS_METHODS.organizationDepartmentsCreate]({
                organizationId: created.organization.id,
                slug: "engineering",
                displayName: "Engineering",
              });
              const invited = yield* client[WS_METHODS.organizationEmployeesInvite]({
                organizationId: created.organization.id,
                tenantId: created.tenant.id,
                email: "engineer@example.com",
                displayName: "Engineer Example",
                roles: ["developer"],
                organizationRoles: ["manager"],
                teamIds: [team.team.id],
                departmentId: department.department.id,
                expiresAt,
              });
              const employeesAfterInvite = yield* client[WS_METHODS.organizationEmployeesList]({
                organizationId: created.organization.id,
              });
              const updated = yield* client[WS_METHODS.organizationEmployeesUpdate]({
                organizationId: created.organization.id,
                membershipId: invited.employee.membership.id,
                roles: ["pm"],
                organizationRoles: ["auditor"],
                teamIds: [team.team.id],
                departmentId: department.department.id,
              });
              const grant = yield* client[WS_METHODS.organizationAccessGrant]({
                organizationId: created.organization.id,
                membershipId: invited.employee.membership.id,
                scope: { type: "team", teamId: team.team.id },
                roles: ["pm"],
              });
              const revoked = yield* client[WS_METHODS.organizationAccessRevoke]({
                organizationId: created.organization.id,
                grantId: grant.grant.id,
              });
              const review = yield* client[WS_METHODS.organizationAccessReviewCreate]({
                organizationId: created.organization.id,
                membershipIds: [invited.employee.membership.id],
              });
              const disabled = yield* client[WS_METHODS.organizationEmployeesDisable]({
                organizationId: created.organization.id,
                membershipId: invited.employee.membership.id,
              });
              const audit = yield* client[WS_METHODS.organizationAuditList]({
                organizationId: created.organization.id,
                limit: 20,
              });

              return {
                created,
                listedOrganizations,
                team,
                department,
                invited,
                employeesAfterInvite,
                updated,
                grant,
                revoked,
                review,
                disabled,
                audit,
              };
            }),
          ),
        );

        assert.equal(result.created.organization.slug, "accessible-acme");
        assert.equal(result.created.tenant.kind, "corporate");
        assert.equal(result.created.ownerMembership.organizationRoles?.[0], "owner");
        assert.equal(result.listedOrganizations.organizations.length, 1);
        assert.equal(result.team.team.slug, "platform");
        assert.equal(result.department.department.slug, "engineering");
        assert.equal(result.invited.employee.status, "invited");
        assert.equal(result.employeesAfterInvite.employees.length, 2);
        assert.equal(result.updated.employee.membership.organizationRoles?.[0], "auditor");
        assert.equal(result.grant.grant.scope.type, "team");
        assert.equal(result.grant.grant.revokedAt, null);
        assert.equal(result.revoked.grant.id, result.grant.grant.id);
        assert.isNotNull(result.revoked.grant.revokedAt);
        assert.equal(result.review.review.status, "open");
        assert.equal(result.disabled.employee.status, "disabled");
        assert.isTrue(result.audit.events.some((event) => event.kind === "access-review-created"));
        assert.isTrue(result.audit.events.some((event) => event.kind === "access-revoked"));
        assert.isTrue(result.audit.events.some((event) => event.kind === "employee-disabled"));
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc subscribeServerConfig emits provider status updates", () =>
    Effect.gen(function* () {
      const nextProviders = [
        {
          provider: "codex" as const,
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-04-11T00:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
        },
      ] as const;

      yield* buildAppUnderTest({
        layers: {
          keybindings: {
            loadConfigState: Effect.succeed({
              keybindings: [],
              issues: [],
            }),
            streamChanges: Stream.empty,
          },
          providerRegistry: {
            getProviders: Effect.succeed([]),
            streamChanges: Stream.succeed(nextProviders),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const events = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.subscribeServerConfig]({}).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(events);
      assert.equal(first?.type, "snapshot");
      if (first?.type === "snapshot") {
        assert.deepEqual(first.config.providers, []);
      }
      assert.deepEqual(second, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: nextProviders },
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "routes websocket rpc subscribeServerLifecycle replays snapshot and streams updates",
    () =>
      Effect.gen(function* () {
        const lifecycleEvents = [
          {
            version: 1 as const,
            sequence: 1,
            type: "welcome" as const,
            payload: {
              environment: testEnvironmentDescriptor,
              cwd: "/tmp/project",
              projectName: "project",
            },
          },
        ] as const;
        const liveEvents = Stream.make({
          version: 1 as const,
          sequence: 2,
          type: "ready" as const,
          payload: { at: new Date().toISOString(), environment: testEnvironmentDescriptor },
        });

        yield* buildAppUnderTest({
          layers: {
            serverLifecycleEvents: {
              snapshot: Effect.succeed({
                sequence: 1,
                events: lifecycleEvents,
              }),
              stream: liveEvents,
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const events = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.subscribeServerLifecycle]({}).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(events);
        assert.equal(first?.type, "welcome");
        assert.equal(first?.sequence, 1);
        assert.equal(second?.type, "ready");
        assert.equal(second?.sequence, 2);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-search-" });
      yield* fs.writeFileString(
        path.join(workspaceDir, "needle-file.ts"),
        "export const needle = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(makeReadModelWithWorkspaceRoot(workspaceDir)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "needle",
            limit: 10,
          }),
        ),
      );

      assert.isAtLeast(response.entries.length, 1);
      assert.isTrue(response.entries.some((entry) => entry.path === "needle-file.ts"));
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries excludes gitignored files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-ws-project-search-gitignored-",
      });
      yield* fs.writeFileString(path.join(workspaceDir, ".gitignore"), ".venv/\n");
      yield* fs.makeDirectory(path.join(workspaceDir, ".venv", "lib"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, ".venv", "lib", "ignored-search-target.ts"),
        "export const ignored = true;",
      );
      yield* fs.makeDirectory(path.join(workspaceDir, "src"), { recursive: true });
      yield* fs.writeFileString(
        path.join(workspaceDir, "src", "tracked.ts"),
        "export const ok = 1;",
      );

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(makeReadModelWithWorkspaceRoot(workspaceDir)),
          },
          gitCore: {
            isInsideWorkTree: () => Effect.succeed(true),
            listWorkspaceFiles: () =>
              Effect.succeed({
                paths: ["src/tracked.ts"],
                truncated: false,
              }),
            filterIgnoredPaths: (_cwd, relativePaths) =>
              Effect.succeed(
                relativePaths.filter((relativePath) => !relativePath.startsWith(".venv/")),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: workspaceDir,
            query: "ignored-search-target",
            limit: 10,
          }),
        ),
      );

      assert.equal(response.entries.length, 0);
      assert.equal(response.truncated, false);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.searchEntries errors", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsSearchEntries]({
            cwd: "/definitely/not/a/real/workspace/path",
            query: "needle",
            limit: 10,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectSearchEntriesError");
      assertInclude(
        result.failure.message,
        "Forbidden: authenticated session does not have project.view.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(makeReadModelWithWorkspaceRoot(workspaceDir)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "nested/created.txt",
            contents: "written-by-rpc",
          }),
        ),
      );

      assert.equal(response.relativePath, "nested/created.txt");
      const persisted = yield* fs.readFileString(path.join(workspaceDir, "nested", "created.txt"));
      assert.equal(persisted, "written-by-rpc");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("creates a missing workspace root during websocket project.create dispatch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const parentDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-create-" });
      const missingWorkspaceRoot = path.join(parentDir, "nested", "new-project");

      yield* buildAppUnderTest();

      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "project.create",
            commandId: CommandId.make("cmd-project-create-missing-root"),
            projectId: ProjectId.make("project-create-missing-root"),
            title: "New Project",
            workspaceRoot: missingWorkspaceRoot,
            createWorkspaceRootIfMissing: true,
            defaultModelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            createdAt: new Date().toISOString(),
          }),
        ),
      );
      const stat = yield* fs.stat(missingWorkspaceRoot);

      assert.isAtLeast(response.sequence, 0);
      assert.equal(stat.type, "Directory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("populates project ownership metadata from Supabase tenant workspace context", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-project-create-owned-",
      });
      const organizationId = OrganizationId.make("org-supabase-owned-project");
      const tenantId = TenantId.make("tenant-supabase-owned-project");
      const workspaceId = WorkspaceId.make("workspace-supabase-owned-project");
      const membershipId = MembershipId.make("membership-supabase-owned-project");
      const capturedCommands: OrchestrationCommand[] = [];
      let capturedRepository: TenancyRepositoryShape | undefined;
      const fixture = makeSignedSupabaseFixture({
        app_metadata: {
          provider: "email",
          tenant_id: tenantId,
          active_workspace_id: workspaceId,
        },
        user_metadata: { full_name: "Owned Project User" },
      });

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) =>
          Effect.gen(function* () {
            capturedRepository = repository;
            yield* repository.saveOrganizations({
              organizations: [
                {
                  id: organizationId,
                  slug: "owned-project",
                  displayName: "Owned Project Org",
                  createdAt: "2026-05-09T00:00:00.000Z",
                  archivedAt: null,
                },
              ],
              tenants: [
                {
                  id: tenantId,
                  slug: "owned-project",
                  displayName: "Owned Project Tenant",
                  kind: "corporate",
                  organizationId,
                  runtimeId: TenantRuntimeId.make("runtime-supabase-owned-project"),
                  createdAt: "2026-05-09T00:00:00.000Z",
                  archivedAt: null,
                },
              ],
              memberships: [
                {
                  id: membershipId,
                  tenantId,
                  userId: supabaseUserId,
                  organizationId,
                  roles: ["developer"],
                  organizationRoles: ["developer"],
                  createdAt: "2026-05-09T00:00:00.000Z",
                  disabledAt: null,
                },
              ],
              employees: [
                {
                  membership: {
                    id: membershipId,
                    tenantId,
                    userId: supabaseUserId,
                    organizationId,
                    roles: ["developer"],
                    organizationRoles: ["developer"],
                    createdAt: "2026-05-09T00:00:00.000Z",
                    disabledAt: null,
                  },
                  email: "owned-project@example.com",
                  displayName: "Owned Project Employee",
                  status: "active",
                },
              ],
              invites: [],
              teams: [],
              departments: [],
              grants: [],
              reviews: [],
              auditEvents: [],
            });
            yield* repository.saveCollaboration({
              presence: [],
              invites: [],
              memberships: [],
              activities: [],
            });
            yield* repository.saveWorkspaces({
              workspaces: [
                {
                  id: workspaceId,
                  tenantId,
                  organizationId,
                  ownerUserId: supabaseUserId,
                  kind: "corporate",
                  accessMode: "organization",
                  title: "Renamed Hosted Workspace",
                  createdAt: "2026-05-08T00:00:00.000Z",
                  archivedAt: null,
                },
              ],
            });
          }).pipe(Effect.orDie),
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                capturedCommands.push(command);
                return { sequence: capturedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const response = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("cmd-supabase-project-create-owned"),
                projectId: ProjectId.make("project-supabase-owned"),
                title: "Owned Workspace",
                workspaceRoot: path.join(workspaceRoot, "owned"),
                createWorkspaceRootIfMissing: true,
                defaultModelSelection,
                createdAt: "2026-05-09T00:01:00.000Z",
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(response.sequence, 1);
        const command = capturedCommands[0];
        assert.equal(command?.type, "project.create");
        assert.deepEqual(command && command.type === "project.create" ? command.ownership : null, {
          tenantId,
          tenantDisplayName: "Owned Project Tenant",
          workspaceId,
          workspaceTitle: "Renamed Hosted Workspace",
          organizationId,
          organizationDisplayName: "Owned Project Org",
          ownerUserId: supabaseUserId,
          ownerDisplayName: "Owned Project Employee",
        });
        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const workspaces = yield* capturedRepository.loadWorkspaces();
        assert.equal(workspaces.workspaces[0]?.title, "Renamed Hosted Workspace");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("persists missing hosted workspace metadata after project creation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-project-create-workspace-persist-",
      });
      const tenantId = TenantId.make("tenant-supabase-workspace-persist");
      const workspaceId = WorkspaceId.make("workspace-supabase-workspace-persist");
      const membership = makeSupabaseMembership({ tenantId });
      const capturedCommands: OrchestrationCommand[] = [];
      let capturedRepository: TenancyRepositoryShape | undefined;
      const fixture = makeSignedSupabaseFixture({
        app_metadata: {
          provider: "email",
          tenant_id: tenantId,
          active_workspace_id: workspaceId,
        },
      });

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return Effect.all(
            [
              repository.saveOrganizations({
                organizations: [],
                tenants: [
                  {
                    id: tenantId,
                    slug: "workspace-persist",
                    displayName: "Workspace Persist Tenant",
                    kind: "personal",
                    organizationId: null,
                    runtimeId: TenantRuntimeId.make("runtime-supabase-workspace-persist"),
                    createdAt: "2026-05-09T00:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                memberships: [],
                employees: [],
                invites: [],
                teams: [],
                departments: [],
                grants: [],
                reviews: [],
                auditEvents: [],
              }),
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [membership],
                activities: [],
              }),
              repository.saveWorkspaces({ workspaces: [] }),
            ],
            { discard: true },
          ).pipe(Effect.orDie);
        },
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                capturedCommands.push(command);
                return { sequence: capturedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        const response = yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("cmd-supabase-workspace-persist"),
                projectId: ProjectId.make("project-supabase-workspace-persist"),
                title: "Fresh Hosted Workspace",
                workspaceRoot: path.join(workspaceRoot, "fresh"),
                createWorkspaceRootIfMissing: true,
                defaultModelSelection,
                createdAt: "2026-05-09T00:02:00.000Z",
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        assert.equal(response.sequence, 1);
        const command = capturedCommands[0];
        assert.equal(command?.type, "project.create");
        assert.equal(
          command && command.type === "project.create" ? command.ownership?.workspaceTitle : null,
          "Fresh Hosted Workspace",
        );
        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const workspaces = yield* capturedRepository.loadWorkspaces();
        assert.equal(workspaces.workspaces[0]?.id, workspaceId);
        assert.equal(workspaces.workspaces[0]?.tenantId, tenantId);
        assert.equal(workspaces.workspaces[0]?.title, "Fresh Hosted Workspace");
        assert.equal(workspaces.workspaces[0]?.accessMode, "private");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("falls back to project title for archived hosted workspace metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-supabase-project-create-archived-workspace-",
      });
      const tenantId = TenantId.make("tenant-supabase-archived-workspace");
      const workspaceId = WorkspaceId.make("workspace-supabase-archived-workspace");
      const membership = makeSupabaseMembership({ tenantId });
      const capturedCommands: OrchestrationCommand[] = [];
      let capturedRepository: TenancyRepositoryShape | undefined;
      const fixture = makeSignedSupabaseFixture({
        app_metadata: {
          provider: "email",
          tenant_id: tenantId,
          active_workspace_id: workspaceId,
        },
      });

      yield* buildAppUnderTest({
        config: {
          supabaseProjectUrl: new URL(supabaseProjectUrl),
          supabaseJwtAudience: "authenticated",
        },
        seedTenancy: (repository) => {
          capturedRepository = repository;
          return Effect.all(
            [
              repository.saveOrganizations({
                organizations: [],
                tenants: [
                  {
                    id: tenantId,
                    slug: "archived-workspace",
                    displayName: "Archived Workspace Tenant",
                    kind: "personal",
                    organizationId: null,
                    runtimeId: TenantRuntimeId.make("runtime-supabase-archived-workspace"),
                    createdAt: "2026-05-09T00:00:00.000Z",
                    archivedAt: null,
                  },
                ],
                memberships: [],
                employees: [],
                invites: [],
                teams: [],
                departments: [],
                grants: [],
                reviews: [],
                auditEvents: [],
              }),
              repository.saveCollaboration({
                presence: [],
                invites: [],
                memberships: [membership],
                activities: [],
              }),
              repository.saveWorkspaces({
                workspaces: [
                  {
                    id: workspaceId,
                    tenantId,
                    organizationId: null,
                    ownerUserId: supabaseUserId,
                    kind: "personal",
                    accessMode: "private",
                    title: "Archived Workspace Name",
                    createdAt: "2026-05-08T00:00:00.000Z",
                    archivedAt: "2026-05-08T12:00:00.000Z",
                  },
                ],
              }),
            ],
            { discard: true },
          ).pipe(Effect.orDie);
        },
        layers: {
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                capturedCommands.push(command);
                return { sequence: capturedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const fetchSpy = mockSupabaseJwksFetch(fixture.jwks);
      try {
        const wsUrl = yield* getWsServerUrl("/ws", { authenticated: false });
        yield* Effect.scoped(
          withWsRpcClient(
            wsUrl,
            (client) =>
              client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
                type: "project.create",
                commandId: CommandId.make("cmd-supabase-archived-workspace"),
                projectId: ProjectId.make("project-supabase-archived-workspace"),
                title: "Replacement Workspace Title",
                workspaceRoot: path.join(workspaceRoot, "archived"),
                createWorkspaceRootIfMissing: true,
                defaultModelSelection,
                createdAt: "2026-05-09T00:03:00.000Z",
              }),
            {
              headers: {
                authorization: `Bearer ${fixture.jwt}`,
              },
            },
          ),
        );

        const command = capturedCommands[0];
        assert.equal(command?.type, "project.create");
        assert.equal(
          command && command.type === "project.create" ? command.ownership?.workspaceTitle : null,
          "Replacement Workspace Title",
        );
        if (!capturedRepository) {
          throw new Error("Tenancy repository was not captured.");
        }
        const workspaces = yield* capturedRepository.loadWorkspaces();
        assert.equal(workspaces.workspaces[0]?.title, "Archived Workspace Name");
        assert.equal(workspaces.workspaces[0]?.archivedAt, "2026-05-08T12:00:00.000Z");
      } finally {
        fetchSpy.mockRestore();
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc projects.writeFile errors", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const workspaceDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-ws-project-write-" });

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            getReadModel: () => Effect.succeed(makeReadModelWithWorkspaceRoot(workspaceDir)),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.projectsWriteFile]({
            cwd: workspaceDir,
            relativePath: "../escape.txt",
            contents: "nope",
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "ProjectWriteFileError");
      assert.equal(
        result.failure.message,
        "Workspace file path must stay within the project root.",
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor", () =>
    Effect.gen(function* () {
      let openedInput: { cwd: string; editor: EditorId } | null = null;
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: (input) =>
              Effect.sync(() => {
                openedInput = input;
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ),
      );

      assert.deepEqual(openedInput, { cwd: "/tmp/project", editor: "cursor" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc shell.openInEditor errors", () =>
    Effect.gen(function* () {
      const openError = new OpenError({ message: "Editor command not found: cursor" });
      yield* buildAppUnderTest({
        layers: {
          open: {
            openInEditor: () => Effect.fail(openError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.shellOpenInEditor]({
            cwd: "/tmp/project",
            editor: "cursor",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, openError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git methods", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            invalidateStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.succeed({
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            status: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
                hasUpstream: true,
                aheadCount: 0,
                behindCount: 0,
                pr: null,
              }),
            runStackedAction: (input, options) =>
              Effect.gen(function* () {
                const result = {
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                };

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "phase_started",
                    phase: "commit",
                    label: "Committing...",
                  }) ?? Effect.void
                );

                yield* (
                  options?.progressReporter?.publish({
                    actionId: options.actionId ?? input.actionId,
                    cwd: input.cwd,
                    action: input.action,
                    kind: "action_finished",
                    result,
                  }) ?? Effect.void
                );

                return result;
              }),
            resolvePullRequest: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
              }),
            preparePullRequestThread: () =>
              Effect.succeed({
                pullRequest: {
                  number: 1,
                  title: "Demo PR",
                  url: "https://example.com/pr/1",
                  baseBranch: "main",
                  headBranch: "feature/demo",
                  state: "open",
                },
                branch: "feature/demo",
                worktreePath: null,
              }),
          },
          gitCore: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled",
                branch: "main",
                upstreamBranch: "origin/main",
              }),
            listBranches: () =>
              Effect.succeed({
                branches: [
                  {
                    name: "main",
                    current: true,
                    isDefault: true,
                    worktreePath: null,
                  },
                ],
                isRepo: true,
                hasOriginRemote: true,
                nextCursor: null,
                totalCount: 1,
              }),
            createWorktree: () =>
              Effect.succeed({
                worktree: { path: "/tmp/wt", branch: "feature/demo" },
              }),
            removeWorktree: () => Effect.void,
            createBranch: (input) => Effect.succeed({ branch: input.branch }),
            checkoutBranch: (input) => Effect.succeed({ branch: input.branch }),
            initRepo: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const pull = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })),
      );
      assert.equal(pull.status, "pulled");

      const refreshedStatus = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRefreshStatus]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(refreshedStatus.isRepo, true);

      const stackedEvents = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(
            Stream.runCollect,
            Effect.map((events) => Array.from(events)),
          ),
        ),
      );
      const lastStackedEvent = stackedEvents.at(-1);
      assert.equal(lastStackedEvent?.kind, "action_finished");
      if (lastStackedEvent?.kind === "action_finished") {
        assert.equal(lastStackedEvent.result.action, "commit");
      }

      const resolvedPr = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitResolvePullRequest]({
            cwd: "/tmp/repo",
            reference: "1",
          }),
        ),
      );
      assert.equal(resolvedPr.pullRequest.number, 1);

      const prepared = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitPreparePullRequestThread]({
            cwd: "/tmp/repo",
            reference: "1",
            mode: "local",
          }),
        ),
      );
      assert.equal(prepared.branch, "feature/demo");

      const branches = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitListBranches]({ cwd: "/tmp/repo" }),
        ),
      );
      assert.equal(branches.branches[0]?.name, "main");

      const worktree = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateWorktree]({
            cwd: "/tmp/repo",
            branch: "main",
            path: null,
          }),
        ),
      );
      assert.equal(worktree.worktree.branch, "feature/demo");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRemoveWorktree]({
            cwd: "/tmp/repo",
            path: "/tmp/wt",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCreateBranch]({
            cwd: "/tmp/repo",
            branch: "feature/new",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitCheckout]({
            cwd: "/tmp/repo",
            branch: "main",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitInit]({
            cwd: "/tmp/repo",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.pull errors", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "pull",
        command: "git pull --ff-only",
        cwd: "/tmp/repo",
        detail: "upstream missing",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            pullCurrentBranch: () => Effect.fail(gitError),
          },
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasOriginRemote: true,
                  isDefaultBranch: true,
                  branch: "main",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })).pipe(
          Effect.result,
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc git.runStackedAction errors after refreshing git status", () =>
    Effect.gen(function* () {
      const gitError = new GitCommandError({
        operation: "commit",
        command: "git commit",
        cwd: "/tmp/repo",
        detail: "nothing to commit",
      });
      let invalidationCalls = 0;
      let statusCalls = 0;
      yield* buildAppUnderTest({
        layers: {
          gitManager: {
            invalidateLocalStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateRemoteStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            invalidateStatus: () =>
              Effect.sync(() => {
                invalidationCalls += 1;
              }),
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: false,
                branch: "feature/demo",
                hasWorkingTreeChanges: true,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            status: () =>
              Effect.sync(() => {
                statusCalls += 1;
                return {
                  isRepo: true,
                  hasOriginRemote: true,
                  isDefaultBranch: false,
                  branch: "feature/demo",
                  hasWorkingTreeChanges: true,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                };
              }),
            runStackedAction: () => Effect.fail(gitError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.gitRunStackedAction]({
            actionId: "action-1",
            cwd: "/tmp/repo",
            action: "commit",
          }).pipe(Stream.runCollect, Effect.result),
        ),
      );

      assertFailure(result, gitError);
      assert.equal(invalidationCalls, 0);
      assert.equal(statusCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("completes websocket rpc git.pull before background git status refresh finishes", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            pullCurrentBranch: () =>
              Effect.succeed({
                status: "pulled" as const,
                branch: "main",
                upstreamBranch: "origin/main",
              }),
          },
          gitManager: {
            invalidateLocalStatus: () => Effect.void,
            invalidateRemoteStatus: () => Effect.void,
            localStatus: () =>
              Effect.succeed({
                isRepo: true,
                hasOriginRemote: true,
                isDefaultBranch: true,
                branch: "main",
                hasWorkingTreeChanges: false,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              }),
            remoteStatus: () =>
              Effect.sleep(Duration.seconds(2)).pipe(
                Effect.as({
                  hasUpstream: true,
                  aheadCount: 0,
                  behindCount: 0,
                  pr: null,
                }),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const startedAt = Date.now();
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.gitPull]({ cwd: "/tmp/repo" })),
      );
      const elapsedMs = Date.now() - startedAt;

      assert.equal(result.status, "pulled");
      assertTrue(elapsedMs < 1_000);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "completes websocket rpc git.runStackedAction before background git status refresh finishes",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          layers: {
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              localStatus: () =>
                Effect.succeed({
                  isRepo: true,
                  hasOriginRemote: true,
                  isDefaultBranch: false,
                  branch: "feature/demo",
                  hasWorkingTreeChanges: false,
                  workingTree: { files: [], insertions: 0, deletions: 0 },
                }),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const startedAt = Date.now();
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );
        const elapsedMs = Date.now() - startedAt;

        assertTrue(elapsedMs < 1_000);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "starts a background local git status refresh after a successful git.runStackedAction",
    () =>
      Effect.gen(function* () {
        const localRefreshStarted = yield* Deferred.make<void>();

        yield* buildAppUnderTest({
          layers: {
            gitManager: {
              invalidateLocalStatus: () => Effect.void,
              invalidateRemoteStatus: () => Effect.void,
              localStatus: () =>
                Deferred.succeed(localRefreshStarted, undefined).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.succeed({
                      isRepo: true,
                      hasOriginRemote: true,
                      isDefaultBranch: false,
                      branch: "feature/demo",
                      hasWorkingTreeChanges: false,
                      workingTree: { files: [], insertions: 0, deletions: 0 },
                    }),
                  ),
                ),
              remoteStatus: () =>
                Effect.sleep(Duration.seconds(2)).pipe(
                  Effect.as({
                    hasUpstream: true,
                    aheadCount: 0,
                    behindCount: 0,
                    pr: null,
                  }),
                ),
              runStackedAction: () =>
                Effect.succeed({
                  action: "commit" as const,
                  branch: { status: "skipped_not_requested" as const },
                  commit: {
                    status: "created" as const,
                    commitSha: "abc123",
                    subject: "feat: demo",
                  },
                  push: { status: "skipped_not_requested" as const },
                  pr: { status: "skipped_not_requested" as const },
                  toast: {
                    title: "Committed abc123",
                    description: "feat: demo",
                    cta: {
                      kind: "run_action" as const,
                      label: "Push",
                      action: {
                        kind: "push" as const,
                      },
                    },
                  },
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[WS_METHODS.gitRunStackedAction]({
              actionId: "action-1",
              cwd: "/tmp/repo",
              action: "commit",
            }).pipe(Stream.runCollect),
          ),
        );

        yield* Deferred.await(localRefreshStarted);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc orchestration methods", () =>
    Effect.gen(function* () {
      const now = new Date().toISOString();
      const snapshot = {
        snapshotSequence: 1,
        updatedAt: now,
        projects: [
          {
            id: ProjectId.make("project-a"),
            title: "Project A",
            workspaceRoot: "/tmp/project-a",
            defaultModelSelection,
            scripts: [],
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
          },
        ],
        threads: [
          {
            id: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "Thread A",
            modelSelection: defaultModelSelection,
            interactionMode: "default" as const,
            runtimeMode: "full-access" as const,
            branch: null,
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            latestTurn: null,
            messages: [],
            session: null,
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            deletedAt: null,
          },
        ],
      };

      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getSnapshot: () => Effect.succeed(snapshot),
          },
          orchestrationEngine: {
            dispatch: () => Effect.succeed({ sequence: 7 }),
            readEvents: () => Stream.empty,
          },
          checkpointDiffQuery: {
            getTurnDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "turn-diff",
              }),
            getFullThreadDiff: () =>
              Effect.succeed({
                threadId: ThreadId.make("thread-1"),
                fromTurnCount: 0,
                toTurnCount: 1,
                diff: "full-diff",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.session.stop",
            commandId: CommandId.make("cmd-1"),
            threadId: ThreadId.make("thread-1"),
            createdAt: now,
          }),
        ),
      );
      assert.equal(dispatchResult.sequence, 7);

      const turnDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getTurnDiff]({
            threadId: ThreadId.make("thread-1"),
            fromTurnCount: 0,
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(turnDiffResult.diff, "turn-diff");

      const fullDiffResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.getFullThreadDiff]({
            threadId: ThreadId.make("thread-1"),
            toTurnCount: 1,
          }),
        ),
      );
      assert.equal(fullDiffResult.diff, "full-diff");

      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );
      assert.deepEqual(replayResult, []);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("enriches replayed project events with repository identity metadata", () =>
    Effect.gen(function* () {
      const repositoryIdentity = {
        canonicalKey: "github.com/t3tools/t3code",
        locator: {
          source: "git-remote" as const,
          remoteName: "origin",
          remoteUrl: "git@github.com:T3Tools/t3code.git",
        },
        displayName: "T3Tools/t3code",
        provider: "github",
        owner: "T3Tools",
        name: "t3code",
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: (_fromSequenceExclusive) =>
              Stream.make({
                sequence: 1,
                eventId: EventId.make("event-1"),
                aggregateKind: "project",
                aggregateId: defaultProjectId,
                occurredAt: "2026-04-05T00:00:00.000Z",
                commandId: null,
                causationEventId: null,
                correlationId: null,
                metadata: {},
                type: "project.created",
                payload: {
                  projectId: defaultProjectId,
                  title: "Default Project",
                  workspaceRoot: "/tmp/default-project",
                  defaultModelSelection,
                  scripts: [],
                  createdAt: "2026-04-05T00:00:00.000Z",
                  updatedAt: "2026-04-05T00:00:00.000Z",
                },
              } satisfies Extract<OrchestrationEvent, { type: "project.created" }>),
          },
          repositoryIdentityResolver: {
            resolve: () => Effect.succeed(repositoryIdentity),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const replayResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.replayEvents]({
            fromSequenceExclusive: 0,
          }),
        ),
      );

      const replayedEvent = replayResult[0];
      assert.equal(replayedEvent?.type, "project.created");
      assert.deepEqual(
        replayedEvent && replayedEvent.type === "project.created"
          ? replayedEvent.payload.repositoryIdentity
          : null,
        repositoryIdentity,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops the provider session and closes thread terminals after archive", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      const sessionStopCommand = dispatchedCommands[1];
      assert.equal(sessionStopCommand?.type, "thread.session.stop");
      if (sessionStopCommand?.type === "thread.session.stop") {
        assert.equal(sessionStopCommand.threadId, threadId);
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("checks session status before archiving removes the thread from active lookups", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-precheck");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();
      let archived = false;

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                if (command.type === "thread.archive") {
                  archived = true;
                }
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.sync(() => {
                effects.push(`query:thread-shell:${archived ? "archived" : "active"}`);
                return archived
                  ? Option.none()
                  : Option.some(
                      makeDefaultOrchestrationThreadShell({
                        id: threadId,
                        updatedAt: now,
                        session: {
                          threadId,
                          status: "ready",
                          providerName: "claudeAgent",
                          runtimeMode: "full-access",
                          activeTurnId: null,
                          lastError: null,
                          updatedAt: now,
                        },
                      }),
                    );
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-precheck"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "query:thread-shell:active",
        "query:thread-shell:active",
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives without dispatching session stop when the thread has no session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-no-session");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                effects.push(`dispatch:${command.type}`);
                return { sequence: dispatchedCommands.length };
              }),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, session: null })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-no-session"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "archives without dispatching session stop when the thread session is already stopped",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-archive-stopped-session");
        const effects: string[] = [];
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const now = new Date().toISOString();

        yield* buildAppUnderTest({
          layers: {
            terminalManager: {
              close: (input) =>
                Effect.sync(() => {
                  effects.push(`terminal.close:${input.threadId}`);
                }),
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  effects.push(`dispatch:${command.type}`);
                  return { sequence: dispatchedCommands.length };
                }),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(
                    makeDefaultOrchestrationThreadShell({
                      id: threadId,
                      updatedAt: now,
                      session: {
                        threadId,
                        status: "stopped",
                        providerName: "claudeAgent",
                        runtimeMode: "full-access",
                        activeTurnId: null,
                        lastError: null,
                        updatedAt: now,
                      },
                    }),
                  ),
                ),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        const dispatchResult = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.archive",
              commandId: CommandId.make("cmd-thread-archive-stopped-session"),
              threadId,
            }),
          ),
        );

        assert.equal(dispatchResult.sequence, 1);
        assert.deepEqual(effects, ["dispatch:thread.archive", `terminal.close:${threadId}`]);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          ["thread.archive"],
        );
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-failure");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.fail(
                  new OrchestrationListenerCallbackError({
                    listener: "domain-event",
                    detail: "simulated archive stop failure",
                  }),
                );
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-failure"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("archives and still closes terminals when session stop defects", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-archive-stop-defect");
      const effects: string[] = [];
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const now = new Date().toISOString();

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            close: (input) =>
              Effect.sync(() => {
                effects.push(`terminal.close:${input.threadId}`);
              }),
          },
          orchestrationEngine: {
            dispatch: (command) => {
              dispatchedCommands.push(command);
              effects.push(`dispatch:${command.type}`);
              if (command.type === "thread.session.stop") {
                return Effect.die(new Error("simulated archive stop defect"));
              }
              return Effect.succeed({ sequence: dispatchedCommands.length });
            },
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    updatedAt: now,
                    session: {
                      threadId,
                      status: "ready",
                      providerName: "claudeAgent",
                      runtimeMode: "full-access",
                      activeTurnId: null,
                      lastError: null,
                      updatedAt: now,
                    },
                  }),
                ),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const dispatchResult = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.archive",
            commandId: CommandId.make("cmd-thread-archive-stop-defect"),
            threadId,
          }),
        ),
      );

      assert.equal(dispatchResult.sequence, 1);
      assert.deepEqual(effects, [
        "dispatch:thread.archive",
        "dispatch:thread.session.stop",
        `terminal.close:${threadId}`,
      ]);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.archive", "thread.session.stop"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "bootstraps first-send worktree turns on the server before dispatching turn start",
    () =>
      Effect.gen(function* () {
        const dispatchedCommands: Array<OrchestrationCommand> = [];
        const refreshStatus = vi.fn((_: string) =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: true,
            isDefaultBranch: false,
            branch: "t3code/bootstrap-branch",
            hasWorkingTreeChanges: false,
            workingTree: {
              files: [],
              insertions: 0,
              deletions: 0,
            },
            hasUpstream: true,
            aheadCount: 0,
            behindCount: 0,
            pr: null,
          }),
        );
        const createWorktree = vi.fn((_: Parameters<GitCoreShape["createWorktree"]>[0]) =>
          Effect.succeed({
            worktree: {
              branch: "t3code/bootstrap-branch",
              path: "/tmp/bootstrap-worktree",
            },
          }),
        );
        const runForThread = vi.fn(
          (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
            Effect.succeed({
              status: "started" as const,
              scriptId: "setup",
              scriptName: "Setup",
              terminalId: "setup-setup",
              cwd: "/tmp/bootstrap-worktree",
            }),
        );

        yield* buildAppUnderTest({
          layers: {
            gitCore: {
              createWorktree,
            },
            gitStatusBroadcaster: {
              refreshStatus,
            },
            orchestrationEngine: {
              dispatch: (command) =>
                Effect.sync(() => {
                  dispatchedCommands.push(command);
                  return { sequence: dispatchedCommands.length };
                }),
              readEvents: () => Stream.empty,
            },
            projectSetupScriptRunner: {
              runForThread,
            },
          },
        });

        const createdAt = new Date().toISOString();
        const wsUrl = yield* getWsServerUrl("/ws");
        const response = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
              type: "thread.turn.start",
              commandId: CommandId.make("cmd-bootstrap-turn-start"),
              threadId: ThreadId.make("thread-bootstrap"),
              message: {
                messageId: MessageId.make("msg-bootstrap"),
                role: "user",
                text: "hello",
                attachments: [],
              },
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              bootstrap: {
                createThread: {
                  projectId: defaultProjectId,
                  title: "Bootstrap Thread",
                  modelSelection: defaultModelSelection,
                  runtimeMode: "full-access",
                  interactionMode: "default",
                  branch: "main",
                  worktreePath: null,
                  createdAt,
                },
                prepareWorktree: {
                  projectCwd: "/tmp/project",
                  baseBranch: "main",
                  branch: "t3code/bootstrap-branch",
                },
                runSetupScript: true,
              },
              createdAt,
            }),
          ),
        );

        assert.equal(response.sequence, 5);
        assert.deepEqual(
          dispatchedCommands.map((command) => command.type),
          [
            "thread.create",
            "thread.meta.update",
            "thread.activity.append",
            "thread.activity.append",
            "thread.turn.start",
          ],
        );
        assert.deepEqual(createWorktree.mock.calls[0]?.[0], {
          cwd: "/tmp/project",
          branch: "main",
          newBranch: "t3code/bootstrap-branch",
          path: null,
        });
        assert.deepEqual(runForThread.mock.calls[0]?.[0], {
          threadId: ThreadId.make("thread-bootstrap"),
          projectId: defaultProjectId,
          projectCwd: "/tmp/project",
          worktreePath: "/tmp/bootstrap-worktree",
        });
        assert.deepEqual(refreshStatus.mock.calls[0]?.[0], "/tmp/bootstrap-worktree");

        const setupActivities = dispatchedCommands.filter(
          (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
            command.type === "thread.activity.append",
        );
        assert.deepEqual(
          setupActivities.map((command) => command.activity.kind),
          ["setup-script.requested", "setup-script.started"],
        );
        const finalCommand = dispatchedCommands[4];
        assertTrue(finalCommand?.type === "thread.turn.start");
        if (finalCommand?.type === "thread.turn.start") {
          assert.equal(finalCommand.bootstrap, undefined);
        }
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("records setup-script failures without aborting bootstrap turn start", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitCoreShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            branch: "t3code/bootstrap-branch",
            path: "/tmp/bootstrap-worktree",
          },
        }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.fail(new Error("pty unavailable")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupFailureActivity = dispatchedCommands.find(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.equal(setupFailureActivity?.activity.kind, "setup-script.failed");
      assert.deepEqual(setupFailureActivity?.activity.payload, {
        detail: "pty unavailable",
        worktreePath: "/tmp/bootstrap-worktree",
      });
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("does not misattribute setup activity dispatch failures as setup launch failures", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitCoreShape["createWorktree"]>[0]) =>
        Effect.succeed({
          worktree: {
            branch: "t3code/bootstrap-branch",
            path: "/tmp/bootstrap-worktree",
          },
        }),
      );
      const runForThread = vi.fn(
        (_: Parameters<ProjectSetupScriptRunnerShape["runForThread"]>[0]) =>
          Effect.succeed({
            status: "started" as const,
            scriptId: "setup",
            scriptName: "Setup",
            terminalId: "setup-setup",
            cwd: "/tmp/bootstrap-worktree",
          }),
      );
      let setupActivityAppendAttempt = 0;

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) => {
              if (
                command.type === "thread.activity.append" &&
                command.activity.kind.startsWith("setup-script.")
              ) {
                setupActivityAppendAttempt += 1;
                if (setupActivityAppendAttempt === 2) {
                  return Effect.fail(
                    new OrchestrationListenerCallbackError({
                      listener: "domain-event",
                      detail: "failed to append setup-script.started activity",
                    }),
                  );
                }
              }

              return Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              });
            },
            readEvents: () => Stream.empty,
          },
          projectSetupScriptRunner: {
            runForThread,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const response = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-setup-activity-failure"),
            threadId: ThreadId.make("thread-bootstrap-setup-activity-failure"),
            message: {
              messageId: MessageId.make("msg-bootstrap-setup-activity-failure"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: true,
            },
            createdAt,
          }),
        ),
      );

      assert.equal(response.sequence, 4);
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.meta.update", "thread.activity.append", "thread.turn.start"],
      );
      const setupActivities = dispatchedCommands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.activity.append" }> =>
          command.type === "thread.activity.append",
      );
      assert.deepEqual(
        setupActivities.map((command) => command.activity.kind),
        ["setup-script.requested"],
      );
      assertTrue(
        setupActivities.every((command) => command.activity.kind !== "setup-script.failed"),
      );
      assertTrue(dispatchedCommands.every((command) => command.type !== "thread.delete"));
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("cleans up created bootstrap threads when worktree creation defects", () =>
    Effect.gen(function* () {
      const dispatchedCommands: Array<OrchestrationCommand> = [];
      const createWorktree = vi.fn((_: Parameters<GitCoreShape["createWorktree"]>[0]) =>
        Effect.die(new Error("worktree exploded")),
      );

      yield* buildAppUnderTest({
        layers: {
          gitCore: {
            createWorktree,
          },
          orchestrationEngine: {
            dispatch: (command) =>
              Effect.sync(() => {
                dispatchedCommands.push(command);
                return { sequence: dispatchedCommands.length };
              }),
            readEvents: () => Stream.empty,
          },
        },
      });

      const createdAt = new Date().toISOString();
      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-turn-start-defect"),
            threadId: ThreadId.make("thread-bootstrap-defect"),
            message: {
              messageId: MessageId.make("msg-bootstrap-defect"),
              role: "user",
              text: "hello",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "Bootstrap Thread",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt,
              },
              prepareWorktree: {
                projectCwd: "/tmp/project",
                baseBranch: "main",
                branch: "t3code/bootstrap-branch",
              },
              runSetupScript: false,
            },
            createdAt,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(result._tag === "Failure");
      assertTrue(result.failure._tag === "OrchestrationDispatchCommandError");
      assert.include(result.failure.message, "worktree exploded");
      assert.deepEqual(
        dispatchedCommands.map((command) => command.type),
        ["thread.create", "thread.delete"],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal methods", () =>
    Effect.gen(function* () {
      const snapshot = {
        threadId: "thread-1",
        terminalId: "default",
        cwd: "/tmp/project",
        worktreePath: null,
        status: "running" as const,
        pid: 1234,
        history: "",
        exitCode: null,
        exitSignal: null,
        updatedAt: new Date().toISOString(),
      };

      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            open: () => Effect.succeed(snapshot),
            write: () => Effect.void,
            resize: () => Effect.void,
            clear: () => Effect.void,
            restart: () => Effect.succeed(snapshot),
            close: () => Effect.void,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const opened = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalOpen]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
          }),
        ),
      );
      assert.equal(opened.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo hi\n",
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalResize]({
            threadId: "thread-1",
            terminalId: "default",
            cols: 120,
            rows: 40,
          }),
        ),
      );

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClear]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );

      const restarted = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalRestart]({
            threadId: "thread-1",
            terminalId: "default",
            cwd: "/tmp/project",
            cols: 120,
            rows: 40,
          }),
        ),
      );
      assert.equal(restarted.terminalId, "default");

      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalClose]({
            threadId: "thread-1",
            terminalId: "default",
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("routes websocket rpc terminal.write errors", () =>
    Effect.gen(function* () {
      const terminalError = new TerminalNotRunningError({
        threadId: "thread-1",
        terminalId: "default",
      });
      yield* buildAppUnderTest({
        layers: {
          terminalManager: {
            write: () => Effect.fail(terminalError),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.terminalWrite]({
            threadId: "thread-1",
            terminalId: "default",
            data: "echo fail\n",
          }),
        ).pipe(Effect.result),
      );

      assertFailure(result, terminalError);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
