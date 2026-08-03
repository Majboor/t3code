import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  TenantRuntimeId,
  ThreadId,
  UserId,
} from "@t3tools/contracts";
import { deriveTenantRuntimeDirectoryLayout } from "@t3tools/shared/tenancy";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import type {
  ProviderIsolationPersistenceSnapshot,
  TenancyRepositoryShape,
  TenantRuntimeLifecyclePersistenceSnapshot,
} from "../../persistence/Services/Tenancy.ts";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntime,
  type ProviderSessionRuntimeRepositoryShape,
} from "../../persistence/Services/ProviderSessionRuntime.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import {
  loadTenantRuntimeLifecycleSnapshotInput,
  makeTenantRuntimeLifecycleOwner,
  type TenantRuntimeLifecycleSchedulerRunner,
} from "./TenantRuntimeLifecycleOwner.ts";

const emptyLifecycleState = {
  runtimes: [],
  systemdUnits: [],
  completedSteps: [],
} satisfies TenantRuntimeLifecyclePersistenceSnapshot;

const emptySchedulerResult = {
  loadedState: emptyLifecycleState,
  admission: {
    activeTenantRuntimesForMachine: 0,
    maximumActiveTenantRuntimesForMachine: 100,
    admittedDemandRuntimeIds: [],
    deniedDemandRuntimeIds: [],
  },
  supervisor: {
    plan: {
      entries: [],
      actionable: [],
    },
    steps: [],
    results: [],
    persistedState: emptyLifecycleState,
  },
};

function makeRepositoryLayer(
  overrides: {
    readonly runtimeState?: TenantRuntimeLifecyclePersistenceSnapshot;
    readonly providerIsolation?: ProviderIsolationPersistenceSnapshot;
  } = {},
): Layer.Layer<TenancyRepository> {
  const emptySnapshot = {
    organizations: [],
    tenants: [],
    employees: [],
    invites: [],
    memberships: [],
    teams: [],
    departments: [],
    grants: [],
    reviews: [],
    auditEvents: [],
  };
  const repository: TenancyRepositoryShape = {
    loadOrganizations: () => Effect.succeed(emptySnapshot),
    saveOrganizations: () => Effect.void,
    loadCollaboration: () =>
      Effect.succeed({
        presence: [],
        invites: [],
        memberships: [],
        activities: [],
      }),
    saveCollaboration: () => Effect.void,
    loadWorkspaces: () =>
      Effect.succeed({
        workspaces: [],
      }),
    saveWorkspaces: () => Effect.void,
    loadProviderIsolation: () =>
      Effect.succeed(overrides.providerIsolation ?? { providerAccounts: [], providerSessions: [] }),
    saveProviderIsolation: () => Effect.void,
    loadTenantRuntimeLifecycleState: () =>
      Effect.succeed(overrides.runtimeState ?? emptyLifecycleState),
    saveTenantRuntimeLifecycleState: () => Effect.void,
  };

  return Layer.succeed(TenancyRepository, repository);
}

function makeProviderSessionRuntimeRepositoryLayer(
  runtimes: ReadonlyArray<ProviderSessionRuntime> = [],
): Layer.Layer<ProviderSessionRuntimeRepository> {
  const repository: ProviderSessionRuntimeRepositoryShape = {
    upsert: () => Effect.void,
    getByThreadId: ({ threadId }) => {
      const runtime = runtimes.find((candidate) => candidate.threadId === threadId);
      return Effect.succeed(runtime ? Option.some(runtime) : Option.none());
    },
    list: () => Effect.succeed(runtimes),
    deleteByThreadId: () => Effect.void,
  };

  return Layer.succeed(ProviderSessionRuntimeRepository, repository);
}

