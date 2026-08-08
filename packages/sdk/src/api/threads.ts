/**
 * Threads: the agent sessions inside a project.
 *
 * @module api/threads
 */
import {
  type ApprovalRequestId,
  type CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type MessageId,
  ORCHESTRATION_WS_METHODS,
  type ModelSelection,
  type OrchestrationCheckpointSummary,
  type OrchestrationMessage,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type OrchestrationThreadStreamItem,
  type ProjectId,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ThreadId,
  type ThreadTurnStartBootstrap,
  type TurnId,
  type UploadChatAttachment,
} from "@t3tools/contracts";

import { dispatch, type T3DispatchAck } from "../commands.ts";
import { newCommandId, newMessageId, newThreadId } from "../ids.ts";
import type { T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3CreateThreadInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  /** Defaults to a freshly minted identifier. */
  readonly threadId?: ThreadId;
}

export interface T3UpdateThreadInput {
  readonly threadId: ThreadId;
  readonly title?: string;
  readonly modelSelection?: ModelSelection;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly favorite?: boolean;
}

export interface T3StartTurnInput {
  readonly threadId: ThreadId;
  readonly prompt: string;
  readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  readonly modelSelection?: ModelSelection;
  /** Seeds the thread title when the thread has not been named yet. */
  readonly titleSeed?: string;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  /** Creates the thread and/or its worktree as part of starting the turn. */
  readonly bootstrap?: ThreadTurnStartBootstrap;
}

export interface T3StartTurnResult {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly sequence: number;
}

export interface T3ThreadsApi {
  readonly list: () => Promise<ReadonlyArray<OrchestrationThreadShell>>;
  readonly get: (threadId: ThreadId) => Promise<OrchestrationThread>;
  readonly listMessages: (threadId: ThreadId) => Promise<ReadonlyArray<OrchestrationMessage>>;
  /**
   * One entry per completed turn, carrying its turn id and the files it
   * touched. A turn still in flight shows up on the thread's `latestTurn`.
   */
  readonly listTurns: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<OrchestrationCheckpointSummary>>;
  readonly listActivity: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<OrchestrationThreadActivity>>;
  readonly listProposedPlans: (
    threadId: ThreadId,
  ) => Promise<ReadonlyArray<OrchestrationProposedPlan>>;
  readonly watch: (
    threadId: ThreadId,
    onEvent: (event: OrchestrationThreadStreamItem) => void,
    options?: T3SubscribeOptions,
  ) => () => void;

  readonly create: (input: T3CreateThreadInput) => Promise<ThreadId>;
  readonly update: (input: T3UpdateThreadInput) => Promise<T3DispatchAck>;
  readonly remove: (threadId: ThreadId) => Promise<T3DispatchAck>;
  readonly archive: (threadId: ThreadId) => Promise<T3DispatchAck>;
  readonly unarchive: (threadId: ThreadId) => Promise<T3DispatchAck>;
  readonly setRuntimeMode: (threadId: ThreadId, runtimeMode: RuntimeMode) => Promise<T3DispatchAck>;
  readonly setInteractionMode: (
    threadId: ThreadId,
    interactionMode: ProviderInteractionMode,
  ) => Promise<T3DispatchAck>;

  readonly startTurn: (input: T3StartTurnInput) => Promise<T3StartTurnResult>;
  readonly interruptTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnId?: TurnId;
  }) => Promise<T3DispatchAck>;
  readonly respondToApproval: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly decision: ProviderApprovalDecision;
  }) => Promise<T3DispatchAck>;
  readonly respondToUserInput: (input: {
    readonly threadId: ThreadId;
    readonly requestId: ApprovalRequestId;
    readonly answers: ProviderUserInputAnswers;
  }) => Promise<T3DispatchAck>;
  readonly revertToTurn: (input: {
    readonly threadId: ThreadId;
    readonly turnCount: number;
  }) => Promise<T3DispatchAck>;
  readonly stopSession: (threadId: ThreadId) => Promise<T3DispatchAck>;
}

