import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import type { Server as NodeHttpServerType } from "node:http";
import type { Socket as NodeNetSocket } from "node:net";

import { ServerConfig } from "./config.ts";
import { analyticsIngestRouteLayer } from "./analytics/http.ts";
import { desktopActivityRouteLayer } from "./desktop/http.ts";
import {
  shareLinkClaimRouteLayer,
  shareLinkPreviewRouteLayer,
  shareLinkRedeemRouteLayer,
} from "./shareLinks/http.ts";
import {
  cloudSyncBlobDownloadRouteLayer,
  cloudSyncBlobUploadRouteLayer,
  cloudSyncCommitRouteLayer,
  cloudSyncHandoffRegisterRouteLayer,
  cloudSyncHandoffRouteLayer,
  cloudSyncLiveCopyRouteLayer,
  cloudSyncNegotiateRouteLayer,
  cloudSyncPassRouteLayer,
  cloudSyncVisitRouteLayer,
} from "./cloudSync/http.ts";
import {
  providerAuthAccountRouteLayer,
  providerAuthCodeRouteLayer,
  providerAuthConnectionsRouteLayer,
  providerAuthLogoutRouteLayer,
  providerAuthPageRouteLayer,
  providerAuthPromptRouteLayer,
  providerAuthStartRouteLayer,
} from "./providerAuth/http.ts";
import {
  attachmentsRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  browserApiCorsLayer,
} from "./http.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import { OpenLive } from "./open.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { ServerLifecycleEventsLive } from "./serverLifecycleEvents.ts";
import { AnalyticsServiceLayerLive } from "./telemetry/Layers/AnalyticsService.ts";
import { makeEventNdjsonLogger } from "./provider/Layers/EventNdjsonLogger.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import { ProviderSessionRuntimeRepositoryLive } from "./persistence/Layers/ProviderSessionRuntime.ts";
import { makeCodexAdapterLive } from "./provider/Layers/CodexAdapter.ts";
import { makeClaudeAdapterLive } from "./provider/Layers/ClaudeAdapter.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import { makeProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import { CheckpointDiffQueryLive } from "./checkpointing/Layers/CheckpointDiffQuery.ts";
import { CheckpointStoreLive } from "./checkpointing/Layers/CheckpointStore.ts";
import { GitCoreLive } from "./git/Layers/GitCore.ts";
import { GitHubCliLive } from "./git/Layers/GitHubCli.ts";
import { GitStatusBroadcasterLive } from "./git/Layers/GitStatusBroadcaster.ts";
import { RoutingTextGenerationLive } from "./git/Layers/RoutingTextGeneration.ts";
import { TerminalManagerLive } from "./terminal/Layers/Manager.ts";
import { GitManagerLive } from "./git/Layers/GitManager.ts";
import { KeybindingsLive } from "./keybindings.ts";
import { ServerRuntimeStartup, ServerRuntimeStartupLive } from "./serverRuntimeStartup.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import { ServerSettingsLive } from "./serverSettings.ts";
import { ProjectFaviconResolverLive } from "./project/Layers/ProjectFaviconResolver.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { WorkspaceEntriesLive } from "./workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "./workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";
import { ProjectSetupScriptRunnerLive } from "./project/Layers/ProjectSetupScriptRunner.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import { ServerEnvironmentLive } from "./environment/Layers/ServerEnvironment.ts";
import {
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authOnboardingRouteLayer,
  authPasswordRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSelfPairingCredentialRouteLayer,
  authProfileRouteLayer,
  authProfileUpdateRouteLayer,
  authSessionRouteLayer,
  authSessionSignOutRouteLayer,
  authWebSocketTokenRouteLayer,
} from "./auth/http.ts";
import { basicAuthMiddlewareLayer } from "./auth/basicAuth.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { ServerAuthLive } from "./auth/Layers/ServerAuth.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import {
  clearPersistedServerRuntimeState,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "./serverRuntimeState.ts";
import {
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
} from "./orchestration/http.ts";
import { CollaborationServiceLive } from "./collaboration/Layers/CollaborationService.ts";
import { PackRegistryServiceLive } from "./packs/Layers/PackRegistryService.ts";
import { PackRepositoryLive } from "./packs/Layers/PackRepository.ts";
import { OrganizationServiceLive } from "./organizations/Layers/OrganizationService.ts";
import { TenancyRepositoryLive } from "./persistence/Layers/Tenancy.ts";
import { ProviderSharingRepositoryLive } from "./persistence/Layers/ProviderSharing.ts";
import { ProviderUsageRequestRepositoryLive } from "./persistence/Layers/ProviderUsageRequests.ts";
import { ShareLinkRepositoryLive } from "./persistence/Layers/ShareLinks.ts";
import { CloudSyncRepositoryLive } from "./persistence/Layers/CloudSync.ts";
import { ProjectionProjectRepositoryLive } from "./persistence/Layers/ProjectionProjects.ts";
import { ShareLinkServiceLive } from "./shareLinks/Layers/ShareLinkService.ts";
import { CloudSyncServiceLive } from "./cloudSync/Layers/CloudSyncService.ts";
import { ProviderSharingServiceLive } from "./providerSharing/Layers/ProviderSharingService.ts";
import { ProviderUsageServiceLive } from "./providerUsage/Layers/ProviderUsageService.ts";
import { DeployRepositoryLive } from "./persistence/Layers/DeployTargets.ts";
import { DeployServiceLive } from "./deploy/Layers/DeployService.ts";
import { DeploymentRegistryLive } from "./deploy/Layers/DeploymentRegistry.ts";
import { DeploymentRepositoryLive } from "./persistence/Layers/Deployments.ts";
import { AnalyticsStoreLive } from "./analytics/Layers/AnalyticsStore.ts";
import { PackEnablementServiceLive } from "./packEnablement/Layers/PackEnablementService.ts";
import { PackEnablementRepositoryLive } from "./persistence/Layers/PackEnablement.ts";
import { AnalyticsRepositoryLive } from "./persistence/Layers/Analytics.ts";
import { ProjectionThreadPreferenceRepositoryLive } from "./persistence/Layers/ProjectionThreadPreferences.ts";
import { TenantRuntimeLifecycleOwnerLive } from "./tenancy/Layers/TenantRuntimeLifecycleOwner.ts";

const PtyAdapterLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const BunPTY = yield* Effect.promise(() => import("./terminal/Layers/BunPTY.ts"));
      return BunPTY.layer;
    } else {
      const NodePTY = yield* Effect.promise(() => import("./terminal/Layers/NodePTY.ts"));
      return NodePTY.layer;
    }
  }),
);

