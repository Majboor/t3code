import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

// Deep imports on purpose: the package barrel also re-exports the store SDK,
// which would pull the whole client transport into this program for two
// functions.
import { runCommand as runPackCliCommand } from "@t3tools/pack-cli/commands";
import { makeDirectoryRegistry } from "@t3tools/pack-cli/registry";
import { makeNodePackStore } from "@t3tools/pack-cli/store";
import { NetService } from "@t3tools/shared/Net";
import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import {
  AuthSessionId,
  CommandId,
  OrchestrationReadModel,
  ProjectId,
  type DeployTarget,
  DeployTargetId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import {
  Config,
  Console,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  LogLevel,
  Option,
  Path,
  References,
  Schema,
  SchemaIssue,
  SchemaTransformation,
} from "effect";
import { Argument, Command, Flag, GlobalFlag } from "effect/unstable/cli";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  DEFAULT_PORT,
  deriveServerPaths,
  ensureServerDirectories,
  resolveStaticDir,
  ServerConfig,
  RuntimeMode,
  type ServerConfigShape,
  type StartupPresentation,
} from "./config.ts";
import { readBootstrapEnvelope } from "./bootstrap.ts";
import { expandHomePath, resolveBaseDir } from "./os-jank.ts";
import { runServer } from "./server.ts";
import { DeployService, type DeployServiceShape } from "./deploy/Services/DeployService.ts";
import { DeployServiceLive } from "./deploy/Layers/DeployService.ts";
import { AnalyticsStoreLive } from "./analytics/Layers/AnalyticsStore.ts";
import { AnalyticsStore, type AnalyticsStoreShape } from "./analytics/Services/AnalyticsStore.ts";
import { AnalyticsRepositoryLive } from "./persistence/Layers/Analytics.ts";
import { DeployRepositoryLive } from "./persistence/Layers/DeployTargets.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { AuthControlPlaneRuntimeLive } from "./auth/Layers/AuthControlPlane.ts";
import {
  formatIssuedPairingCredential,
  formatIssuedSession,
  formatPairingCredentialList,
  formatSessionList,
} from "./cliAuthFormat.ts";
import { AuthControlPlane } from "./auth/Services/AuthControlPlane.ts";
import type { AuthControlPlaneShape } from "./auth/Services/AuthControlPlane.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "./project/Layers/RepositoryIdentityResolver.ts";
import { getAutoBootstrapDefaultModelSelection } from "./serverRuntimeStartup.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "./serverRuntimeState.ts";
import { WorkspacePaths } from "./workspace/Services/WorkspacePaths.ts";
import { WorkspacePathsLive } from "./workspace/Layers/WorkspacePaths.ts";

const PortSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

const BootstrapEnvelopeSchema = Schema.Struct({
  mode: Schema.optional(RuntimeMode),
  port: Schema.optional(PortSchema),
  host: Schema.optional(Schema.String),
  t3Home: Schema.optional(Schema.String),
  devUrl: Schema.optional(Schema.URLFromString),
  noBrowser: Schema.optional(Schema.Boolean),
  unsafeNoAuth: Schema.optional(Schema.Boolean),
  desktopBootstrapToken: Schema.optional(Schema.String),
  supabaseProjectUrl: Schema.optional(Schema.URLFromString),
  supabaseAnonKey: Schema.optional(Schema.String),
  supabaseJwtAudience: Schema.optional(Schema.String),
  supabaseServiceRoleSecretName: Schema.optional(Schema.String),
  autoBootstrapProjectFromCwd: Schema.optional(Schema.Boolean),
  logWebSocketEvents: Schema.optional(Schema.Boolean),
  otlpTracesUrl: Schema.optional(Schema.String),
  otlpMetricsUrl: Schema.optional(Schema.String),
});

const modeFlag = Flag.choice("mode", RuntimeMode.literals).pipe(
  Flag.withDescription("Runtime mode. `desktop` keeps loopback defaults unless overridden."),
  Flag.optional,
);
const portFlag = Flag.integer("port").pipe(
  Flag.withSchema(PortSchema),
  Flag.withDescription("Port for the HTTP/WebSocket server."),
  Flag.optional,
);
const hostFlag = Flag.string("host").pipe(
  Flag.withDescription("Host/interface to bind (for example 127.0.0.1, 0.0.0.0, or a Tailnet IP)."),
  Flag.optional,
);
const baseDirFlag = Flag.string("base-dir").pipe(
  Flag.withDescription("Base directory path (equivalent to T3CODE_HOME)."),
  Flag.optional,
);
const devUrlFlag = Flag.string("dev-url").pipe(
  Flag.withSchema(Schema.URLFromString),
  Flag.withDescription("Dev web URL to proxy/redirect to (equivalent to VITE_DEV_SERVER_URL)."),
  Flag.optional,
);
const noBrowserFlag = Flag.boolean("no-browser").pipe(
  Flag.withDescription("Disable automatic browser opening."),
  Flag.optional,
);
const unsafeNoAuthFlag = Flag.boolean("unsafe-no-auth").pipe(
  Flag.withDescription(
    "Disable pairing and auto-issue owner browser sessions. Unsafe on shared or public networks.",
  ),
  Flag.optional,
);
const bootstrapFdFlag = Flag.integer("bootstrap-fd").pipe(
  Flag.withSchema(Schema.Int),
  Flag.withDescription("Read one-time bootstrap secrets from the given file descriptor."),
  Flag.optional,
);
const autoBootstrapProjectFromCwdFlag = Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
  Flag.withDescription(
    "Create a project for the current working directory on startup when missing.",
  ),
  Flag.optional,
);
const logWebSocketEventsFlag = Flag.boolean("log-websocket-events").pipe(
  Flag.withDescription(
    "Emit server-side logs for outbound WebSocket push traffic (equivalent to T3CODE_LOG_WS_EVENTS).",
  ),
  Flag.withAlias("log-ws-events"),
  Flag.optional,
);

