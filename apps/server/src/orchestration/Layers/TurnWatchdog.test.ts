import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OrchestrationEngineService, type OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";
import { ProviderService, type ProviderServiceShape } from "../../provider/Services/ProviderService.ts";
import { TurnWatchdog } from "../Services/TurnWatchdog.ts";
import { makeTurnWatchdogLive } from "./TurnWatchdog.ts";

const defaultModelSelection = {
  provider: "codex",
  model: "gpt-5-codex",
} as const;

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

const STALE_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;

function makeThread(input: {
  readonly id: ThreadId;
  readonly turnId: TurnId | null;
  readonly sessionStatus: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly turnStartedAtIso: string;
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
}): OrchestrationThread {
  const now = input.turnStartedAtIso;
  return {
    id: input.id,
    projectId: ProjectId.make("project-turn-watchdog"),
    title: `Thread ${input.id}`,
    modelSelection: defaultModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn:
      input.turnId !== null
        ? {
            turnId: input.turnId,
            state: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            assistantMessageId: null,
          }
        : null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: input.activities ?? [],
    checkpoints: [],
    session:
      input.turnId !== null
        ? {
            threadId: input.id,
            status: input.sessionStatus,
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: input.turnId,
            lastError: null,
            updatedAt: now,
          }
        : null,
  };
}

function makeReadModel(threads: ReadonlyArray<OrchestrationThread>): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads,
    updatedAt: new Date().toISOString(),
  };
}