function isBenignNodeSocketError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNRESET" || code === "EPIPE" || code === "ETIMEDOUT";
}

function attachNodeHttpSocketErrorGuards(server: NodeHttpServerType): NodeHttpServerType {
  server.on("connection", (socket: NodeNetSocket) => {
    socket.on("error", (error) => {
      if (isBenignNodeSocketError(error)) {
        return;
      }

      console.warn("HTTP socket error", error);
    });
  });

  server.on("clientError", (error, socket) => {
    if (!isBenignNodeSocketError(error)) {
      console.warn("HTTP client socket error", error);
    }

    if (!socket.destroyed) {
      socket.destroy();
    }
  });

  return server;
}

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        ...(config.host ? { hostname: config.host } : {}),
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(() => attachNodeHttpSocketErrorGuards(NodeHttp.createServer()), {
        host: config.host,
        port: config.port,
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
);

const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQueryLive),
  Layer.provideMerge(CheckpointStoreLive),
);

const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntimeRepositoryLive),
);

const ProviderLayerLive = Layer.unwrap(
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig;
    const nativeEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "native",
    });
    const canonicalEventLogger = yield* makeEventNdjsonLogger(providerEventLogPath, {
      stream: "canonical",
    });
    const codexAdapterLayer = makeCodexAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const claudeAdapterLayer = makeClaudeAdapterLive(
      nativeEventLogger ? { nativeEventLogger } : undefined,
    );
    const adapterRegistryLayer = ProviderAdapterRegistryLive.pipe(
      Layer.provide(codexAdapterLayer),
      Layer.provide(claudeAdapterLayer),
      Layer.provideMerge(ProviderSessionDirectoryLayerLive),
    );
    return makeProviderServiceLive(
      canonicalEventLogger ? { canonicalEventLogger } : undefined,
    ).pipe(
      Layer.provide(adapterRegistryLayer),
      Layer.provideMerge(ProviderSessionDirectoryLayerLive),
    );
  }),
);

