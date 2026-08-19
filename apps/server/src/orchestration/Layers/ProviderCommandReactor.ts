import {
  type ChatAttachment,
  AuthSessionId,
  CommandId,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ProviderKind,
  type OrchestrationSession,
  ThreadId,
  type ProviderAccount,
  type ProviderSession,
  type ProviderSessionIsolation,
  type TenantSessionContext,
  type RuntimeMode,
  type TurnId,
  type UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { isTemporaryWorktreeBranch, WORKTREE_BRANCH_PREFIX } from "@t3tools/shared/git";
import {
  deriveProviderLaunchEnvironment,
  filterProviderLaunchBaseEnv,
} from "@t3tools/shared/tenancy";
import { Cache, Cause, Duration, Effect, Equal, Layer, Option, Schema, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { ServerConfig } from "../../config.ts";
import { resolveProviderAccount } from "../../providerAuth/resolveProviderAccount.ts";
import type { ProviderAuthProvider } from "../../providerAuth/store.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { increment, orchestrationEventsProcessedTotal } from "../../observability/Metrics.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderServiceError } from "../../provider/Errors.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderCommandReactor,
  type ProviderCommandReactorShape,
} from "../Services/ProviderCommandReactor.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

type ProviderIntentEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.runtime-mode-set"
      | "thread.turn-start-requested"
      | "thread.turn-interrupt-requested"
      | "thread.approval-response-requested"
      | "thread.user-input-response-requested"
      | "thread.session-stop-requested";
  }
>;

function toNonEmptyProviderInput(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function mapProviderSessionStatusToOrchestrationStatus(
  status: "connecting" | "ready" | "running" | "error" | "closed",
): OrchestrationSession["status"] {
  switch (status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    default:
      return "ready";
  }
}

const turnStartKeyForEvent = (event: ProviderIntentEvent): string =>
  event.commandId !== null ? `command:${event.commandId}` : `event:${event.eventId}`;

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

const HANDLED_TURN_START_KEY_MAX = 10_000;
const HANDLED_TURN_START_KEY_TTL = Duration.minutes(30);
const DEFAULT_RUNTIME_MODE: RuntimeMode = "full-access";
const DEFAULT_THREAD_TITLE = "New thread";

function canReplaceThreadTitle(currentTitle: string, titleSeed?: string): boolean {
  const trimmedCurrentTitle = currentTitle.trim();
  if (trimmedCurrentTitle === DEFAULT_THREAD_TITLE) {
    return true;
  }

  const trimmedTitleSeed = titleSeed?.trim();
  return trimmedTitleSeed !== undefined && trimmedTitleSeed.length > 0
    ? trimmedCurrentTitle === trimmedTitleSeed
    : false;
}

function isUnknownPendingApprovalRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    const detail = error.detail.toLowerCase();
    return (
      detail.includes("unknown pending approval request") ||
      detail.includes("unknown pending permission request")
    );
  }
  const message = Cause.pretty(cause);
  return (
    message.includes("unknown pending approval request") ||
    message.includes("unknown pending permission request")
  );
}

function isUnknownPendingUserInputRequestError(cause: Cause.Cause<ProviderServiceError>): boolean {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail.toLowerCase().includes("unknown pending user-input request");
  }
  return Cause.pretty(cause).toLowerCase().includes("unknown pending user-input request");
}

/**
 * The sentence to put in front of a person, out of a cause written for a log.
 *
 * `Cause.pretty` is right in a log file and wrong in the work log, which shows
 * one truncated line. A refusal whose whole point is "No Codex account is
 * connected for you. Connect one in Settings → Connections" arrives there as
 * "ProviderAdapterRequestError: Provider adapter request failed (codex) for
 * thread.turn.start: No Code…" — the frame eats the width and the instruction
 * is what gets cut. Worse, the frames below it name a file inside the installed
 * app bundle, so a refusal that is working exactly as designed reads as a
 * crash.
 *
 * The provider errors already carry the sentence as a field, so use it; failing
 * that, keep the cause's own text and drop the stack frames. The full cause is
 * still logged beside the activity, so nothing is lost to debugging.
 */