const EnvServerConfig = Config.all({
  logLevel: Config.logLevel("T3CODE_LOG_LEVEL").pipe(Config.withDefault("Info")),
  traceMinLevel: Config.logLevel("T3CODE_TRACE_MIN_LEVEL").pipe(Config.withDefault("Info")),
  traceTimingEnabled: Config.boolean("T3CODE_TRACE_TIMING_ENABLED").pipe(Config.withDefault(true)),
  traceFile: Config.string("T3CODE_TRACE_FILE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  traceMaxBytes: Config.int("T3CODE_TRACE_MAX_BYTES").pipe(Config.withDefault(10 * 1024 * 1024)),
  traceMaxFiles: Config.int("T3CODE_TRACE_MAX_FILES").pipe(Config.withDefault(10)),
  traceBatchWindowMs: Config.int("T3CODE_TRACE_BATCH_WINDOW_MS").pipe(Config.withDefault(200)),
  otlpTracesUrl: Config.string("T3CODE_OTLP_TRACES_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpMetricsUrl: Config.string("T3CODE_OTLP_METRICS_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  otlpExportIntervalMs: Config.int("T3CODE_OTLP_EXPORT_INTERVAL_MS").pipe(
    Config.withDefault(10_000),
  ),
  otlpServiceName: Config.string("T3CODE_OTLP_SERVICE_NAME").pipe(Config.withDefault("t3-server")),
  mode: Config.schema(RuntimeMode, "T3CODE_MODE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  port: Config.port("T3CODE_PORT").pipe(Config.option, Config.map(Option.getOrUndefined)),
  host: Config.string("T3CODE_HOST").pipe(Config.option, Config.map(Option.getOrUndefined)),
  t3Home: Config.string("T3CODE_HOME").pipe(Config.option, Config.map(Option.getOrUndefined)),
  devUrl: Config.url("VITE_DEV_SERVER_URL").pipe(Config.option, Config.map(Option.getOrUndefined)),
  noBrowser: Config.boolean("T3CODE_NO_BROWSER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  unsafeNoAuth: Config.boolean("T3CODE_UNSAFE_NO_AUTH").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  basicAuthUsername: Config.string("T3CODE_BASIC_AUTH_USER").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  basicAuthPassword: Config.string("T3CODE_BASIC_AUTH_PASSWORD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  basicAuthRealm: Config.string("T3CODE_BASIC_AUTH_REALM").pipe(Config.withDefault("T3 Code")),
  supabaseProjectUrl: Config.url("T3CODE_SUPABASE_PROJECT_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  supabaseAnonKey: Config.string("T3CODE_SUPABASE_ANON_KEY").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  supabaseJwtAudience: Config.string("T3CODE_SUPABASE_JWT_AUDIENCE").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  supabaseServiceRoleSecretName: Config.string("T3CODE_SUPABASE_SERVICE_ROLE_SECRET_NAME").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  localPasswordAuth: Config.boolean("T3CODE_LOCAL_PASSWORD_AUTH").pipe(Config.withDefault(false)),
  bootstrapFd: Config.int("T3CODE_BOOTSTRAP_FD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  autoBootstrapProjectFromCwd: Config.boolean("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  logWebSocketEvents: Config.boolean("T3CODE_LOG_WS_EVENTS").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface CliServerFlags {
  readonly mode: Option.Option<RuntimeMode>;
  readonly port: Option.Option<number>;
  readonly host: Option.Option<string>;
  readonly baseDir: Option.Option<string>;
  readonly cwd: Option.Option<string>;
  readonly devUrl: Option.Option<URL>;
  readonly noBrowser: Option.Option<boolean>;
  readonly unsafeNoAuth: Option.Option<boolean>;
  readonly bootstrapFd: Option.Option<number>;
  readonly autoBootstrapProjectFromCwd: Option.Option<boolean>;
  readonly logWebSocketEvents: Option.Option<boolean>;
}

interface CliAuthLocationFlags {
  readonly baseDir: Option.Option<string>;
  readonly devUrl?: Option.Option<URL>;
}

const resolveOptionPrecedence = <Value>(
  ...values: ReadonlyArray<Option.Option<Value>>
): Option.Option<Value> => Option.firstSomeOf(values);

const loadPersistedObservabilitySettings = Effect.fn(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(settingsPath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined };
  }

  const raw = yield* fs.readFileString(settingsPath).pipe(Effect.orElseSucceed(() => ""));
  return parsePersistedServerObservabilitySettings(raw);
});

export const resolveServerConfig = (
  flags: CliServerFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const { findAvailablePort } = yield* NetService;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const env = yield* EnvServerConfig;
    const normalizedFlags = {
      mode: flags.mode ?? Option.none(),
      port: flags.port ?? Option.none(),
      host: flags.host ?? Option.none(),
      baseDir: flags.baseDir ?? Option.none(),
      cwd: flags.cwd ?? Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: flags.noBrowser ?? Option.none(),
      unsafeNoAuth: flags.unsafeNoAuth ?? Option.none(),
      bootstrapFd: flags.bootstrapFd ?? Option.none(),
      autoBootstrapProjectFromCwd: flags.autoBootstrapProjectFromCwd ?? Option.none(),
      logWebSocketEvents: flags.logWebSocketEvents ?? Option.none(),
    } satisfies CliServerFlags;
    const bootstrapFd = Option.getOrUndefined(normalizedFlags.bootstrapFd) ?? env.bootstrapFd;
    const bootstrapEnvelope =
      bootstrapFd !== undefined
        ? yield* readBootstrapEnvelope(BootstrapEnvelopeSchema, bootstrapFd)
        : Option.none();
    const bootstrap = Option.getOrUndefined(bootstrapEnvelope);

    const mode: RuntimeMode = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.mode,
        Option.fromUndefinedOr(env.mode),
        Option.fromUndefinedOr(bootstrap?.mode),
      ),
      () => "web",
    );

    const port = yield* Option.match(
      resolveOptionPrecedence(
        normalizedFlags.port,
        Option.fromUndefinedOr(env.port),
        Option.fromUndefinedOr(bootstrap?.port),
      ),
      {
        onSome: (value) => Effect.succeed(value),
        onNone: () => {
          if (mode === "desktop") {
            return Effect.succeed(DEFAULT_PORT);
          }
          return findAvailablePort(DEFAULT_PORT);
        },
      },
    );
    const devUrl = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.devUrl,
        Option.fromUndefinedOr(env.devUrl),
        Option.fromUndefinedOr(bootstrap?.devUrl),
      ),
      () => undefined,
    );
    const baseDir = yield* resolveBaseDir(
      Option.getOrUndefined(
        resolveOptionPrecedence(
          normalizedFlags.baseDir,
          Option.fromUndefinedOr(env.t3Home),
          Option.fromUndefinedOr(bootstrap?.t3Home),
        ),
      ),
    );
    const rawCwd = Option.getOrElse(normalizedFlags.cwd, () => process.cwd());
    const cwd = path.resolve(yield* expandHomePath(rawCwd.trim()));
    yield* fs.makeDirectory(cwd, { recursive: true });
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    yield* ensureServerDirectories(derivedPaths);
    const persistedObservabilitySettings = yield* loadPersistedObservabilitySettings(
      derivedPaths.settingsPath,
    );
    const serverTracePath = env.traceFile ?? derivedPaths.serverTracePath;
    yield* fs.makeDirectory(path.dirname(serverTracePath), { recursive: true });
    const startupPresentation = options?.startupPresentation ?? "browser";
    const isHeadlessStartup = startupPresentation === "headless";
    const noBrowser = Option.getOrElse(
      resolveOptionPrecedence(
        isHeadlessStartup ? Option.some(true) : Option.none(),
        normalizedFlags.noBrowser,
        Option.fromUndefinedOr(env.noBrowser),
        Option.fromUndefinedOr(bootstrap?.noBrowser),
      ),
      () => mode === "desktop",
    );
    const unsafeNoAuth =
      Option.getOrUndefined(normalizedFlags.unsafeNoAuth) === true ||
      env.unsafeNoAuth === true ||
      bootstrap?.unsafeNoAuth === true;
    const desktopBootstrapToken = bootstrap?.desktopBootstrapToken;
    const autoBootstrapProjectFromCwd = Option.getOrElse(
      resolveOptionPrecedence(
        Option.fromUndefinedOr(options?.forceAutoBootstrapProjectFromCwd),
        isHeadlessStartup ? Option.some(false) : Option.none(),
        normalizedFlags.autoBootstrapProjectFromCwd,
        Option.fromUndefinedOr(env.autoBootstrapProjectFromCwd),
        Option.fromUndefinedOr(bootstrap?.autoBootstrapProjectFromCwd),
      ),
      () => mode === "web",
    );
    const logWebSocketEvents = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.logWebSocketEvents,
        Option.fromUndefinedOr(env.logWebSocketEvents),
        Option.fromUndefinedOr(bootstrap?.logWebSocketEvents),
      ),
      () => Boolean(devUrl),
    );
    const staticDir = devUrl ? undefined : yield* resolveStaticDir();
    const host = Option.getOrElse(
      resolveOptionPrecedence(
        normalizedFlags.host,
        Option.fromUndefinedOr(env.host),
        Option.fromUndefinedOr(bootstrap?.host),
      ),
      () => (mode === "desktop" ? "127.0.0.1" : undefined),
    );
    const logLevel = Option.getOrElse(cliLogLevel, () => env.logLevel);

    const config: ServerConfigShape = {
      logLevel,
      traceMinLevel: env.traceMinLevel,
      traceTimingEnabled: env.traceTimingEnabled,
      traceBatchWindowMs: env.traceBatchWindowMs,
      traceMaxBytes: env.traceMaxBytes,
      traceMaxFiles: env.traceMaxFiles,
      otlpTracesUrl:
        env.otlpTracesUrl ??
        bootstrap?.otlpTracesUrl ??
        persistedObservabilitySettings.otlpTracesUrl,
      otlpMetricsUrl:
        env.otlpMetricsUrl ??
        bootstrap?.otlpMetricsUrl ??
        persistedObservabilitySettings.otlpMetricsUrl,
      otlpExportIntervalMs: env.otlpExportIntervalMs,
      otlpServiceName: env.otlpServiceName,
      mode,
      port,
      cwd,
      baseDir,
      ...derivedPaths,
      serverTracePath,
      host,
      staticDir,
      devUrl,
      noBrowser,
      startupPresentation,
      desktopBootstrapToken,
      unsafeNoAuth,
      basicAuthUsername: env.basicAuthUsername?.trim() || undefined,
      basicAuthPassword: env.basicAuthPassword?.trim() || undefined,
      basicAuthRealm: env.basicAuthRealm.trim() || "T3 Code",
      supabaseProjectUrl: env.supabaseProjectUrl ?? bootstrap?.supabaseProjectUrl,
      supabaseAnonKey:
        env.supabaseAnonKey?.trim() || bootstrap?.supabaseAnonKey?.trim() || undefined,
      supabaseJwtAudience:
        env.supabaseJwtAudience?.trim() || bootstrap?.supabaseJwtAudience?.trim() || undefined,
      supabaseServiceRoleSecretName:
        env.supabaseServiceRoleSecretName?.trim() ||
        bootstrap?.supabaseServiceRoleSecretName?.trim() ||
        undefined,
      localPasswordAuth: env.localPasswordAuth,
      autoBootstrapProjectFromCwd,
      logWebSocketEvents,
    };

    return config;
  });

