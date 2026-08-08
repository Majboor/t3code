/**
 * Promise-based T3 Code client.
 *
 * Wraps the websocket RPC surface so callers can script workspaces, projects,
 * threads, git, and deploys without depending on Effect.
 *
 * @module client
 */
import {
  type CollaborationInviteAcceptResult,
  type CollaborationInviteCreateResult,
  type DeployRun,
  type DeployTarget,
  type DeployTargetId,
  InviteId,
  type OrchestrationShellSnapshot,
  type OrganizationListResult,
  type ProjectId,
  type TenantId,
  type TenantRole,
  type ThreadId,
  type WorkspaceCreateResult,
  type WorkspaceId,
} from "@t3tools/contracts";

import { createT3Api, type T3Api } from "./api/index.ts";
import {
  authenticate,
  deriveWebSocketUrl,
  getSessionState,
  issueWebSocketToken,
  type T3Credentials,
  type T3Session,
  type T3SessionState,
} from "./auth.ts";
import { T3Connection } from "./transport.ts";

export interface T3ClientOptions {
  /** Base HTTP URL of the T3 server, e.g. http://127.0.0.1:13773 */
  readonly baseUrl: string;
  readonly credentials?: T3Credentials;
  /** Shorthand for `credentials: { kind: "bearer", token }`. */
  readonly token?: string;
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

function resolveCredentials(options: T3ClientOptions): T3Credentials {
  if (options.credentials) {
    return options.credentials;
  }
  if (options.token) {
    return { kind: "bearer", token: options.token };
  }
  throw new Error("Connecting needs either `credentials` or `token`.");
}

/**
 * Connected client. Create one with {@link connect} and always `close()` it,
 * otherwise the websocket keeps the process alive.
 *
 * The grouped API on `workspace`, `threads`, `history`, `changes`,
 * `collaboration`, `packs`, `organizations`, `deploys`, `terminals`, `providers`, and
 * `server` covers the whole surface; the flat methods below are shorthands for
 * the handful of things scripts reach for first.
 */
export class T3Client implements T3Api {
  private readonly connection: T3Connection;
  private readonly api: T3Api;
  readonly session: T3Session;
  private readonly baseUrl: string;

  readonly workspace: T3Api["workspace"];
  readonly threads: T3Api["threads"];
  readonly history: T3Api["history"];
  readonly changes: T3Api["changes"];
  readonly collaboration: T3Api["collaboration"];
  readonly packs: T3Api["packs"];
  readonly organizations: T3Api["organizations"];
  readonly deploys: T3Api["deploys"];
  readonly terminals: T3Api["terminals"];
  readonly providers: T3Api["providers"];
  readonly server: T3Api["server"];

  private constructor(input: {
    readonly connection: T3Connection;
    readonly session: T3Session;
    readonly baseUrl: string;
  }) {
    this.connection = input.connection;
    this.session = input.session;
    this.baseUrl = input.baseUrl;
    this.api = createT3Api(input.connection);
    this.workspace = this.api.workspace;
    this.threads = this.api.threads;
    this.history = this.api.history;
    this.changes = this.api.changes;
    this.collaboration = this.api.collaboration;
    this.packs = this.api.packs;
    this.organizations = this.api.organizations;
    this.deploys = this.api.deploys;
    this.terminals = this.api.terminals;
    this.providers = this.api.providers;
    this.server = this.api.server;
  }

  static async connect(options: T3ClientOptions): Promise<T3Client> {
    const session = await authenticate(options.baseUrl, resolveCredentials(options));
    const wsToken = await issueWebSocketToken(options.baseUrl, session.token);
    const connection = await T3Connection.open(deriveWebSocketUrl(options.baseUrl, wsToken));
    return new T3Client({ connection, session, baseUrl: options.baseUrl });
  }

  /** Current auth + tenant state for this session. */
  getSessionState(): Promise<T3SessionState> {
    return getSessionState(this.baseUrl, this.session.token);
  }

  // ── Workspaces and organizations ──

  /** Organizations, tenants, workspaces, and memberships visible to this session. */
  listOrganizations(): Promise<OrganizationListResult> {
    return this.api.organizations.list();
  }