function readableFailureDetail(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (Schema.is(ProviderAdapterRequestError)(error)) {
    return error.detail;
  }
  const pretty = Cause.pretty(cause);
  const withoutFrames = pretty
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .trim();
  return withoutFrames.length > 0 ? withoutFrames : pretty;
}

function stalePendingRequestDetail(
  requestKind: "approval" | "user-input",
  requestId: string,
): string {
  return `Stale pending ${requestKind} request: ${requestId}. Provider callback state does not survive app restarts or recovered sessions. Restart the turn to continue.`;
}

function buildGeneratedWorktreeBranchName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/['"`]/g, "");

  const withoutPrefix = normalized.startsWith(`${WORKTREE_BRANCH_PREFIX}/`)
    ? normalized.slice(`${WORKTREE_BRANCH_PREFIX}/`.length)
    : normalized;

  const branchFragment = withoutPrefix
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/-+/g, "-")
    .replace(/^[./_-]+|[./_-]+$/g, "")
    .slice(0, 64)
    .replace(/[./_-]+$/g, "");

  const safeFragment = branchFragment.length > 0 ? branchFragment : "update";
  return `${WORKTREE_BRANCH_PREFIX}/${safeFragment}`;
}

function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/**
 * The same two providers under the names the connect flow files them by.
 *
 * `ProviderKind` calls it `claudeAgent` because that is the agent T3 runs; the
 * credential store calls it `claude` because that is what the person signed
 * into. One translation, in one place, rather than a string literal at every
 * lookup.
 */
function providerAuthProviderOf(provider: ProviderKind): ProviderAuthProvider {
  return provider === "codex" ? "codex" : "claude";
}

function providerAuthLabel(provider: ProviderKind): string {
  return provider === "codex" ? "Codex" : "Claude";
}