const PersistenceLayerLive = Layer.empty.pipe(Layer.provideMerge(SqlitePersistenceLayerLive));

const GitManagerLayerLive = GitManagerLive.pipe(
  Layer.provideMerge(ProjectSetupScriptRunnerLive),
  Layer.provideMerge(GitCoreLive),
  Layer.provideMerge(GitHubCliLive),
  Layer.provideMerge(RoutingTextGenerationLive),
);

const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitManagerLayerLive),
  Layer.provideMerge(GitStatusBroadcasterLive.pipe(Layer.provide(GitManagerLayerLive))),
  Layer.provideMerge(GitCoreLive),
);

const TerminalLayerLive = TerminalManagerLive.pipe(Layer.provide(PtyAdapterLive));

const WorkspaceEntriesLayerLive = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provideMerge(GitCoreLive),
);

const WorkspaceFileSystemLayerLive = WorkspaceFileSystemLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(WorkspaceEntriesLayerLive),
);

const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePathsLive,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

const AuthLayerLive = ServerAuthLive.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerSecretStoreLive),
);

const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

const TenancyRepositoryLayerLive = TenancyRepositoryLive.pipe(Layer.provide(PersistenceLayerLive));
const ThreadPreferenceLayerLive = ProjectionThreadPreferenceRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);
const DeployRepositoryLayerLive = DeployRepositoryLive.pipe(Layer.provide(PersistenceLayerLive));

/**
 * Who lends a provider account to whom. Reached from three places that do not
 * otherwise meet — the connect flow indexing an account, the panel reading the
 * roster, and a turn deciding whose credential to run on — so it is registered
 * once here rather than provided at each of them.
 */
const ProviderSharingRepositoryLayerLive = ProviderSharingRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

/** Base revisions and conflicts for a project synced to the cloud. */
const CloudSyncRepositoryLayerLive = CloudSyncRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

/** Public links: minted by the panel, redeemed with no session at all. */
const ShareLinkRepositoryLayerLive = ShareLinkRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

/** The asks that sit on top of sharing: who wants usage, and who answered. */
const ProviderUsageRequestRepositoryLayerLive = ProviderUsageRequestRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const AnalyticsRepositoryLayerLive = AnalyticsRepositoryLive.pipe(
  Layer.provide(PersistenceLayerLive),
);

const AnalyticsLayerLive = AnalyticsStoreLive.pipe(Layer.provide(AnalyticsRepositoryLayerLive));