export function makeThreadsApi(transport: T3Transport): T3ThreadsApi {
  const getThread = async (threadId: ThreadId): Promise<OrchestrationThread> => {
    const head = await transport.first((client) =>
      client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
    );
    if (head.kind !== "snapshot") {
      throw new Error("Server sent a thread event before the snapshot.");
    }
    return head.snapshot.thread;
  };

  return {
    list: async () => {
      const head = await transport.first((client) =>
        client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
      );
      if (head.kind !== "snapshot") {
        throw new Error("Server sent a shell event before the snapshot.");
      }
      return head.snapshot.threads;
    },
    get: getThread,
    listMessages: async (threadId) => (await getThread(threadId)).messages,
    listTurns: async (threadId) => (await getThread(threadId)).checkpoints,
    listActivity: async (threadId) => (await getThread(threadId)).activities,
    listProposedPlans: async (threadId) => (await getThread(threadId)).proposedPlans,
    watch: (threadId, onEvent, options) =>
      transport.subscribe(
        (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread]({ threadId }),
        onEvent,
        options,
      ),

    create: async (input) => {
      const threadId = input.threadId ?? newThreadId();
      await dispatch(transport, {
        type: "thread.create",
        commandId: newCommandId(),
        threadId,
        projectId: input.projectId,
        title: input.title,
        modelSelection: input.modelSelection,
        runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: input.branch ?? null,
        worktreePath: input.worktreePath ?? null,
        createdAt: new Date().toISOString(),
      });
      return threadId;
    },
    update: (input) =>
      dispatch(transport, {
        type: "thread.meta.update",
        commandId: newCommandId(),
        threadId: input.threadId,
        title: input.title,
        modelSelection: input.modelSelection,
        branch: input.branch,
        worktreePath: input.worktreePath,
        favorite: input.favorite,
      }),
    remove: (threadId) =>
      dispatch(transport, { type: "thread.delete", commandId: newCommandId(), threadId }),
    archive: (threadId) =>
      dispatch(transport, { type: "thread.archive", commandId: newCommandId(), threadId }),
    unarchive: (threadId) =>
      dispatch(transport, { type: "thread.unarchive", commandId: newCommandId(), threadId }),
    setRuntimeMode: (threadId, runtimeMode) =>
      dispatch(transport, {
        type: "thread.runtime-mode.set",
        commandId: newCommandId(),
        threadId,
        runtimeMode,
        createdAt: new Date().toISOString(),
      }),
    setInteractionMode: (threadId, interactionMode) =>
      dispatch(transport, {
        type: "thread.interaction-mode.set",
        commandId: newCommandId(),
        threadId,
        interactionMode,
        createdAt: new Date().toISOString(),
      }),

    startTurn: async (input) => {
      const commandId = newCommandId();
      const messageId = newMessageId();
      const ack = await dispatch(transport, {
        type: "thread.turn.start",
        commandId,
        threadId: input.threadId,
        message: {
          messageId,
          role: "user",
          text: input.prompt,
          attachments: input.attachments ?? [],
        },
        modelSelection: input.modelSelection,
        titleSeed: input.titleSeed,
        runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        interactionMode: input.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        bootstrap: input.bootstrap,
        createdAt: new Date().toISOString(),
      });
      return { threadId: input.threadId, commandId, messageId, sequence: ack.sequence };
    },
    interruptTurn: (input) =>
      dispatch(transport, {
        type: "thread.turn.interrupt",
        commandId: newCommandId(),
        threadId: input.threadId,
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
      }),
    respondToApproval: (input) =>
      dispatch(transport, {
        type: "thread.approval.respond",
        commandId: newCommandId(),
        threadId: input.threadId,
        requestId: input.requestId,
        decision: input.decision,
        createdAt: new Date().toISOString(),
      }),
    respondToUserInput: (input) =>
      dispatch(transport, {
        type: "thread.user-input.respond",
        commandId: newCommandId(),
        threadId: input.threadId,
        requestId: input.requestId,
        answers: input.answers,
        createdAt: new Date().toISOString(),
      }),
    revertToTurn: (input) =>
      dispatch(transport, {
        type: "thread.checkpoint.revert",
        commandId: newCommandId(),
        threadId: input.threadId,
        turnCount: input.turnCount,
        createdAt: new Date().toISOString(),
      }),
    stopSession: (threadId) =>
      dispatch(transport, {
        type: "thread.session.stop",
        commandId: newCommandId(),
        threadId,
        createdAt: new Date().toISOString(),
      }),
  };
}