describe("TurnWatchdog", () => {
  let runtime: ManagedRuntime.ManagedRuntime<TurnWatchdog, unknown> | null = null;

  afterEach(async () => {
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
  });

  function createHarness(readModel: OrchestrationReadModel) {
    const dispatchedCommands: OrchestrationCommand[] = [];
    const dispatch: OrchestrationEngineShape["dispatch"] = (command) => {
      dispatchedCommands.push(command);
      return Effect.succeed({ sequence: dispatchedCommands.length });
    };

    const orchestrationEngine: OrchestrationEngineShape = {
      getReadModel: () => Effect.succeed(readModel),
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
    };

    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void as never);
    const providerService: ProviderServiceShape = {
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession,
      listSessions: () => Effect.succeed([]),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      rollbackConversation: () => unsupported(),
      streamEvents: Stream.empty,
    };

    const layer = makeTurnWatchdogLive({
      staleActivityThresholdMs: STALE_ACTIVITY_THRESHOLD_MS,
      // Only `sweepOnce` is exercised directly in these tests; the scheduled
      // loop's own interval is irrelevant.
      sweepIntervalMs: 60_000,
    }).pipe(
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(Layer.succeed(OrchestrationEngineService, orchestrationEngine)),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    return { dispatchedCommands, stopSession };
  }

  it("marks a turn stuck and recovers it when there is no activity past the threshold", async () => {
    const threadId = ThreadId.make("thread-stuck");
    const turnId = TurnId.make("turn-stuck");
    const staleTurnStartedAt = new Date(Date.now() - STALE_ACTIVITY_THRESHOLD_MS - 60_000).toISOString();

    const harness = createHarness(
      makeReadModel([
        makeThread({
          id: threadId,
          turnId,
          sessionStatus: "running",
          turnStartedAtIso: staleTurnStartedAt,
          activities: [],
        }),
      ]),
    );

    const watchdog = await runtime!.runPromise(Effect.service(TurnWatchdog));
    await runtime!.runPromise(watchdog.sweepOnce);

    expect(harness.stopSession).toHaveBeenCalledWith({ threadId });

    const sessionSetCommand = harness.dispatchedCommands.find(
      (command) => command.type === "thread.session.set",
    );
    expect(sessionSetCommand).toBeDefined();
    if (sessionSetCommand?.type === "thread.session.set") {
      expect(sessionSetCommand.session.status).toBe("error");
      expect(sessionSetCommand.session.activeTurnId).toBeNull();
      expect(sessionSetCommand.session.lastError).toContain("stopped responding");
      expect(sessionSetCommand.session.lastError).toContain("automatically ended");
    }

    const activityCommand = harness.dispatchedCommands.find(
      (command) => command.type === "thread.activity.append",
    );
    expect(activityCommand).toBeDefined();
    if (activityCommand?.type === "thread.activity.append") {
      expect(activityCommand.activity.tone).toBe("error");
      expect(activityCommand.activity.turnId).toBe(turnId);
    }

    const interruptCommand = harness.dispatchedCommands.find(
      (command) => command.type === "thread.turn.interrupt",
    );
    expect(interruptCommand).toBeDefined();
    if (interruptCommand?.type === "thread.turn.interrupt") {
      expect(interruptCommand.turnId).toBe(turnId);
    }
  });

  it("does not fire for a turn with a pending approval waiting on the person", async () => {
    const threadId = ThreadId.make("thread-pending-approval");
    const turnId = TurnId.make("turn-pending-approval");
    const staleTurnStartedAt = new Date(Date.now() - STALE_ACTIVITY_THRESHOLD_MS - 60_000).toISOString();

    const harness = createHarness(
      makeReadModel([
        makeThread({
          id: threadId,
          turnId,
          sessionStatus: "running",
          turnStartedAtIso: staleTurnStartedAt,
          activities: [
            {
              id: "evt-approval-requested" as OrchestrationThreadActivity["id"],
              tone: "approval",
              kind: "approval.requested",
              summary: "Command approval requested",
              payload: { requestId: "req-1" },
              turnId,
              createdAt: staleTurnStartedAt,
            },
          ],
        }),
      ]),
    );

    const watchdog = await runtime!.runPromise(Effect.service(TurnWatchdog));
    await runtime!.runPromise(watchdog.sweepOnce);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
  });

  it("does not fire for a turn that has recent activity", async () => {
    const threadId = ThreadId.make("thread-recent-activity");
    const turnId = TurnId.make("turn-recent-activity");
    const staleTurnStartedAt = new Date(Date.now() - STALE_ACTIVITY_THRESHOLD_MS - 60_000).toISOString();
    const recentActivityAt = new Date(Date.now() - 5_000).toISOString();

    const harness = createHarness(
      makeReadModel([
        makeThread({
          id: threadId,
          turnId,
          sessionStatus: "running",
          turnStartedAtIso: staleTurnStartedAt,
          activities: [
            {
              id: "evt-recent-tool" as OrchestrationThreadActivity["id"],
              tone: "tool",
              kind: "tool.completed",
              summary: "Ran a tool",
              payload: {},
              turnId,
              createdAt: recentActivityAt,
            },
          ],
        }),
      ]),
    );

    const watchdog = await runtime!.runPromise(Effect.service(TurnWatchdog));
    await runtime!.runPromise(watchdog.sweepOnce);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
  });

  it("never kills a turn that keeps producing activity every ~30s, even long past the cumulative threshold", async () => {
    const threadId = ThreadId.make("thread-long-running-progressing");
    const turnId = TurnId.make("turn-long-running-progressing");
    // The turn itself started well over an hour ago (far past the stale
    // threshold on a cumulative-runtime basis), but activity keeps landing
    // every ~30s, so it must never be treated as stuck.
    const turnStartedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const activities: OrchestrationThreadActivity[] = [];
    for (let secondsAgo = 25; secondsAgo <= 24 * 30; secondsAgo += 30) {
      activities.push({
        id: `evt-progress-${secondsAgo}` as OrchestrationThreadActivity["id"],
        tone: "tool",
        kind: "tool.completed",
        summary: "Ran a tool",
        payload: {},
        turnId,
        createdAt: new Date(Date.now() - secondsAgo * 1000).toISOString(),
      });
    }

    const harness = createHarness(
      makeReadModel([
        makeThread({
          id: threadId,
          turnId,
          sessionStatus: "running",
          turnStartedAtIso: turnStartedAt,
          activities,
        }),
      ]),
    );

    const watchdog = await runtime!.runPromise(Effect.service(TurnWatchdog));
    await runtime!.runPromise(watchdog.sweepOnce);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
  });

  it("skips threads with no active turn", async () => {
    const threadId = ThreadId.make("thread-idle");
    const now = new Date().toISOString();

    const harness = createHarness(
      makeReadModel([
        makeThread({
          id: threadId,
          turnId: null,
          sessionStatus: "ready",
          turnStartedAtIso: now,
        }),
      ]),
    );

    const watchdog = await runtime!.runPromise(Effect.service(TurnWatchdog));
    await runtime!.runPromise(watchdog.sweepOnce);

    expect(harness.stopSession).not.toHaveBeenCalled();
    expect(harness.dispatchedCommands).toHaveLength(0);
  });
});