function tenantSessionFromProviderSession(input: {
  readonly account: ProviderAccount;
  readonly providerSession: ProviderSessionIsolation;
}): TenantSessionContext {
  return {
    authSessionId: AuthSessionId.make(`provider-session:${input.providerSession.id}`),
    userId: input.providerSession.userId,
    tenantId: input.providerSession.tenantId,
    organizationId:
      input.account.owner.type === "organization" ? input.account.owner.organizationId : null,
    membershipIds: [],
    roles: ["developer"],
    activeWorkspaceId: null,
    issuedAt: input.providerSession.createdAt,
    expiresAt: "9999-12-31T23:59:59.999Z",
  };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerService = yield* ProviderService;
  const tenancyRepository = yield* TenancyRepository;
  const git = yield* GitCore;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const textGeneration = yield* TextGeneration;
  const serverSettingsService = yield* ServerSettingsService;
  const handledTurnStartKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_START_KEY_MAX,
    timeToLive: HANDLED_TURN_START_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnStartRecently = (key: string) =>
    Cache.getOption(handledTurnStartKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnStartKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.stop.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("provider-failure-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: "error",
        kind: input.kind,
        summary: input.summary,
        payload: {
          detail: input.detail,
          ...(input.requestId ? { requestId: input.requestId } : {}),
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: serverCommandId("provider-session-set"),
      threadId: input.threadId,
      session: input.session,
      createdAt: input.createdAt,
    });

  const resolveThread = Effect.fn("resolveThread")(function* (threadId: ThreadId) {
    const readModel = yield* orchestrationEngine.getReadModel();
    return readModel.threads.find((entry) => entry.id === threadId);
  });

  const ensureSessionForThread = Effect.fn("ensureSessionForThread")(function* (
    threadId: ThreadId,
    createdAt: string,
    options?: {
      readonly modelSelection?: ModelSelection;
      readonly actingUserId?: UserId | null;
    },
  ) {
    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === threadId);
    if (!thread) {
      return yield* Effect.die(new Error(`Thread '${threadId}' was not found in read model.`));
    }

    const desiredRuntimeMode = thread.runtimeMode;
    const currentProvider: ProviderKind | undefined = Schema.is(ProviderKind)(
      thread.session?.providerName,
    )
      ? thread.session.providerName
      : undefined;
    const requestedModelSelection = options?.modelSelection;
    const threadProvider: ProviderKind = currentProvider ?? thread.modelSelection.provider;
    if (
      requestedModelSelection !== undefined &&
      requestedModelSelection.provider !== threadProvider
    ) {
      return yield* new ProviderAdapterRequestError({
        provider: threadProvider,
        method: "thread.turn.start",
        detail: `Thread '${threadId}' is bound to provider '${threadProvider}' and cannot switch to '${requestedModelSelection.provider}'.`,
      });
    }
    const preferredProvider: ProviderKind = currentProvider ?? threadProvider;
    const desiredModelSelection = requestedModelSelection ?? thread.modelSelection;
    const effectiveCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });

    /**
     * Whoever asked for this turn, and so whose provider account answers.
     *
     * The reactor is a background listener with no session attached, so the
     * caller passes down the author of the message that started the turn. The
     * transcript is the fallback for the paths that have no message to hand —
     * a runtime-mode change restarting a session, say — where the newest
     * attributed message is the best available answer to the same question.
     *
     * Getting this wrong is not a small matter: the wrong answer here runs
     * somebody's turn on a colleague's provider account.
     */
    const actingUserId =
      options?.actingUserId ??
      thread.messages.findLast((message) => message.authorUserId !== null)?.authorUserId;

    /**
     * A credential somebody has agreed to spend, and nothing else.
     *
     * Reached only when the hosted-tenant path above has no provider session to
     * offer, which on a single-box deployment is always. Returning undefined
     * here would let the adapter fall back to the environment the server runs
     * in — the machine's own CLI login — which is how one personal account came
     * to answer for every user of the box. So an unanswered turn is refused,
     * and the refusal says what to do about it.
     *
     * Which credential is no longer a lookup but a decision, taken in
     * `resolveProviderAccount`: the sender's own account normally, a colleague's
     * only where that colleague has lent it and an admin has pointed this
     * workspace at it.
     */
    const resolveConnectedLaunchEnvironment = (provider: ProviderKind) =>
      Effect.gen(function* () {
        const config = yield* Effect.service(ServerConfig);
        const refuse = (detail: string) =>
          new ProviderAdapterRequestError({
            provider,
            method: "thread.turn.start",
            detail,
          });
        if (actingUserId === undefined || actingUserId === null) {
          return yield* refuse(
            `This thread has no message attributed to an account, so T3 cannot tell whose ${providerAuthLabel(provider)} login to use. Send a message as a signed-in user and try again.`,
          );
        }

        /**
         * Whose sharing rules apply: the workspace that owns the directory this
         * turn runs in, found the same way the provider-session lookup below
         * finds its tenant. A thread with no project, or a project nobody owns,
         * has no workspace to hold an opinion — so tenant and workspace go null,
         * the decision collapses to "this person's own account", and a user who
         * was working yesterday is not locked out by a feature they never used.
         */
        const cwd = effectiveCwd;
        const owningProject =
          cwd === undefined
            ? undefined
            : readModel.projects.find((project) => isPathInsideRoot(cwd, project.workspaceRoot));
        const ownership = owningProject?.ownership;
        // A project can predate workspaces, in which case its own id stands in —
        // the same substitution the collaboration panel makes, so both ends
        // address one workspace by one name.
        const workspaceId =
          ownership?.workspaceId ??
          (owningProject === undefined ? null : WorkspaceId.make(owningProject.id));

        const resolved = yield* resolveProviderAccount({
          stateDir: config.stateDir,
          userId: String(actingUserId),
          tenantId: ownership?.tenantId ?? null,
          workspaceId: workspaceId === null ? null : String(workspaceId),
          provider: providerAuthProviderOf(provider),
          providerLabel: providerAuthLabel(provider),
        });
        if (resolved.outcome === "refused") {
          return yield* refuse(resolved.refusal);
        }
        return {
          // The server's environment minus every credential in it, plus the one
          // that belongs to whoever is paying for this turn. Without the strip,
          // an inherited CODEX_HOME or CLAUDE_CODE_OAUTH_TOKEN would still be in
          // scope — and under sharing that would be the wrong person's.
          env: { ...filterProviderLaunchBaseEnv(process.env), ...resolved.env },
        };
      });

    const resolveProviderLaunchEnvironment = (input: {
      readonly provider: ProviderKind;
      readonly cwd: string | undefined;
    }) =>
      Effect.gen(function* () {
        if (!input.cwd) {
          return yield* resolveConnectedLaunchEnvironment(input.provider);
        }

        const snapshot = yield* tenancyRepository.loadProviderIsolation().pipe(
          Effect.mapError(
            (error) =>
              new ProviderAdapterRequestError({
                provider: input.provider,
                method: "thread.turn.start",
                detail: `Failed to load provider isolation records before starting provider session: ${error.message}`,
                cause: error,
              }),
          ),
        );
        // Provider homes hold credentials, so a session may only be reused by the
        // tenant that owns the project. Matching on path alone would hand one
        // tenant's provider login to another.
        const owningTenantId = readModel.projects.find(
          (project) =>
            project.ownership !== undefined && isPathInsideRoot(input.cwd!, project.workspaceRoot),
        )?.ownership?.tenantId;
        const providerSession = snapshot.providerSessions
          .filter(
            (session) =>
              session.endedAt === null &&
              session.provider === input.provider &&
              isPathInsideRoot(input.cwd!, session.cwd) &&
              (owningTenantId === undefined || session.tenantId === owningTenantId),
          )
          .toSorted((left, right) => {
            const leftAccount = snapshot.providerAccounts.find(
              (account) => account.id === left.providerAccountId,
            );
            const rightAccount = snapshot.providerAccounts.find(
              (account) => account.id === right.providerAccountId,
            );
            const leftShared =
              leftAccount &&
              leftAccount.owner.type !== "user" &&
              leftAccount.sharing === "tenant-shared"
                ? 0
                : 1;
            const rightShared =
              rightAccount &&
              rightAccount.owner.type !== "user" &&
              rightAccount.sharing === "tenant-shared"
                ? 0
                : 1;
            return leftShared - rightShared;
          })[0];
        if (!providerSession) {
          return yield* resolveConnectedLaunchEnvironment(input.provider);
        }

        const account = snapshot.providerAccounts.find(
          (account) => account.id === providerSession.providerAccountId,
        );
        if (!account) {
          return yield* new ProviderAdapterRequestError({
            provider: input.provider,
            method: "thread.turn.start",
            detail: `Provider session '${providerSession.id}' references missing provider account '${providerSession.providerAccountId}'.`,
          });
        }

        const plan = deriveProviderLaunchEnvironment({
          account,
          providerSession,
          tenantSession: tenantSessionFromProviderSession({ account, providerSession }),
          baseEnv: process.env,
        });
        if (!plan.allowed) {
          return yield* new ProviderAdapterRequestError({
            provider: input.provider,
            method: "thread.turn.start",
            detail: `Provider launch denied for account '${account.id}': ${plan.reason}`,
          });
        }
        return {
          env: plan.env,
        };
      });

    const resolveActiveSession = (threadId: ThreadId) =>
      providerService
        .listSessions()
        .pipe(Effect.map((sessions) => sessions.find((session) => session.threadId === threadId)));

    const startProviderSession = (input?: {
      readonly resumeCursor?: unknown;
      readonly provider?: ProviderKind;
    }) =>
      Effect.gen(function* () {
        const providerLaunchEnvironment = yield* resolveProviderLaunchEnvironment({
          provider: input?.provider ?? preferredProvider,
          cwd: effectiveCwd,
        });
        return yield* providerService.startSession(threadId, {
          threadId,
          ...(preferredProvider ? { provider: preferredProvider } : {}),
          ...(effectiveCwd ? { cwd: effectiveCwd } : {}),
          ...(providerLaunchEnvironment ? { providerLaunchEnvironment } : {}),
          modelSelection: desiredModelSelection,
          ...(input?.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          runtimeMode: desiredRuntimeMode,
        });
      });

    const bindSessionToThread = (session: ProviderSession) =>
      setThreadSession({
        threadId,
        session: {
          threadId,
          status: mapProviderSessionStatusToOrchestrationStatus(session.status),
          providerName: session.provider,
          runtimeMode: desiredRuntimeMode,
          // Provider turn ids are not orchestration turn ids.
          activeTurnId: null,
          lastError: session.lastError ?? null,
          updatedAt: session.updatedAt,
        },
        createdAt,
      });

    const activeSession = yield* resolveActiveSession(threadId);
    const existingSessionThreadId =
      thread.session && thread.session.status !== "stopped" && activeSession ? thread.id : null;
    if (existingSessionThreadId) {
      const runtimeModeChanged = thread.runtimeMode !== thread.session?.runtimeMode;
      const providerChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.provider !== currentProvider;
      const sessionModelSwitch =
        currentProvider === undefined
          ? "in-session"
          : (yield* providerService.getCapabilities(currentProvider)).sessionModelSwitch;
      const modelChanged =
        requestedModelSelection !== undefined &&
        requestedModelSelection.model !== activeSession?.model;
      const shouldRestartForModelChange = modelChanged && sessionModelSwitch === "restart-session";
      const previousModelSelection = threadModelSelections.get(threadId);
      const shouldRestartForModelSelectionChange =
        currentProvider === "claudeAgent" &&
        requestedModelSelection !== undefined &&
        !Equal.equals(previousModelSelection, requestedModelSelection);

      if (
        !runtimeModeChanged &&
        !providerChanged &&
        !shouldRestartForModelChange &&
        !shouldRestartForModelSelectionChange
      ) {
        return existingSessionThreadId;
      }

      const resumeCursor =
        providerChanged || shouldRestartForModelChange
          ? undefined
          : (activeSession?.resumeCursor ?? undefined);
      yield* Effect.logInfo("provider command reactor restarting provider session", {
        threadId,
        existingSessionThreadId,
        currentProvider,
        desiredProvider: desiredModelSelection.provider,
        currentRuntimeMode: thread.session?.runtimeMode,
        desiredRuntimeMode: thread.runtimeMode,
        runtimeModeChanged,
        providerChanged,
        modelChanged,
        shouldRestartForModelChange,
        shouldRestartForModelSelectionChange,
        hasResumeCursor: resumeCursor !== undefined,
      });
      const restartedSession = yield* startProviderSession(
        resumeCursor !== undefined ? { resumeCursor } : undefined,
      );
      yield* Effect.logInfo("provider command reactor restarted provider session", {
        threadId,
        previousSessionId: existingSessionThreadId,
        restartedSessionThreadId: restartedSession.threadId,
        provider: restartedSession.provider,
        runtimeMode: restartedSession.runtimeMode,
      });
      yield* bindSessionToThread(restartedSession);
      return restartedSession.threadId;
    }

    const startedSession = yield* startProviderSession(undefined);
    yield* bindSessionToThread(startedSession);
    return startedSession.threadId;
  });

  const sendTurnForThread = Effect.fn("sendTurnForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
    readonly modelSelection?: ModelSelection;
    readonly interactionMode?: "default" | "plan";
    /** Whose message started this turn, and so whose provider account answers. */
    readonly actingUserId?: UserId | null;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThread(input.threadId);
    if (!thread) {
      return;
    }
    yield* ensureSessionForThread(input.threadId, input.createdAt, {
      ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
      ...(input.actingUserId !== undefined ? { actingUserId: input.actingUserId } : {}),
    });
    if (input.modelSelection !== undefined) {
      threadModelSelections.set(input.threadId, input.modelSelection);
    }
    const normalizedInput = toNonEmptyProviderInput(input.messageText);
    const normalizedAttachments = input.attachments ?? [];
    const activeSession = yield* providerService
      .listSessions()
      .pipe(
        Effect.map((sessions) => sessions.find((session) => session.threadId === input.threadId)),
      );
    const sessionModelSwitch =
      activeSession === undefined
        ? "in-session"
        : (yield* providerService.getCapabilities(activeSession.provider)).sessionModelSwitch;
    const requestedModelSelection =
      input.modelSelection ?? threadModelSelections.get(input.threadId) ?? thread.modelSelection;
    const modelForTurn =
      sessionModelSwitch === "unsupported"
        ? activeSession?.model !== undefined
          ? {
              ...requestedModelSelection,
              model: activeSession.model,
            }
          : requestedModelSelection
        : input.modelSelection;

    yield* providerService.sendTurn({
      threadId: input.threadId,
      ...(normalizedInput ? { input: normalizedInput } : {}),
      ...(normalizedAttachments.length > 0 ? { attachments: normalizedAttachments } : {}),
      ...(modelForTurn !== undefined ? { modelSelection: modelForTurn } : {}),
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    });
  });

  const maybeGenerateAndRenameWorktreeBranchForFirstTurn = Effect.fn(
    "maybeGenerateAndRenameWorktreeBranchForFirstTurn",
  )(function* (input: {
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    if (!input.branch || !input.worktreePath) {
      return;
    }
    if (!isTemporaryWorktreeBranch(input.branch)) {
      return;
    }

    const oldBranch = input.branch;
    const cwd = input.worktreePath;
    const attachments = input.attachments ?? [];
    yield* Effect.gen(function* () {
      const { textGenerationModelSelection: modelSelection } =
        yield* serverSettingsService.getSettings;

      const generated = yield* textGeneration.generateBranchName({
        cwd,
        message: input.messageText,
        ...(attachments.length > 0 ? { attachments } : {}),
        modelSelection,
      });
      if (!generated) return;

      const targetBranch = buildGeneratedWorktreeBranchName(generated.branch);
      if (targetBranch === oldBranch) return;

      const renamed = yield* git.renameBranch({ cwd, oldBranch, newBranch: targetBranch });
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: serverCommandId("worktree-branch-rename"),
        threadId: input.threadId,
        branch: renamed.branch,
        worktreePath: cwd,
      });
      yield* gitStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("provider command reactor failed to generate or rename worktree branch", {
          threadId: input.threadId,
          cwd,
          oldBranch,
          cause: Cause.pretty(cause),
        }),
      ),
    );
  });

  const maybeGenerateThreadTitleForFirstTurn = Effect.fn("maybeGenerateThreadTitleForFirstTurn")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly cwd: string;
      readonly messageText: string;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
      readonly titleSeed?: string;
    }) {
      const attachments = input.attachments ?? [];
      yield* Effect.gen(function* () {
        const { textGenerationModelSelection: modelSelection } =
          yield* serverSettingsService.getSettings;

        const generated = yield* textGeneration.generateThreadTitle({
          cwd: input.cwd,
          message: input.messageText,
          ...(attachments.length > 0 ? { attachments } : {}),
          modelSelection,
        });
        if (!generated) return;

        const thread = yield* resolveThread(input.threadId);
        if (!thread) return;
        if (!canReplaceThreadTitle(thread.title, input.titleSeed)) {
          return;
        }

        yield* orchestrationEngine.dispatch({
          type: "thread.meta.update",
          commandId: serverCommandId("thread-title-rename"),
          threadId: input.threadId,
          title: generated.title,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider command reactor failed to generate or rename thread title", {
            threadId: input.threadId,
            cwd: input.cwd,
            cause: Cause.pretty(cause),
          }),
        ),
      );
    },
  );

  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnStartKeyForEvent(event);
    if (yield* hasHandledTurnStartRecently(key)) {
      return;
    }

    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const message = thread.messages.find((entry) => entry.id === event.payload.messageId);
    if (!message || message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
      });
      return;
    }

    const isFirstUserMessageTurn =
      thread.messages.filter((entry) => entry.role === "user").length === 1;
    if (isFirstUserMessageTurn) {
      const generationCwd =
        resolveThreadWorkspaceCwd({
          thread,
          projects: (yield* orchestrationEngine.getReadModel()).projects,
        }) ?? process.cwd();
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
        ...(event.payload.titleSeed !== undefined ? { titleSeed: event.payload.titleSeed } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);

      if (canReplaceThreadTitle(thread.title, event.payload.titleSeed)) {
        yield* maybeGenerateThreadTitleForFirstTurn({
          threadId: event.payload.threadId,
          cwd: generationCwd,
          ...generationInput,
        }).pipe(Effect.forkScoped);
      }
    }

    yield* sendTurnForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      interactionMode: event.payload.interactionMode,
      actingUserId: message.authorUserId,
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("provider command reactor failed to start a turn", {
            threadId: event.payload.threadId,
            cause: Cause.pretty(cause),
          });
          yield* appendProviderFailureActivity({
            threadId: event.payload.threadId,
            kind: "provider.turn.start.failed",
            summary: "Provider turn start failed",
            detail: readableFailureDetail(cause),
            turnId: null,
            createdAt: event.payload.createdAt,
          });
        }),
      ),
    );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this thread.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* providerService.interruptTurn({ threadId: event.payload.threadId });
  });

  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }
    const hasSession = thread.session && thread.session.status !== "stopped";
    if (!hasSession) {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: "No active provider session is bound to this thread.",
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
    }

    yield* providerService
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail: isUnknownPendingApprovalRequestError(cause)
                ? stalePendingRequestDetail("approval", event.payload.requestId)
                : readableFailureDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });

            if (!isUnknownPendingApprovalRequestError(cause)) return;
          }),
        ),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThread(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        return yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: "No active provider session is bound to this thread.",
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
      }

      yield* providerService
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) =>
            appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.user-input.respond.failed",
              summary: "Provider user input response failed",
              detail: isUnknownPendingUserInputRequestError(cause)
                ? stalePendingRequestDetail("user-input", event.payload.requestId)
                : readableFailureDetail(cause),
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            }),
          ),
        );
    },
  );

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
  ) {
    const thread = yield* resolveThread(event.payload.threadId);
    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;
    if (thread.session && thread.session.status !== "stopped") {
      yield* providerService.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      "orchestration.thread_id": event.payload.threadId,
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });
    switch (event.type) {
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThread(event.payload.threadId);
        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }
        // Restarting needs a provider account to restart on, and an account
        // belongs to a person. Nobody has spoken in this thread yet, so there is
        // no answer to whose it should be — and no work waiting on the session
        // either. The first message starts it properly, attributed to its
        // sender; refusing here instead would only put an error on a thread
        // whose owner has done nothing wrong.
        if (!thread.messages.some((message) => message.authorUserId !== null)) {
          return;
        }
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        );
        return;
      }
      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);
        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);
        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);
        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);
        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event);
        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    processDomainEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processDomainEventSafely);

  const start: ProviderCommandReactorShape["start"] = Effect.fn("start")(function* () {
    const processEvent = Effect.fn("processEvent")(function* (event: OrchestrationEvent) {
      if (
        event.type === "thread.runtime-mode-set" ||
        event.type === "thread.turn-start-requested" ||
        event.type === "thread.turn-interrupt-requested" ||
        event.type === "thread.approval-response-requested" ||
        event.type === "thread.user-input-response-requested" ||
        event.type === "thread.session-stop-requested"
      ) {
        return yield* worker.enqueue(event);
      }
    });

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, processEvent),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ProviderCommandReactorShape;
});

export const ProviderCommandReactorLive = Layer.effect(ProviderCommandReactor, make);