const resolveCliAuthConfig = (
  flags: CliAuthLocationFlags,
  cliLogLevel: Option.Option<LogLevel.LogLevel>,
) =>
  resolveServerConfig(
    {
      mode: Option.none(),
      port: Option.none(),
      host: Option.none(),
      baseDir: flags.baseDir,
      cwd: Option.none(),
      devUrl: flags.devUrl ?? Option.none(),
      noBrowser: Option.none(),
      unsafeNoAuth: Option.none(),
      bootstrapFd: Option.none(),
      autoBootstrapProjectFromCwd: Option.none(),
      logWebSocketEvents: Option.none(),
    },
    cliLogLevel,
  );

const DurationShorthandPattern = /^(?<value>\d+)(?<unit>ms|s|m|h|d|w)$/i;

const parseDurationInput = (value: string): Duration.Duration | null => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const shorthand = DurationShorthandPattern.exec(trimmed);
  const normalizedInput = shorthand?.groups
    ? (() => {
        const amountText = shorthand.groups.value;
        const unitText = shorthand.groups.unit;
        if (typeof amountText !== "string" || typeof unitText !== "string") {
          return null;
        }

        const amount = Number.parseInt(amountText, 10);
        if (!Number.isFinite(amount)) return null;

        switch (unitText.toLowerCase()) {
          case "ms":
            return `${amount} millis`;
          case "s":
            return `${amount} seconds`;
          case "m":
            return `${amount} minutes`;
          case "h":
            return `${amount} hours`;
          case "d":
            return `${amount} days`;
          case "w":
            return `${amount} weeks`;
          default:
            return null;
        }
      })()
    : (trimmed as Duration.Input);

  if (normalizedInput === null) return null;

  const decoded = Duration.fromInput(normalizedInput as Duration.Input);
  return Option.isSome(decoded) ? decoded.value : null;
};

const DurationFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.Duration,
    SchemaTransformation.transformOrFail({
      decode: (value) => {
        const duration = parseDurationInput(value);
        if (duration !== null) {
          return Effect.succeed(duration);
        }
        return Effect.fail(
          new SchemaIssue.InvalidValue(Option.some(value), {
            message: "Invalid duration. Use values like 5m, 1h, 30d, or 15 minutes.",
          }),
        );
      },
      encode: (duration) => Effect.succeed(Duration.format(duration)),
    }),
  ),
);

const runWithAuthControlPlane = <A, E>(
  flags: CliAuthLocationFlags,
  run: (authControlPlane: AuthControlPlaneShape) => Effect.Effect<A, E>,
  options?: {
    readonly quietLogs?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveCliAuthConfig(flags, logLevel);
    const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
    return yield* Effect.gen(function* () {
      const authControlPlane = yield* AuthControlPlane;
      return yield* run(authControlPlane);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(AuthControlPlaneRuntimeLive).pipe(
          Layer.provide(Layer.succeed(ServerConfig, config)),
          Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
        ),
      ),
    );
  });

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = Extract<
  ClientOrchestrationCommand,
  { type: "project.create" | "project.meta.update" | "project.delete" }
>;

const ProjectCliRuntimeLive = Layer.mergeAll(
  WorkspacePathsLive,
  OrchestrationLayerLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
  ),
);

const PROJECT_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(1);
const OrchestrationHttpErrorResponse = Schema.Struct({
  error: Schema.String,
});

const withProjectCliSessionToken = <A, E, R>(
  authControlPlane: AuthControlPlaneShape,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    authControlPlane.issueSession({
      role: "owner",
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => authControlPlane.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const withProjectCliLiveServerTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.timeout(PROJECT_CLI_LIVE_SERVER_TIMEOUT));

const runLiveServerRequest = <A, E extends Error, R>(
  request: HttpClientRequest.HttpClientRequest,
  handle: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const response = yield* httpClient.execute(request);
    return yield* handle(response);
  }).pipe(withProjectCliLiveServerTimeout);

const decodeOrchestrationReadModelResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationReadModel)(response);

const readErrorMessageFromResponse = (response: HttpClientResponse.HttpClientResponse) =>
  HttpClientResponse.schemaBodyJson(OrchestrationHttpErrorResponse)(response).pipe(
    Effect.map((body) => body.error),
    Effect.catch(() => Effect.succeed(null)),
    Effect.map((body) => {
      if (typeof body === "string" && body.trim().length > 0) {
        return body;
      }
      return `Server request failed with status ${response.status}.`;
    }),
  );

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* Effect.fail(new Error("Project title cannot be empty."));
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: OrchestrationReadModel;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* Effect.fail(new Error("Project identifier cannot be empty."));
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.exit(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  const normalizedWorkspaceRoot = Exit.isSuccess(normalizedWorkspaceRootResult)
    ? normalizedWorkspaceRootResult.value
    : null;

  const exactWorkspaceMatch =
    normalizedWorkspaceRoot === null
      ? undefined
      : activeProjects.find((project) => project.workspaceRoot === normalizedWorkspaceRoot);

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* Effect.fail(new Error(`No active project found for '${trimmedIdentifier}'.`));
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = (origin: string, bearerToken: string) =>
  runLiveServerRequest(
    HttpClientRequest.get(`${origin}/api/orchestration/snapshot`).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.bearerToken(bearerToken),
    ),
    HttpClientResponse.matchStatus({
      "2xx": decodeOrchestrationReadModelResponse,
      orElse: (response) =>
        readErrorMessageFromResponse(response).pipe(
          Effect.flatMap((message) => Effect.fail(new Error(message))),
        ),
    }),
  );