  listWorkspaces(): Promise<OrganizationListResult["workspaces"]> {
    return this.api.workspace.listWorkspaces();
  }

  createWorkspace(input: CreateWorkspaceInput): Promise<WorkspaceCreateResult> {
    return this.api.workspace.createWorkspace({
      tenantId: input.tenantId,
      title: input.title,
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.accessMode ? { accessMode: input.accessMode } : {}),
    });
  }

  // ── Collaboration ──

  inviteToWorkspace(input: InviteToWorkspaceInput): Promise<CollaborationInviteCreateResult> {
    return this.api.collaboration.createInvite({
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      email: input.email,
      scope: "workspace",
      roles: [...(input.roles ?? ["developer"])] as [TenantRole, ...TenantRole[]],
      expiresAt: input.expiresAt ?? new Date(Date.now() + DEFAULT_INVITE_TTL_MS).toISOString(),
    });
  }

  acceptInvite(inviteId: string): Promise<CollaborationInviteAcceptResult> {
    return this.api.collaboration.acceptInvite({ inviteId: InviteId.make(inviteId) });
  }

  // ── Projects, threads, agents ──

  /** Projects and threads visible to this session. */
  getShellSnapshot(): Promise<OrchestrationShellSnapshot> {
    return this.api.workspace.getSnapshot();
  }

  listProjects(): Promise<OrchestrationShellSnapshot["projects"]> {
    return this.api.workspace.listProjects();
  }

  /** Register a folder as a project in the caller's workspace. */
  addProject(input: {
    readonly workspaceRoot: string;
    readonly title: string;
  }): Promise<ProjectId> {
    return this.api.workspace.registerProject({
      workspaceRoot: input.workspaceRoot,
      title: input.title,
      defaultModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
  }

  /** Send a prompt to an existing thread's agent. */
  promptAgent(input: PromptAgentInput) {
    return this.api.threads.startTurn({ threadId: input.threadId, prompt: input.prompt });
  }

  // ── Git ──

  /** Merge or rebase a branch into the checkout at `cwd`, reporting conflicts. */
  mergeBranch(input: {
    readonly cwd: string;
    readonly branch: string;
    readonly mode?: "merge" | "rebase";
  }) {
    return this.api.changes.mergeBranch({
      cwd: input.cwd,
      branch: input.branch,
      ...(input.mode ? { mode: input.mode } : {}),
    });
  }

  /** Report whether a merge or rebase is in progress and which paths conflict. */
  getMergeState(cwd: string) {
    return this.api.changes.getMergeState({ cwd });
  }

  abortMerge(cwd: string) {
    return this.api.changes.abortMerge({ cwd });
  }

  // ── Deploys ──

  async listDeployTargets(projectId?: ProjectId): Promise<ReadonlyArray<DeployTarget>> {
    const result = await this.api.deploys.listTargets(projectId !== undefined ? { projectId } : {});
    return result.targets;
  }

  async createDeployTarget(input: {
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
    const result = await this.api.deploys.createTarget({
      projectId: input.projectId,
      name: input.name,
      command: input.command,
      kind: input.ssh ? "ssh" : "command",
      ...(input.ssh ? { ssh: input.ssh } : {}),
    });
    return result.target;
  }

  /** Run a deploy target. Resolves with the finished run, including its output. */
  async runDeploy(targetId: DeployTargetId): Promise<DeployRun> {
    const result = await this.api.deploys.run({ targetId });
    return result.run;
  }

  async listDeployRuns(input?: {
    readonly projectId?: ProjectId;
    readonly targetId?: DeployTargetId;
    readonly limit?: number;
  }): Promise<ReadonlyArray<DeployRun>> {
    const result = await this.api.deploys.listRuns({
      ...(input?.projectId !== undefined ? { projectId: input.projectId } : {}),
      ...(input?.targetId !== undefined ? { targetId: input.targetId } : {}),
      ...(input?.limit !== undefined ? { limit: input.limit } : {}),
    });
    return result.runs;
  }

  close(): Promise<void> {
    return this.connection.close();
  }
}

/** Connect to a T3 server and return a ready client. */
export function connect(options: T3ClientOptions): Promise<T3Client> {
  return T3Client.connect(options);
}