// The registry sits across both directories on purpose: it is the only thing
// that knows a deployment's streams were actually declared on its project.
const DeploymentRegistryLayerLive = DeploymentRegistryLive.pipe(
  Layer.provide(DeploymentRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provide(DeployRepositoryLayerLive),
  Layer.provide(AnalyticsRepositoryLayerLive),
);

// Deploying now reaches both: it mints the ingest key a deployment carries, and
// records what that deploy put live.
const DeployLayerLive = DeployServiceLive.pipe(
  Layer.provide(DeployRepositoryLayerLive),
  Layer.provide(ServerSecretStoreLive),
  Layer.provide(AnalyticsLayerLive),
  Layer.provide(DeploymentRegistryLayerLive),
);

const PersistenceServicesLayerLive = Layer.mergeAll(
  TenancyRepositoryLayerLive,
  ProviderSharingRepositoryLayerLive,
  ProviderUsageRequestRepositoryLayerLive,
  ShareLinkRepositoryLayerLive,
  CloudSyncRepositoryLayerLive,
  ThreadPreferenceLayerLive,
  DeployLayerLive,
  AnalyticsLayerLive,
  DeploymentRegistryLayerLive,
);

const TenantRuntimeLifecycleOwnerLayerLive = TenantRuntimeLifecycleOwnerLive.pipe(
  Layer.provide(TenancyRepositoryLayerLive),
  Layer.provide(ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
);

const CollaborationLayerLive = CollaborationServiceLive.pipe(
  Layer.provide(TenancyRepositoryLayerLive),
);

const OrganizationLayerLive = OrganizationServiceLive.pipe(
  Layer.provide(TenancyRepositoryLayerLive),
);

/**
 * Reads the collaboration roster to answer "whose accounts are in this
 * workspace", so it borrows the collaboration service rather than assembling a
 * second member list that could disagree about who is a member or about whose
 * name may be shown. Memoisation means both still see one instance.
 */
const ProviderSharingLayerLive = ProviderSharingServiceLive.pipe(
  Layer.provide(ProviderSharingRepositoryLayerLive),
  Layer.provide(CollaborationLayerLive),
);

/**
 * Answering a request contributes an account, so this reaches the sharing rows
 * as well as its own: a request marked granted while nothing was actually lent
 * would be the feature failing quietly.
 */
/**
 * Public links. Reaches the project projection because a link points at a
 * project and the project row is the only thing that knows which workspace owns
 * it — the check that stops a member of one workspace publishing another's.
 */
/**
 * Replicating a project reaches the same project projection the share links do,
 * and for the same reason: the project row is what says which workspace owns it.
 */
const CloudSyncLayerLive = CloudSyncServiceLive.pipe(
  Layer.provide(CloudSyncRepositoryLayerLive),
  Layer.provide(CollaborationLayerLive),
  Layer.provide(ProjectionProjectRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
);

const ShareLinkLayerLive = ShareLinkServiceLive.pipe(
  Layer.provide(ShareLinkRepositoryLayerLive),
  Layer.provide(CollaborationLayerLive),
  Layer.provide(ProjectionProjectRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
);

const ProviderUsageLayerLive = ProviderUsageServiceLive.pipe(
  Layer.provide(ProviderUsageRequestRepositoryLayerLive),
  Layer.provide(ProviderSharingRepositoryLayerLive),
  Layer.provide(CollaborationLayerLive),
);

const PackRegistryLayerLive = PackRegistryServiceLive.pipe(
  Layer.provide(PackRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provide(CollaborationLayerLive),
  Layer.provide(TenancyRepositoryLayerLive),
);

const PackEnablementLayerLive = PackEnablementServiceLive.pipe(
  Layer.provide(PackEnablementRepositoryLive.pipe(Layer.provide(PersistenceLayerLive))),
  Layer.provide(PackRegistryLayerLive),
);

/** Everything scoped to a tenant's people and what they publish. */
const TenantServicesLayerLive = Layer.mergeAll(
  CollaborationLayerLive,
  ProviderSharingLayerLive,
  ProviderUsageLayerLive,
  ShareLinkLayerLive,
  CloudSyncLayerLive,
  OrganizationLayerLive,
  PackRegistryLayerLive,
  PackEnablementLayerLive,
);

const RuntimeDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(TerminalLayerLive),
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provideMerge(KeybindingsLive),
  Layer.provideMerge(ProviderRegistryLive),
  Layer.provideMerge(ServerSettingsLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(ProjectFaviconResolverLive),
  Layer.provideMerge(RepositoryIdentityResolverLive),
  Layer.provideMerge(ServerEnvironmentLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(PersistenceServicesLayerLive),
  Layer.provideMerge(TenantRuntimeLifecycleOwnerLayerLive),
  Layer.provideMerge(TenantServicesLayerLive),

  // Misc.
  Layer.provideMerge(AnalyticsServiceLayerLive),
  Layer.provideMerge(OpenLive),
  Layer.provideMerge(ServerLifecycleEventsLive),
);

const RuntimeServicesLive = ServerRuntimeStartupLive.pipe(
  Layer.provideMerge(RuntimeDependenciesLive),
);

export const makeRoutesLayer = Layer.mergeAll(
  basicAuthMiddlewareLayer,
  authBearerBootstrapRouteLayer,
  authBootstrapRouteLayer,
  authClientsRevokeOthersRouteLayer,
  authClientsRevokeRouteLayer,
  authClientsRouteLayer,
  authOnboardingRouteLayer,
  authPasswordRouteLayer,
  authPairingLinksRevokeRouteLayer,
  authPairingLinksRouteLayer,
  authPairingCredentialRouteLayer,
  authSelfPairingCredentialRouteLayer,
  authProfileRouteLayer,
  authProfileUpdateRouteLayer,
  authSessionRouteLayer,
  authSessionSignOutRouteLayer,
  authWebSocketTokenRouteLayer,
  attachmentsRouteLayer,
  analyticsIngestRouteLayer,
  desktopActivityRouteLayer,
  // Before the static catch-all: `/s/*` is a public route, not an app path.
  shareLinkRedeemRouteLayer,
  // The join page's two exchanges. `preview` is unauthenticated by design and
  // discloses nothing; `claim` is the only one that grants anything and is the
  // only one that reads a session.
  shareLinkPreviewRouteLayer,
  shareLinkClaimRouteLayer,
  cloudSyncNegotiateRouteLayer,
  cloudSyncBlobUploadRouteLayer,
  cloudSyncBlobDownloadRouteLayer,
  cloudSyncPassRouteLayer,
  cloudSyncCommitRouteLayer,
  cloudSyncLiveCopyRouteLayer,
  cloudSyncVisitRouteLayer,
  cloudSyncHandoffRegisterRouteLayer,
  // Unauthenticated on purpose: the caller is a visitor on the tunnel, and the
  // answer is the durable address they were always meant to end up at.
  cloudSyncHandoffRouteLayer,
  providerAuthPageRouteLayer,
  providerAuthStartRouteLayer,
  providerAuthCodeRouteLayer,
  providerAuthConnectionsRouteLayer,
  providerAuthAccountRouteLayer,
  providerAuthLogoutRouteLayer,
  providerAuthPromptRouteLayer,
  orchestrationDispatchRouteLayer,
  orchestrationSnapshotRouteLayer,
  otlpTracesProxyRouteLayer,
  projectFaviconRouteLayer,
  serverEnvironmentRouteLayer,
  staticAndDevRouteLayer,
  websocketRpcRouteLayer,
).pipe(Layer.provide(browserApiCorsLayer));

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (typeof address === "string" || !("port" in address)) {
            return;
          }

          const state = makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          });
        }),
        () => clearPersistedServerRuntimeState(config.serverRuntimeStatePath),
      ),
    );

    const serverApplicationLayer = Layer.mergeAll(
      HttpRouter.serve(makeRoutesLayer, {
        disableLogger: !config.logWebSocketEvents,
      }),
      httpListeningLayer,
      runtimeStateLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(RuntimeServicesLive),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// Important: Only `ServerConfig` should be provided by the CLI layer!!! Don't let other requirements leak into the launch layer.
export const runServer = Layer.launch(makeServerLayer) satisfies Effect.Effect<
  never,
  any,
  ServerConfig
>;