const dispatchLiveOrchestrationCommand = (
  origin: string,
  bearerToken: string,
  command: ProjectCliDispatchCommand,
) =>
  HttpClientRequest.post(`${origin}/api/orchestration/dispatch`).pipe(
    HttpClientRequest.acceptJson,
    HttpClientRequest.bearerToken(bearerToken),
    HttpClientRequest.bodyJson(command),
    Effect.flatMap((request) =>
      runLiveServerRequest(
        request,
        HttpClientResponse.matchStatus({
          "2xx": () => Effect.void,
          orElse: (response) =>
            readErrorMessageFromResponse(response).pipe(
              Effect.flatMap((message) => Effect.fail(new Error(message))),
            ),
        }),
      ),
    ),
  );

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  return yield* projectionSnapshotQuery.getSnapshot();
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (authControlPlane: AuthControlPlaneShape, config: ServerConfigShape) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withProjectCliSessionToken(authControlPlane, (token) =>
      fetchLiveOrchestrationSnapshot(runtimeState.value.origin, token).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.exit(attempt);
    if (Exit.isSuccess(attempted)) {
      return Option.some(attempted.value);
    }

    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: OrchestrationReadModel;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    FileSystem.FileSystem | HttpClient.HttpClient | Path.Path | WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const authControlPlane = yield* AuthControlPlane;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(authControlPlane, config);

    if (Option.isSome(liveMode)) {
      return yield* withProjectCliSessionToken(authControlPlane, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    const offlineRuntimeLayer = ProjectCliRuntimeLive.pipe(
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const orchestrationEngine = yield* OrchestrationEngineService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => orchestrationEngine.dispatch(command),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(offlineRuntimeLayer));
  }).pipe(
    Effect.provide(
      Layer.mergeAll(AuthControlPlaneRuntimeLive, WorkspacePathsLive).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const sharedServerLocationFlags = {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
} as const;

const projectLocationFlags = {
  baseDir: baseDirFlag,
} as const;

const sharedServerCommandFlags = {
  mode: modeFlag,
  port: portFlag,
  host: hostFlag,
  baseDir: baseDirFlag,
  cwd: Argument.string("cwd").pipe(
    Argument.withDescription(
      "Working directory for provider sessions (defaults to the current directory).",
    ),
    Argument.optional,
  ),
  devUrl: devUrlFlag,
  noBrowser: noBrowserFlag,
  unsafeNoAuth: unsafeNoAuthFlag,
  bootstrapFd: bootstrapFdFlag,
  autoBootstrapProjectFromCwd: autoBootstrapProjectFromCwdFlag,
  logWebSocketEvents: logWebSocketEventsFlag,
} as const;

const authLocationFlags = sharedServerLocationFlags;

const ttlFlag = Flag.string("ttl").pipe(
  Flag.withSchema(DurationFromString),
  Flag.withDescription("TTL, for example `5m`, `1h`, `30d`, or `15 minutes`."),
  Flag.optional,
);

const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Emit JSON instead of human-readable output."),
  Flag.withDefault(false),
);

const sessionRoleFlag = Flag.choice("role", ["owner", "client"]).pipe(
  Flag.withDescription("Role for the issued bearer session."),
  Flag.withDefault("owner"),
);

const labelFlag = Flag.string("label").pipe(
  Flag.withDescription("Optional human-readable label."),
  Flag.optional,
);

const subjectFlag = Flag.string("subject").pipe(
  Flag.withDescription("Optional session subject."),
  Flag.optional,
);

const baseUrlFlag = Flag.string("base-url").pipe(
  Flag.withDescription("Optional public base URL used to print a ready `/pair#token=...` link."),
  Flag.optional,
);

const tokenOnlyFlag = Flag.boolean("token-only").pipe(
  Flag.withDescription("Print only the issued bearer token."),
  Flag.withDefault(false),
);

const pairingCreateCommand = Command.make("create", {
  ...authLocationFlags,
  ttl: ttlFlag,
  label: labelFlag,
  baseUrl: baseUrlFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a new client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.createPairingLink({
            role: "client",
            subject: "one-time-token",
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
          });
          const output = formatIssuedPairingCredential(issued, {
            json: flags.json,
            ...(Option.isSome(flags.baseUrl) ? { baseUrl: flags.baseUrl.value } : {}),
          });
          yield* Console.log(output);
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active client pairing tokens without revealing their secrets."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const pairingLinks = yield* authControlPlane.listPairingLinks({ role: "client" });
          yield* Console.log(formatPairingCredentialList(pairingLinks, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const pairingRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  id: Argument.string("id").pipe(Argument.withDescription("Pairing credential id to revoke.")),
}).pipe(
  Command.withDescription("Revoke an active client pairing token."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokePairingLink(flags.id);
        yield* Console.log(
          revoked
            ? `Revoked pairing credential ${flags.id}.\n`
            : `No active pairing credential found for ${flags.id}.\n`,
        );
      }),
    ),
  ),
);

const pairingCommand = Command.make("pairing").pipe(
  Command.withDescription("Manage one-time client pairing tokens."),
  Command.withSubcommands([pairingCreateCommand, pairingListCommand, pairingRevokeCommand]),
);

const sessionIssueCommand = Command.make("issue", {
  ...authLocationFlags,
  ttl: ttlFlag,
  role: sessionRoleFlag,
  label: labelFlag,
  subject: subjectFlag,
  tokenOnly: tokenOnlyFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription("Issue a bearer session token for headless or remote clients."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const issued = yield* authControlPlane.issueSession({
            role: flags.role,
            ...(Option.isSome(flags.ttl) ? { ttl: flags.ttl.value } : {}),
            ...(Option.isSome(flags.label) ? { label: flags.label.value } : {}),
            ...(Option.isSome(flags.subject) ? { subject: flags.subject.value } : {}),
          });
          yield* Console.log(
            formatIssuedSession(issued, {
              json: flags.json,
              tokenOnly: flags.tokenOnly,
            }),
          );
        }),
      {
        quietLogs: flags.json || flags.tokenOnly,
      },
    ),
  ),
);

