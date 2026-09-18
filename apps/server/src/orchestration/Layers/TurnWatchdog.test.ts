import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadActivityTone,
} from "@t3tools/contracts";
import { Clock, Duration, Effect, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { TurnWatchdog } from "../Services/TurnWatchdog.ts";
import { makeTurnWatchdogLive } from "./TurnWatchdog.ts";

const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

const defaultModelSelection = { provider: "codex", model: "gpt-5-codex" } as const;
const STALE_ACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;

function makeActivity(input: {
  readonly kind: string;
  readonly tone: OrchestrationThreadActivityTone;
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly payload?: unknown;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${crypto.randomUUID()}`),
    tone: input.tone,
    kind: input.kind,
    summary: "Test activity",
    payload: input.payload ?? {},
    turnId: input.turnId,
    createdAt: input.createdAt,
  };
}

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
  const now = new Date().toISOString();
  return {
    snapshotSequence: 0,
    projects: [
      {
        id: ProjectId.make("project-turn-watchdog"),
        title: "Turn Watchdog Project",
        workspaceRoot: "/tmp/turn-watchdog-project",
        defaultModelSelection,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads,
    updatedAt: now,
  };
}

/**
 * Test harness: captures dispatched commands and stopSession calls via plain
 * closures, and lets each test swap in a new read-model snapshot (mutating
 * `currentReadModel`) between `sweepOnce` calls.
 */
function makeHarness(initialThread: OrchestrationThread) {
  let currentReadModel = makeReadModel([initialThread]);
  const dispatched: OrchestrationCommand[] = [];
  const stoppedThreadIds: ThreadId[] = [];

  const setThread = (thread: OrchestrationThread) => {
    currentReadModel = makeReadModel([thread]);
  };

  const engineLayer = Layer.succeed(OrchestrationEngineService, {
    getReadModel: () => Effect.succeed(currentReadModel),
    readEvents: () => Stream.empty,
    dispatch: (command: OrchestrationCommand) => {
      dispatched.push(command);
      return Effect.succeed({ sequence: dispatched.length });
    },
    streamDomainEvents: Stream.empty,
  });

  const providerService: ProviderServiceShape = {
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
    respondToRequest: () => unsupported(),
    respondToUserInput: () => unsupported(),
    stopSession: (input) =>
      Effect.sync(() => {
        stoppedThreadIds.push(input.threadId);
      }),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
    rollbackConversation: () => unsupported(),
    streamEvents: Stream.empty,
  };
  const providerServiceLayer = Layer.succeed(ProviderService, providerService);

  const watchdogLayer = makeTurnWatchdogLive({
    staleActivityThresholdMs: STALE_ACTIVITY_THRESHOLD_MS,
    // Only `sweepOnce` is exercised directly in these tests; the scheduled
    // loop's own interval is irrelevant.
    sweepIntervalMs: 60_000,
  }).pipe(Layer.provideMerge(engineLayer), Layer.provideMerge(providerServiceLayer));

  return { watchdogLayer, dispatched, stoppedThreadIds, setThread };
}

it.effect(
  "transitions a turn with no activity for longer than the threshold to a terminal, honestly-labeled failure",
  () => {
    const threadId = ThreadId.make("thread-watchdog-stuck");
    const turnId = TurnId.make("turn-watchdog-stuck");
    const requestedAtIso = new Date(0).toISOString();
    const thread = makeThread({
      id: threadId,
      turnId,
      sessionStatus: "running",
      turnStartedAtIso: requestedAtIso,
      activities: [],
    });
    const harness = makeHarness(thread);

    return Effect.gen(function* () {
      const watchdog = yield* TurnWatchdog;

      // Real-world reported case: turn stuck `running` with zero activity
      // rows and zero pending approvals for hours. 6 minutes exceeds the
      // 5-minute default threshold used by this harness.
      yield* TestClock.adjust(Duration.minutes(6));
      yield* watchdog.sweepOnce;

      expect(harness.dispatched.map((command) => command.type)).toEqual([
        "thread.session.set",
        "thread.activity.append",
        "thread.turn.interrupt",
      ]);

      const sessionSetCommand = harness.dispatched[0];
      if (sessionSetCommand?.type !== "thread.session.set") throw new Error("unreachable");
      expect(sessionSetCommand.session.status).toBe("error");
      expect(sessionSetCommand.session.activeTurnId).toBeNull();
      expect(sessionSetCommand.session.lastError).toBe(
        "This turn stopped responding for over 5 minutes with no activity and was automatically ended. You can send your message again.",
      );

      const activityAppendCommand = harness.dispatched[1];
      if (activityAppendCommand?.type !== "thread.activity.append") throw new Error("unreachable");
      expect(activityAppendCommand.activity.tone).toBe("error");
      expect(activityAppendCommand.activity.kind).toBe("runtime.error");
      expect(activityAppendCommand.activity.turnId).toBe(turnId);
      expect(activityAppendCommand.activity.payload).toEqual({
        message: sessionSetCommand.session.lastError,
      });

      const turnInterruptCommand = harness.dispatched[2];
      if (turnInterruptCommand?.type !== "thread.turn.interrupt") throw new Error("unreachable");
      expect(turnInterruptCommand.threadId).toBe(threadId);
      expect(turnInterruptCommand.turnId).toBe(turnId);

      expect(harness.stoppedThreadIds).toEqual([threadId]);
    }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
  },
);

it.effect("does not touch a turn that has recent activity inside the threshold window", () => {
  const threadId = ThreadId.make("thread-watchdog-fresh");
  const turnId = TurnId.make("turn-watchdog-fresh");
  const requestedAtIso = new Date(0).toISOString();
  const thread = makeThread({
    id: threadId,
    turnId,
    sessionStatus: "running",
    turnStartedAtIso: requestedAtIso,
    activities: [
      makeActivity({
        kind: "tool.completed",
        tone: "tool",
        turnId,
        createdAt: new Date(4 * 60_000).toISOString(),
      }),
    ],
  });
  const harness = makeHarness(thread);

  return Effect.gen(function* () {
    const watchdog = yield* TurnWatchdog;

    // Now = 4 minutes, matching the activity's timestamp exactly: idle = 0.
    yield* TestClock.adjust(Duration.minutes(4));
    yield* watchdog.sweepOnce;

    expect(harness.dispatched).toEqual([]);
    expect(harness.stoppedThreadIds).toEqual([]);
  }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
});

it.effect(
  "does not touch a turn with an unresolved approval request even after the threshold elapses",
  () => {
    const threadId = ThreadId.make("thread-watchdog-pending-approval");
    const turnId = TurnId.make("turn-watchdog-pending-approval");
    const requestedAtIso = new Date(0).toISOString();
    const thread = makeThread({
      id: threadId,
      turnId,
      sessionStatus: "running",
      turnStartedAtIso: requestedAtIso,
      activities: [
        makeActivity({
          kind: "approval.requested",
          tone: "approval",
          turnId,
          createdAt: requestedAtIso,
          payload: { requestId: "req-1" },
        }),
      ],
    });
    const harness = makeHarness(thread);

    return Effect.gen(function* () {
      const watchdog = yield* TurnWatchdog;

      // Well past the 5-minute threshold, but the turn is blocked on a human
      // decision, not stuck: it must not be force-failed.
      yield* TestClock.adjust(Duration.minutes(30));
      yield* watchdog.sweepOnce;

      expect(harness.dispatched).toEqual([]);
      expect(harness.stoppedThreadIds).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
  },
);

it.effect(
  "does not touch a turn with an unresolved user-input request even after the threshold elapses",
  () => {
    const threadId = ThreadId.make("thread-watchdog-pending-user-input");
    const turnId = TurnId.make("turn-watchdog-pending-user-input");
    const requestedAtIso = new Date(0).toISOString();
    const thread = makeThread({
      id: threadId,
      turnId,
      sessionStatus: "running",
      turnStartedAtIso: requestedAtIso,
      activities: [
        makeActivity({
          kind: "user-input.requested",
          tone: "info",
          turnId,
          createdAt: requestedAtIso,
          payload: { requestId: "req-user-input-1" },
        }),
      ],
    });
    const harness = makeHarness(thread);

    return Effect.gen(function* () {
      const watchdog = yield* TurnWatchdog;

      yield* TestClock.adjust(Duration.minutes(30));
      yield* watchdog.sweepOnce;

      expect(harness.dispatched).toEqual([]);
      expect(harness.stoppedThreadIds).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
  },
);

it.effect(
  "never kills a turn that keeps producing new activity every 30s, even past the threshold cumulatively",
  () => {
    const threadId = ThreadId.make("thread-watchdog-progressing");
    const turnId = TurnId.make("turn-watchdog-progressing");
    const requestedAtIso = new Date(0).toISOString();
    const thread = makeThread({
      id: threadId,
      turnId,
      sessionStatus: "running",
      turnStartedAtIso: requestedAtIso,
      activities: [],
    });
    const harness = makeHarness(thread);

    return Effect.gen(function* () {
      const watchdog = yield* TurnWatchdog;

      // 12 ticks * 30s = 6 minutes of cumulative runtime, comfortably past
      // the 5-minute threshold, but activity never goes stale for longer
      // than 30s at a time.
      for (let tick = 0; tick < 12; tick += 1) {
        const nowMs = yield* Clock.currentTimeMillis;
        const nowIso = new Date(nowMs).toISOString();
        harness.setThread(
          makeThread({
            id: threadId,
            turnId,
            sessionStatus: "running",
            turnStartedAtIso: requestedAtIso,
            activities: [
              makeActivity({ kind: "tool.completed", tone: "tool", turnId, createdAt: nowIso }),
            ],
          }),
        );
        yield* watchdog.sweepOnce;
        yield* TestClock.adjust(Duration.seconds(30));
      }

      expect(harness.dispatched).toEqual([]);
      expect(harness.stoppedThreadIds).toEqual([]);
    }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
  },
);

it.effect("skips threads with no active turn", () => {
  const threadId = ThreadId.make("thread-watchdog-idle");
  const nowIso = new Date(0).toISOString();
  const thread = makeThread({
    id: threadId,
    turnId: null,
    sessionStatus: "ready",
    turnStartedAtIso: nowIso,
  });
  const harness = makeHarness(thread);

  return Effect.gen(function* () {
    const watchdog = yield* TurnWatchdog;

    yield* TestClock.adjust(Duration.hours(2));
    yield* watchdog.sweepOnce;

    expect(harness.dispatched).toEqual([]);
    expect(harness.stoppedThreadIds).toEqual([]);
  }).pipe(Effect.provide(Layer.merge(harness.watchdogLayer, TestClock.layer())));
});