function makeRuntime() {
  const tenantId = TenantId.make("tenant-runtime-owner");
  const layout = deriveTenantRuntimeDirectoryLayout({
    tenantId,
    rootDir: "/opt/t3-tenants",
  });
  return {
    runtimeId: TenantRuntimeId.make("runtime-owner-live-snapshot"),
    tenantId,
    strategy: "systemd-per-tenant" as const,
    linuxUser: "t3-tenant-runtime-owner",
    baseDir: layout.baseDir,
    dataDir: layout.dataDir,
    secretsDir: layout.secretsDir,
    attachmentsDir: layout.attachmentsDir,
    worktreesDir: layout.worktreesDir,
    runsDir: layout.runsDir,
    providerHomesDir: layout.providerHomesDir,
    internalHost: "127.0.0.1",
    internalPort: 4473,
    status: "running" as const,
    idleShutdownAfterMs: 900_000,
    lastStartedAt: "2026-05-09T09:00:00.000Z",
    lastStoppedAt: null,
  };
}

describe("tenant runtime lifecycle owner", () => {
  it("runs the scheduler with production runtime-owner defaults", async () => {
    const calls: unknown[] = [];
    const schedulerRunner: TenantRuntimeLifecycleSchedulerRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return emptySchedulerResult;
      });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* makeTenantRuntimeLifecycleOwner({
          now: () => "2026-05-09T10:00:00.000Z",
          schedulerRunner,
          unitDirectory: "/tmp/t3-runtime-owner-units",
        });
        return yield* owner.runOnce;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeRepositoryLayer(),
            makeProviderSessionRuntimeRepositoryLayer(),
          ),
        ),
      ),
    );

    expect(result).toEqual(emptySchedulerResult);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      now: "2026-05-09T10:00:00.000Z",
      demandRuntimeIds: [],
      healthByRuntimeId: {},
      lastActivityByRuntimeId: {},
      unitDirectory: "/tmp/t3-runtime-owner-units",
    });
  });

  it("derives demand and last activity from active provider sessions under tenant runtimes", async () => {
    const runtime = makeRuntime();
    const runtimeState = {
      runtimes: [runtime],
      systemdUnits: [],
      completedSteps: [],
    } satisfies TenantRuntimeLifecyclePersistenceSnapshot;
    const providerIsolation = {
      providerAccounts: [],
      providerSessions: [
        {
          id: ProviderSessionId.make("provider-session-active-old"),
          tenantId: runtime.tenantId,
          userId: UserId.make("user-runtime-owner"),
          providerAccountId: ProviderAccountId.make("provider-account-runtime-owner"),
          provider: "codex" as const,
          providerHomeDir: `${runtime.providerHomesDir}/user-runtime-owner/codex`,
          cwd: `${runtime.worktreesDir}/project-a`,
          createdAt: "2026-05-09T09:15:00.000Z",
          endedAt: null,
        },
        {
          id: ProviderSessionId.make("provider-session-active-new"),
          tenantId: runtime.tenantId,
          userId: UserId.make("user-runtime-owner"),
          providerAccountId: ProviderAccountId.make("provider-account-runtime-owner"),
          provider: "codex" as const,
          providerHomeDir: `${runtime.providerHomesDir}/user-runtime-owner/codex`,
          cwd: `${runtime.worktreesDir}/project-b`,
          createdAt: "2026-05-09T09:45:00.000Z",
          endedAt: null,
        },
        {
          id: ProviderSessionId.make("provider-session-ended"),
          tenantId: runtime.tenantId,
          userId: UserId.make("user-runtime-owner"),
          providerAccountId: ProviderAccountId.make("provider-account-runtime-owner"),
          provider: "codex" as const,
          providerHomeDir: `${runtime.providerHomesDir}/user-runtime-owner/codex`,
          cwd: `${runtime.worktreesDir}/project-ended`,
          createdAt: "2026-05-09T09:50:00.000Z",
          endedAt: "2026-05-09T09:55:00.000Z",
        },
      ],
    } satisfies ProviderIsolationPersistenceSnapshot;

    const snapshotInput = await Effect.runPromise(
      loadTenantRuntimeLifecycleSnapshotInput().pipe(
        Effect.provide(makeRepositoryLayer({ runtimeState, providerIsolation })),
      ),
    );

    expect(snapshotInput).toEqual({
      demandRuntimeIds: [runtime.runtimeId],
      lastActivityByRuntimeId: {
        [runtime.runtimeId]: "2026-05-09T09:45:00.000Z",
      },
      healthByRuntimeId: {},
    });
  });

  it("uses provider runtime lastSeenAt as a fresher activity signal than session creation", async () => {
    const runtime = makeRuntime();
    const runtimeState = {
      runtimes: [runtime],
      systemdUnits: [],
      completedSteps: [],
    } satisfies TenantRuntimeLifecyclePersistenceSnapshot;
    const providerIsolation = {
      providerAccounts: [],
      providerSessions: [
        {
          id: ProviderSessionId.make("provider-session-created-floor"),
          tenantId: runtime.tenantId,
          userId: UserId.make("user-runtime-owner"),
          providerAccountId: ProviderAccountId.make("provider-account-runtime-owner"),
          provider: "codex" as const,
          providerHomeDir: `${runtime.providerHomesDir}/user-runtime-owner/codex`,
          cwd: `${runtime.worktreesDir}/project-a`,
          createdAt: "2026-05-09T09:15:00.000Z",
          endedAt: null,
        },
      ],
    } satisfies ProviderIsolationPersistenceSnapshot;

    const snapshotInput = await Effect.runPromise(
      loadTenantRuntimeLifecycleSnapshotInput({
        activitySource: () =>
          Effect.succeed({
            [runtime.runtimeId]: "2026-05-09T09:59:00.000Z",
          }),
      }).pipe(Effect.provide(makeRepositoryLayer({ runtimeState, providerIsolation }))),
    );

    expect(snapshotInput).toEqual({
      demandRuntimeIds: [runtime.runtimeId],
      lastActivityByRuntimeId: {
        [runtime.runtimeId]: "2026-05-09T09:59:00.000Z",
      },
      healthByRuntimeId: {},
    });
  });

  it("passes live snapshot input into the scheduler", async () => {
    const runtime = makeRuntime();
    const calls: unknown[] = [];
    const schedulerRunner: TenantRuntimeLifecycleSchedulerRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return emptySchedulerResult;
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* makeTenantRuntimeLifecycleOwner({
          now: () => "2026-05-09T10:00:00.000Z",
          schedulerRunner,
          snapshotSource: () =>
            Effect.succeed({
              demandRuntimeIds: [runtime.runtimeId],
              lastActivityByRuntimeId: {
                [runtime.runtimeId]: "2026-05-09T09:45:00.000Z",
              },
              healthByRuntimeId: {
                [runtime.runtimeId]: {
                  healthCheckSucceeded: true,
                },
              },
            }),
        });
        yield* owner.runOnce;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeRepositoryLayer(),
            makeProviderSessionRuntimeRepositoryLayer(),
          ),
        ),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      demandRuntimeIds: [runtime.runtimeId],
      lastActivityByRuntimeId: {
        [runtime.runtimeId]: "2026-05-09T09:45:00.000Z",
      },
      healthByRuntimeId: {
        [runtime.runtimeId]: {
          healthCheckSucceeded: true,
        },
      },
    });
  });

  it("passes provider session runtime lastSeenAt from the default snapshot source into the scheduler", async () => {
    const runtime = makeRuntime();
    const runtimeState = {
      runtimes: [runtime],
      systemdUnits: [],
      completedSteps: [],
    } satisfies TenantRuntimeLifecyclePersistenceSnapshot;
    const providerIsolation = {
      providerAccounts: [],
      providerSessions: [
        {
          id: ProviderSessionId.make("provider-session-default-activity"),
          tenantId: runtime.tenantId,
          userId: UserId.make("user-runtime-owner"),
          providerAccountId: ProviderAccountId.make("provider-account-runtime-owner"),
          provider: "codex" as const,
          providerHomeDir: `${runtime.providerHomesDir}/user-runtime-owner/codex`,
          cwd: `${runtime.worktreesDir}/project-a`,
          createdAt: "2026-05-09T09:15:00.000Z",
          endedAt: null,
        },
      ],
    } satisfies ProviderIsolationPersistenceSnapshot;
    const calls: unknown[] = [];
    const schedulerRunner: TenantRuntimeLifecycleSchedulerRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return emptySchedulerResult;
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* makeTenantRuntimeLifecycleOwner({
          now: () => "2026-05-09T10:00:00.000Z",
          schedulerRunner,
          healthProbe: () => Effect.succeed({ healthCheckSucceeded: true }),
        });
        yield* owner.runOnce;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeRepositoryLayer({ runtimeState, providerIsolation }),
            makeProviderSessionRuntimeRepositoryLayer([
              {
                threadId: ThreadId.make("thread-runtime-activity"),
                providerName: "codex",
                adapterKey: "codex",
                runtimeMode: "full-access",
                status: "running",
                lastSeenAt: "2026-05-09T09:59:00.000Z",
                resumeCursor: null,
                runtimePayload: {
                  cwd: `${runtime.worktreesDir}/project-a`,
                },
              },
            ]),
          ),
        ),
      ),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      demandRuntimeIds: [runtime.runtimeId],
      lastActivityByRuntimeId: {
        [runtime.runtimeId]: "2026-05-09T09:59:00.000Z",
      },
    });
  });

  it("probes active runtime health and carries consecutive failure counts between sweeps", async () => {
    const runtime = {
      ...makeRuntime(),
      status: "running" as const,
      lastStartedAt: "2026-05-09T09:00:00.000Z",
    };
    const runtimeState = {
      runtimes: [runtime],
      systemdUnits: [],
      completedSteps: [],
    } satisfies TenantRuntimeLifecyclePersistenceSnapshot;
    const calls: unknown[] = [];
    const schedulerRunner: TenantRuntimeLifecycleSchedulerRunner = (input) =>
      Effect.sync(() => {
        calls.push(input);
        return emptySchedulerResult;
      });

    await Effect.runPromise(
      Effect.gen(function* () {
        const owner = yield* makeTenantRuntimeLifecycleOwner({
          now: () => "2026-05-09T10:00:00.000Z",
          schedulerRunner,
          healthProbe: () => Effect.succeed({ healthCheckSucceeded: false }),
        });
        yield* owner.runOnce;
        yield* owner.runOnce;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            makeRepositoryLayer({ runtimeState }),
            makeProviderSessionRuntimeRepositoryLayer(),
          ),
        ),
      ),
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      healthByRuntimeId: {
        [runtime.runtimeId]: {
          healthCheckSucceeded: false,
          consecutiveHealthFailures: 1,
        },
      },
    });
    expect(calls[1]).toMatchObject({
      healthByRuntimeId: {
        [runtime.runtimeId]: {
          healthCheckSucceeded: false,
          consecutiveHealthFailures: 2,
        },
      },
    });
  });

  it("starts a scoped background sweep without surfacing scheduler failures", async () => {
    let calls = 0;
    const schedulerRunner: TenantRuntimeLifecycleSchedulerRunner = () =>
      Effect.sync(() => {
        calls += 1;
      }).pipe(Effect.flatMap(() => Effect.fail(new Error("expected scheduler failure") as never)));

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeTenantRuntimeLifecycleOwner({
            schedulerRunner,
            sweepIntervalMs: 60_000,
          });
          yield* owner.start();
          yield* Effect.sleep(1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              NodeServices.layer,
              makeRepositoryLayer(),
              makeProviderSessionRuntimeRepositoryLayer(),
            ),
          ),
        ),
      ),
    );

    expect(calls).toBeGreaterThanOrEqual(1);
  });
});