const sessionListCommand = Command.make("list", {
  ...authLocationFlags,
  json: jsonFlag,
}).pipe(
  Command.withDescription("List active sessions without revealing bearer tokens."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(
      flags,
      (authControlPlane) =>
        Effect.gen(function* () {
          const sessions = yield* authControlPlane.listSessions();
          yield* Console.log(formatSessionList(sessions, { json: flags.json }));
        }),
      {
        quietLogs: flags.json,
      },
    ),
  ),
);

const sessionRevokeCommand = Command.make("revoke", {
  ...authLocationFlags,
  sessionId: Argument.string("session-id").pipe(
    Argument.withDescription("Session id to revoke."),
    Argument.withSchema(AuthSessionId),
  ),
}).pipe(
  Command.withDescription("Revoke an active session."),
  Command.withHandler((flags) =>
    runWithAuthControlPlane(flags, (authControlPlane) =>
      Effect.gen(function* () {
        const revoked = yield* authControlPlane.revokeSession(flags.sessionId);
        yield* Console.log(
          revoked
            ? `Revoked session ${flags.sessionId}.\n`
            : `No active session found for ${flags.sessionId}.\n`,
        );
      }),
    ),
  ),
);

const sessionCommand = Command.make("session").pipe(
  Command.withDescription("Manage bearer sessions."),
  Command.withSubcommands([sessionIssueCommand, sessionListCommand, sessionRevokeCommand]),
);

const authCommand = Command.make("auth").pipe(
  Command.withDescription("Manage the local auth control plane for headless deployments."),
  Command.withSubcommands([pairingCommand, sessionCommand]),
);

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.string("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.string("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* Effect.fail(
            new Error(`An active project already exists for '${workspaceRoot}'.`),
          );
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(crypto.randomUUID());
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId,
          title,
          workspaceRoot,
          defaultModelSelection: getAutoBootstrapDefaultModelSelection(),
          createdAt: new Date().toISOString(),
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.string("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.string("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: OrchestrationReadModel;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.meta.update",
          commandId: CommandId.make(crypto.randomUUID()),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([projectAddCommand, projectRemoveCommand, projectRenameCommand]),
);

const runDeployCommand = Effect.fn("runDeployCommand")(function* (
  flags: { readonly baseDir: Option.Option<string> },
  run: (deploy: DeployServiceShape) => Effect.Effect<string, Error>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const deploy = yield* DeployService;
    const output = yield* run(deploy);
    yield* Console.log(output);
  }).pipe(
    Effect.provide(
      DeployServiceLive.pipe(
        Layer.provide(DeployRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive))),
        Layer.provide(ServerSecretStoreLive),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error" as const)),
      ),
    ),
  );
});

const formatDeployTarget = (target: DeployTarget): string => {
  const location =
    target.kind === "ssh" && target.ssh
      ? `ssh ${target.ssh.user}@${target.ssh.host}${target.ssh.remotePath ? `:${target.ssh.remotePath}` : ""}`
      : "local";
  return `${target.id}  ${target.name}  [${location}]  ${target.command}`;
};

const deployListCommand = Command.make("list", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  project: Flag.string("project").pipe(
    Flag.withDescription("Only list targets for this project id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List deploy targets."),
  Command.withHandler((flags) =>
    runDeployCommand(flags, (deploy) =>
      deploy
        .listTargets(
          Option.isSome(flags.project) ? { projectId: ProjectId.make(flags.project.value) } : {},
        )
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.map((targets) =>
            targets.length === 0
              ? "No deploy targets configured."
              : targets.map(formatDeployTarget).join("\n"),
          ),
        ),
    ),
  ),
);

const deployAddCommand = Command.make("add", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  project: Flag.string("project").pipe(Flag.withDescription("Project id to attach the target to.")),
  name: Flag.string("name").pipe(Flag.withDescription("Human readable target name.")),
  command: Flag.string("command").pipe(Flag.withDescription("Command to execute when deploying.")),
  sshHost: Flag.string("ssh-host").pipe(
    Flag.withDescription("Deploy over SSH to this host."),
    Flag.optional,
  ),
  sshUser: Flag.string("ssh-user").pipe(
    Flag.withDescription("SSH user (required with --ssh-host)."),
    Flag.optional,
  ),
  sshPath: Flag.string("ssh-path").pipe(
    Flag.withDescription("Remote directory to run the command in."),
    Flag.optional,
  ),
  sshPasswordSecret: Flag.string("ssh-password-secret").pipe(
    Flag.withDescription("Secret store name holding the SSH password."),
    Flag.optional,
  ),
  sshIdentityFile: Flag.string("ssh-identity-file").pipe(
    Flag.withDescription("Path to an SSH private key."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Add a deploy target."),
  Command.withHandler((flags) =>
    runDeployCommand(flags, (deploy) => {
      const host = Option.getOrUndefined(flags.sshHost);
      const user = Option.getOrUndefined(flags.sshUser);
      if (host !== undefined && user === undefined) {
        return Effect.fail(new Error("--ssh-user is required when --ssh-host is provided."));
      }
      const remotePath = Option.getOrUndefined(flags.sshPath);
      const passwordSecretName = Option.getOrUndefined(flags.sshPasswordSecret);
      const identityFile = Option.getOrUndefined(flags.sshIdentityFile);
      return deploy
        .createTarget({
          projectId: ProjectId.make(flags.project),
          name: flags.name,
          command: flags.command,
          kind: host !== undefined ? "ssh" : "command",
          ...(host !== undefined && user !== undefined
            ? {
                ssh: {
                  host,
                  user,
                  ...(remotePath !== undefined ? { remotePath } : {}),
                  ...(passwordSecretName !== undefined ? { passwordSecretName } : {}),
                  ...(identityFile !== undefined ? { identityFile } : {}),
                },
              }
            : {}),
        })
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.map((target) => `Added deploy target ${target.id} (${target.name}).`),
        );
    }),
  ),
);

const deployRunCommand = Command.make("run", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  target: Argument.string("target").pipe(Argument.withDescription("Deploy target id to run.")),
}).pipe(
  Command.withDescription("Run a deploy target from the current working directory."),
  Command.withHandler((flags) =>
    runDeployCommand(flags, (deploy) =>
      deploy
        .run({
          targetId: DeployTargetId.make(flags.target),
          actor: { label: "cli" },
          workspaceRoot: process.cwd(),
        })
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.flatMap((deployRun) =>
            deployRun.status === "succeeded"
              ? Effect.succeed(`Deploy ${deployRun.id} succeeded.\n${deployRun.output}`.trimEnd())
              : Effect.fail(
                  new Error(
                    `Deploy ${deployRun.id} failed (exit ${deployRun.exitCode ?? "unknown"}).\n${deployRun.output}`.trimEnd(),
                  ),
                ),
          ),
        ),
    ),
  ),
);

