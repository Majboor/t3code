/**
 * Promise-based T3 Code client.
 *
 * Wraps the websocket RPC surface so callers can script workspaces, packs,
 * agents, and deploys without depending on Effect.
 *
 * @module client
 */
import {
  type CollaborationInviteAcceptResult,
  type CollaborationInviteCreateResult,
  type CommandId,
  InviteId,
  ORCHESTRATION_WS_METHODS,
  type DeployRun,
  type DeployTarget,
  type DeployTargetId,
  type OrchestrationShellSnapshot,
  type OrganizationListResult,
  type ProjectId,
  type TenantId,
  type TenantRole,
  type ThreadId,
  type WorkspaceCreateResult,
  type WorkspaceId,
  WsRpcGroup,
  WS_METHODS,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Scope, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import * as Socket from "effect/unstable/socket/Socket";

import {
  authenticate,
  deriveWebSocketUrl,
  getSessionState,
  issueWebSocketToken,
  type T3Credentials,
  type T3Session,
  type T3SessionState,
} from "./auth.ts";

const makeRpcClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeRpcClient;
type T3RpcClient =
  RpcClientFactory extends Effect.Effect<infer Client, infer _E, infer _R> ? Client : never;

export interface T3ClientOptions {
  /** Base HTTP URL of the T3 server, e.g. http://127.0.0.1:13773 */
  readonly baseUrl: string;
  readonly credentials: T3Credentials;
}

export interface CreateWorkspaceInput {
  readonly tenantId: TenantId;
  readonly title: string;
  readonly kind?: "personal" | "shared" | "corporate" | "support";
  readonly accessMode?: "private" | "invite-only" | "organization";
}

export interface InviteToWorkspaceInput {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly email: string;
  readonly roles?: ReadonlyArray<"owner" | "admin" | "developer" | "pm" | "support" | "viewer">;
  /** Defaults to seven days from now. */
  readonly expiresAt?: string;
}

export interface PromptAgentInput {
  readonly threadId: ThreadId;
  readonly prompt: string;
}

const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Connected client. Create one with {@link connect} and always `close()` it,
 * otherwise the websocket keeps the process alive.
 */
export class T3Client {
  private readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
  private readonly clientScope: Scope.Closeable;
  private readonly client: T3RpcClient;
  readonly session: T3Session;
  private readonly baseUrl: string;

  private constructor(input: {
    readonly runtime: ManagedRuntime.ManagedRuntime<RpcClient.Protocol, never>;
    readonly clientScope: Scope.Closeable;
    readonly client: T3RpcClient;
    readonly session: T3Session;
    readonly baseUrl: string;
  }) {
    this.runtime = input.runtime;
    this.clientScope = input.clientScope;
    this.client = input.client;
    this.session = input.session;
    this.baseUrl = input.baseUrl;
  }

  static async connect(options: T3ClientOptions): Promise<T3Client> {
    const session = await authenticate(options.baseUrl, options.credentials);
    const wsToken = await issueWebSocketToken(options.baseUrl, session.token);
    const socketUrl = deriveWebSocketUrl(options.baseUrl, wsToken);

    const protocolLayer = RpcClient.layerProtocolSocket({ retryTransientErrors: false }).pipe(
      Layer.provide(
        Layer.mergeAll(
          Socket.layerWebSocket(socketUrl).pipe(
            Layer.provide(
              Layer.succeed(
                Socket.WebSocketConstructor,
                (url, protocols) =>
                  new globalThis.WebSocket(url, protocols as string | string[] | undefined),
              ),
            ),
          ),
          RpcSerialization.layerJson,
        ),
      ),
    );
    const runtime = ManagedRuntime.make(protocolLayer);
    // The RPC client lives for the lifetime of the connection, so it gets its
    // own scope closed by close() rather than being scoped per call.
    const clientScope = runtime.runSync(Scope.make());
    const client = await runtime.runPromise(Scope.provide(clientScope)(makeRpcClient));
    return new T3Client({ runtime, clientScope, client, session, baseUrl: options.baseUrl });
  }

  private run<A>(execute: (client: T3RpcClient) => Effect.Effect<A, unknown, never>): Promise<A> {
    return this.runtime.runPromise(
      Effect.suspend(() => execute(this.client)).pipe(
        Effect.mapError((cause) =>
          cause instanceof Error
            ? cause
            : new Error(String((cause as { message?: string })?.message ?? cause)),
        ),
      ) as Effect.Effect<A, Error, never>,
    );
  }

  /** Current auth + tenant state for this session. */
  getSessionState(): Promise<T3SessionState> {
    return getSessionState(this.baseUrl, this.session.token);
  }

  // ── Workspaces and organizations ──

  /** Organizations, tenants, workspaces, and memberships visible to this session. */
  listOrganizations(): Promise<OrganizationListResult> {
    return this.run((client) => client[WS_METHODS.organizationsList]({}));
  }

  async listWorkspaces(): Promise<OrganizationListResult["workspaces"]> {
    const snapshot = await this.listOrganizations();
    return snapshot.workspaces ?? [];
  }

  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceCreateResult> {
    return this.run((client) =>
      client[WS_METHODS.workspacesCreate]({
        tenantId: input.tenantId,
        title: input.title,
        ...(input.kind ? { kind: input.kind } : {}),
        ...(input.accessMode ? { accessMode: input.accessMode } : {}),
      }),
    );
  }

  // ── Collaboration ──

  inviteToWorkspace(input: InviteToWorkspaceInput): Promise<CollaborationInviteCreateResult> {
    return this.run((client) =>
      client[WS_METHODS.collaborationInvitesCreate]({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        email: input.email,
        scope: "workspace",
        roles: [...(input.roles ?? ["developer"])] as [TenantRole, ...TenantRole[]],
        expiresAt: input.expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString(),
      }),
    );
  }

  acceptInvite(inviteId: string): Promise<CollaborationInviteAcceptResult> {
    return this.run((client) =>
      client[WS_METHODS.collaborationInvitesAccept]({ inviteId: InviteId.make(inviteId) }),
    );
  }

  // ── Projects, threads, agents ──

  /** Projects and threads visible to this session. */
  getShellSnapshot(): Promise<OrchestrationShellSnapshot> {
    // The shell subscription is a stream whose first item is the snapshot;
    // take that one item and let the stream close.
    return this.run((client) =>
      Stream.runHead(client[ORCHESTRATION_WS_METHODS.subscribeShell]({})).pipe(
        Effect.flatMap((head) =>
          head._tag === "Some" && head.value.kind === "snapshot"
            ? Effect.succeed(head.value.snapshot)
            : Effect.fail(new Error("Server closed the shell stream before sending a snapshot.")),
        ),
      ),
    );
  }

  async listProjects(): Promise<OrchestrationShellSnapshot["projects"]> {
    const snapshot = await this.getShellSnapshot();
    return snapshot.projects;
  }

  /** Send a prompt to an existing thread's agent. */
  promptAgent(input: PromptAgentInput): Promise<unknown> {
    return this.run((client) =>
      client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
        type: "thread.turn.start",
        commandId: crypto.randomUUID() as CommandId,
        threadId: input.threadId,
        prompt: input.prompt,
      } as never),
    );
  }

  // ── Deploys ──

  listDeployTargets(projectId?: ProjectId): Promise<ReadonlyArray<DeployTarget>> {
    return this.run((client) =>
      client[WS_METHODS.deployListTargets](projectId !== undefined ? { projectId } : {}).pipe(
        Effect.map((result) => result.targets),
      ),
    );
  }

  createDeployTarget(input: {
    readonly projectId: ProjectId;
    readonly name: string;
    readonly command: string;
    readonly ssh?: {
      readonly host: string;
      readonly user: string;
      readonly port?: number;
      readonly remotePath?: string;
      readonly identityFile?: string;
      readonly passwordSecretName?: string;
    };
  }): Promise<DeployTarget> {
    return this.run((client) =>
      client[WS_METHODS.deployCreateTarget]({
        projectId: input.projectId,
        name: input.name,
        command: input.command,
        kind: input.ssh ? "ssh" : "command",
        ...(input.ssh ? { ssh: input.ssh } : {}),
      }).pipe(Effect.map((result) => result.target)),
    );
  }

  /** Run a deploy target. Resolves with the finished run, including its output. */
  runDeploy(targetId: DeployTargetId): Promise<DeployRun> {
    return this.run((client) =>
      client[WS_METHODS.deployRun]({ targetId }).pipe(Effect.map((result) => result.run)),
    );
  }

  listDeployRuns(input?: {
    readonly projectId?: ProjectId;
    readonly targetId?: DeployTargetId;
    readonly limit?: number;
  }): Promise<ReadonlyArray<DeployRun>> {
    return this.run((client) =>
      client[WS_METHODS.deployListRuns]({
        ...(input?.projectId !== undefined ? { projectId: input.projectId } : {}),
        ...(input?.targetId !== undefined ? { targetId: input.targetId } : {}),
        ...(input?.limit !== undefined ? { limit: input.limit } : {}),
      }).pipe(Effect.map((result) => result.runs)),
    );
  }

  async close(): Promise<void> {
    await this.runtime
      .runPromise(Scope.close(this.clientScope, Effect.void as never))
      .catch(() => undefined);
    await this.runtime.dispose();
  }
}

/** Connect to a T3 server and return a ready client. */
export function connect(options: T3ClientOptions): Promise<T3Client> {
  return T3Client.connect(options);
}