const deployRunsCommand = Command.make("runs", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  target: Flag.string("target").pipe(
    Flag.withDescription("Only show runs for this target id."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Show recent deploy runs."),
  Command.withHandler((flags) =>
    runDeployCommand(flags, (deploy) =>
      deploy
        .listRuns(
          Option.isSome(flags.target)
            ? { targetId: DeployTargetId.make(flags.target.value), limit: 20 }
            : { limit: 20 },
        )
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.map((runs) =>
            runs.length === 0
              ? "No deploy runs recorded."
              : runs
                  .map(
                    (entry) =>
                      `${entry.startedAt}  ${entry.status.padEnd(9)}  ${entry.targetId}  by ${entry.triggeredBy}`,
                  )
                  .join("\n"),
          ),
        ),
    ),
  ),
);

const runAnalyticsCommand = Effect.fn("runAnalyticsCommand")(function* (
  flags: { readonly baseDir: Option.Option<string> },
  run: (analytics: AnalyticsStoreShape) => Effect.Effect<string, Error>,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  return yield* Effect.gen(function* () {
    const analytics = yield* AnalyticsStore;
    const output = yield* run(analytics);
    yield* Console.log(output);
  }).pipe(
    Effect.provide(
      AnalyticsStoreLive.pipe(
        Layer.provide(AnalyticsRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive))),
        Layer.provide(Layer.succeed(ServerConfig, config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, "Error" as const)),
      ),
    ),
  );
});

class AnalyticsPropertiesError extends Data.TaggedError("AnalyticsPropertiesError")<{
  readonly cause: unknown;
}> {}

/**
 * Properties as `name:type:required` triples, so declaring a stream stays one
 * command. The shape is the point of the contract, so it cannot be optional.
 */
function parseAnalyticsProperties(raw: string): ReadonlyArray<{
  name: string;
  type: "string" | "number" | "boolean";
  purpose: string;
  required: boolean;
}> {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      const [name = "", type = "string", required = "false"] = entry.split(":");
      if (type !== "string" && type !== "number" && type !== "boolean") {
        throw new Error(`${name} has type ${type}; expected string, number or boolean.`);
      }
      return {
        name,
        type,
        purpose: name,
        required: required === "true" || required === "required",
      };
    });
}

const analyticsDeclareCommand = Command.make("declare", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  project: Flag.string("project").pipe(Flag.withDescription("Project the stream belongs to.")),
  name: Flag.string("name").pipe(Flag.withDescription("Stream name, e.g. page.view.")),
  purpose: Flag.string("purpose").pipe(Flag.withDescription("What the stream is for.")),
  properties: Flag.string("properties").pipe(
    Flag.withDescription(
      "Comma separated name:type:required, e.g. path:string:required,seconds:number.",
    ),
  ),
}).pipe(
  Command.withDescription("Declare an event stream and print its ingest key once."),
  Command.withHandler((flags) =>
    runAnalyticsCommand(flags, (analytics) =>
      Effect.try({
        try: () => parseAnalyticsProperties(flags.properties),
        catch: (cause) => new AnalyticsPropertiesError({ cause }),
      }).pipe(
        Effect.mapError((error) => new Error(String(error.cause))),
        Effect.flatMap((properties) =>
          analytics
            .declareStream({
              projectId: ProjectId.make(flags.project),
              name: flags.name as never,
              purpose: flags.purpose,
              properties: properties as never,
            })
            .pipe(
              Effect.mapError((error) => new Error(error.message)),
              Effect.map(
                (result) =>
                  `Declared ${result.stream.name} (${result.stream.id}).\nIngest key (shown once): ${result.ingestKey}`,
              ),
            ),
        ),
      ),
    ),
  ),
);

const analyticsListCommand = Command.make("list", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  project: Flag.string("project").pipe(
    Flag.withDescription("Only list streams for this project."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("List declared event streams."),
  Command.withHandler((flags) =>
    runAnalyticsCommand(flags, (analytics) => {
      const projectId = Option.getOrUndefined(flags.project);
      return analytics
        .listStreams(projectId === undefined ? {} : { projectId: ProjectId.make(projectId) })
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.map((result) =>
            result.streams.length === 0
              ? "No streams declared."
              : result.streams
                  .map(
                    (stream) =>
                      `${stream.name}  ${stream.properties.map((property) => `${property.name}:${property.type}`).join(",")}`,
                  )
                  .join("\n"),
          ),
        );
    }),
  ),
);

const analyticsQueryCommand = Command.make("query", {
  baseDir: baseDirFlag,
  devUrl: devUrlFlag,
  project: Flag.string("project").pipe(Flag.withDescription("Project the stream belongs to.")),
  stream: Flag.string("stream").pipe(Flag.withDescription("Stream to ask about.")),
  aggregate: Flag.string("aggregate").pipe(
    Flag.withDescription("count, sum, avg, min or max."),
    Flag.withDefault("count"),
  ),
  value: Flag.string("value").pipe(
    Flag.withDescription("Numeric property to aggregate. Required for everything but count."),
    Flag.optional,
  ),
  groupBy: Flag.string("group-by").pipe(
    Flag.withDescription("Property to split the result by."),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Ask an aggregate question of a stream."),
  Command.withHandler((flags) =>
    runAnalyticsCommand(flags, (analytics) => {
      const value = Option.getOrUndefined(flags.value);
      const groupBy = Option.getOrUndefined(flags.groupBy);
      return analytics
        .query({
          projectId: ProjectId.make(flags.project),
          stream: flags.stream as never,
          aggregate: flags.aggregate as never,
          ...(value === undefined ? {} : { valueProperty: value as never }),
          ...(groupBy === undefined ? {} : { groupBy: groupBy as never }),
        })
        .pipe(
          Effect.mapError((error) => new Error(error.message)),
          Effect.map((result) =>
            result.buckets.length === 0
              ? "No events yet."
              : result.buckets
                  .map(
                    (bucket) =>
                      `${bucket.group ?? "all"}  ${bucket.value}  (${bucket.events} events)`,
                  )
                  .join("\n"),
          ),
        );
    }),
  ),
);

const analyticsCommand = Command.make("analytics").pipe(
  Command.withDescription("Declare event streams and ask questions of them."),
  Command.withSubcommands([analyticsDeclareCommand, analyticsListCommand, analyticsQueryCommand]),
);

const deployCommand = Command.make("deploy").pipe(
  Command.withDescription("Manage and run deploy targets."),
  Command.withSubcommands([
    deployListCommand,
    deployAddCommand,
    deployRunCommand,
    deployRunsCommand,
  ]),
);

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    const config = yield* resolveServerConfig(flags, logLevel, options);
    return yield* runServer.pipe(Effect.provideService(ServerConfig, config));
  });

/**
 * Finding and reading packs from the CLI the workspace already runs.
 *
 * A pack is only useful if whoever is doing the work can go and get it. The
 * agent has a shell and this binary, so `t3 pack search` / `t3 pack show` is
 * the whole mechanism: it looks for a pack when it needs one and reads the
 * knowledge out, rather than having every pack pushed into its context whether
 * relevant or not. `t3-pack` can do this too, but it is not on PATH inside
 * somebody's project — this binary is.
 *
 * The work is pack-cli's; this only builds the context it needs and prints the
 * answer, so the two CLIs cannot drift apart.
 */
function packRegistryRoot(explicit: string | undefined): string {
  const fromEnvironment = process.env["T3CODE_PACK_REGISTRY"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (fromEnvironment !== undefined && fromEnvironment.length > 0) return fromEnvironment;
  const home = process.env["T3CODE_HOME"];
  return `${home !== undefined && home.length > 0 ? home : `${homedir()}/.t3code`}/packs`;
}

class PackCommandError extends Data.TaggedError("PackCommandError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function runPackCommand(
  command: Parameters<typeof runPackCliCommand>[0],
  registryRoot: string | undefined,
): Effect.Effect<string, PackCommandError> {
  return Effect.tryPromise({
    try: async () => {
      const store = makeNodePackStore();
      const outcome = await runPackCliCommand(command, {
        store,
        registry: makeDirectoryRegistry(store, packRegistryRoot(registryRoot)),
        cwd: process.cwd(),
        now: () => new Date(),
        newId: (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      });
      return outcome.human;
    },
    catch: (cause) =>
      new PackCommandError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

const packRegistryFlag = Flag.string("registry").pipe(
  Flag.withDescription("Registry directory to read packs from."),
  Flag.optional,
);

const packSearchCommand = Command.make("search", {
  registry: packRegistryFlag,
  query: Argument.string("query").pipe(
    Argument.withDescription('What the pack should help with, e.g. "deploy".'),
  ),
}).pipe(
  Command.withDescription("Find a pack that covers a capability."),
  Command.withHandler((flags) =>
    runPackCommand(
      { kind: "search", query: flags.query, limit: 10, category: undefined, tag: undefined },
      Option.getOrUndefined(flags.registry),
    ).pipe(Effect.flatMap((text) => Console.log(text))),
  ),
);

const packShowCommand = Command.make("show", {
  registry: packRegistryFlag,
  pack: Argument.string("pack").pipe(Argument.withDescription("Pack name to read.")),
}).pipe(
  Command.withDescription("Read a pack: what it does, what it needs, and how to use it."),
  Command.withHandler((flags) =>
    runPackCommand(
      { kind: "show", pack: flags.pack, version: undefined },
      Option.getOrUndefined(flags.registry),
    ).pipe(Effect.flatMap((text) => Console.log(text))),
  ),
);

const packCommand = Command.make("pack").pipe(
  Command.withDescription("Find and read packs: reusable knowledge for a task."),
  Command.withSubcommands([packSearchCommand, packShowCommand]),
);

const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
);

const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless access details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);

export const cli = Command.make("t3", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags)),
  Command.withSubcommands([
    startCommand,
    serveCommand,
    authCommand,
    projectCommand,
    deployCommand,
    analyticsCommand,
    packCommand,
  ]),
);
