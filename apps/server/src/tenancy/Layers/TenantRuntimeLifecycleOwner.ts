import path from "node:path";

import type { ProviderSessionIsolation, TenantRuntimeIsolation } from "@t3tools/contracts";
import { DEFAULT_PUBLIC_ACCESS_LIMITS } from "@t3tools/shared/tenancy";
import { Duration, Effect, FileSystem, Layer, Ref, Schedule } from "effect";

import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";
import {
  ProviderSessionRuntimeRepository,
  type ProviderSessionRuntime,
  type ProviderSessionRuntimeRepositoryShape,
} from "../../persistence/Services/ProviderSessionRuntime.ts";
import type { TenantRuntimeHealthSnapshot } from "../runtimeLifecyclePlanner.ts";
import {
  TenantRuntimeLifecycleOwner,
  type TenantRuntimeLifecycleOwnerShape,
} from "../Services/TenantRuntimeLifecycleOwner.ts";
import {
  runTenantRuntimeLifecycleSchedulerOnce,
  type TenantRuntimeLifecycleSchedulerError,
  type TenantRuntimeLifecycleSchedulerInput,
  type TenantRuntimeLifecycleSchedulerResult,
} from "../runtimeLifecycleScheduler.ts";
import { createTenantRuntimeSystemdLifecycleExecutor } from "../runtimeSystemdExecutor.ts";
import {
  createTenantRuntimeSystemdHealthProbe,
  type TenantRuntimeHealthProbe,
} from "../runtimeSystemdHealthProbe.ts";

const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

export interface TenantRuntimeLifecycleSnapshotInput {
  readonly demandRuntimeIds: ReadonlyArray<TenantRuntimeIsolation["runtimeId"]>;
  readonly lastActivityByRuntimeId: Readonly<Record<string, string | null>>;
  readonly healthByRuntimeId: Readonly<Record<string, TenantRuntimeHealthSnapshot>>;
}

export type TenantRuntimeLifecycleSchedulerRunner = (
  input: TenantRuntimeLifecycleSchedulerInput,
) => Effect.Effect<
  TenantRuntimeLifecycleSchedulerResult,
  TenantRuntimeLifecycleSchedulerError,
  FileSystem.FileSystem | TenancyRepository
>;

export type TenantRuntimeLifecycleSnapshotSource = () => Effect.Effect<
  TenantRuntimeLifecycleSnapshotInput,
  never,
  TenancyRepository
>;

export type TenantRuntimeLifecycleHealthSource = (input: {
  readonly runtimes: ReadonlyArray<TenantRuntimeIsolation>;
}) => Effect.Effect<Readonly<Record<string, TenantRuntimeHealthSnapshot>>, never>;

export type TenantRuntimeLifecycleActivitySource = (input: {
  readonly runtimes: ReadonlyArray<TenantRuntimeIsolation>;
  readonly providerSessions: ReadonlyArray<ProviderSessionIsolation>;
}) => Effect.Effect<Readonly<Record<string, string | null>>, never>;

export interface TenantRuntimeLifecycleSnapshotSourceOptions {
  readonly activitySource?: TenantRuntimeLifecycleActivitySource;
  readonly healthSource?: TenantRuntimeLifecycleHealthSource;
}

export interface TenantRuntimeLifecycleOwnerLiveOptions {
  readonly schedulerRunner?: TenantRuntimeLifecycleSchedulerRunner;
  readonly snapshotSource?: TenantRuntimeLifecycleSnapshotSource;
  readonly activitySource?: TenantRuntimeLifecycleActivitySource;
  readonly healthProbe?: TenantRuntimeHealthProbe;
  readonly sweepIntervalMs?: number;
  readonly now?: () => string;
  readonly unitDirectory?: string;
}

function schedulerSummary(result: TenantRuntimeLifecycleSchedulerResult) {
  return {
    runtimeCount: result.loadedState.runtimes.length,
    plannedActionCount: result.supervisor.steps.length,
    executedActionCount: result.supervisor.results.filter((entry) => entry.outcome === "executed")
      .length,
    skippedActionCount: result.supervisor.results.filter((entry) => entry.outcome === "skipped")
      .length,
    deniedDemandCount: result.admission.deniedDemandRuntimeIds.length,
    activeTenantRuntimesForMachine: result.admission.activeTenantRuntimesForMachine,
    maximumActiveTenantRuntimesForMachine: result.admission.maximumActiveTenantRuntimesForMachine,
  };
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function providerSessionBelongsToRuntime(input: {
  readonly providerSession: ProviderSessionIsolation;
  readonly runtime: TenantRuntimeIsolation;
}): boolean {
  return (
    input.providerSession.tenantId === input.runtime.tenantId &&
    (isPathWithin(input.providerSession.cwd, input.runtime.baseDir) ||
      isPathWithin(input.providerSession.providerHomeDir, input.runtime.providerHomesDir))
  );
}

function isProviderRuntimeActive(runtime: ProviderSessionRuntime): boolean {
  return runtime.status === "starting" || runtime.status === "running";
}

function runtimePayloadCwd(runtime: ProviderSessionRuntime): string | null {
  const payload = runtime.runtimePayload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const cwd = (payload as Record<string, unknown>).cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : null;
}

function providerRuntimeBelongsToTenantRuntime(input: {
  readonly providerRuntime: ProviderSessionRuntime;
  readonly runtime: TenantRuntimeIsolation;
}): boolean {
  const cwd = runtimePayloadCwd(input.providerRuntime);
  return cwd !== null && isPathWithin(cwd, input.runtime.baseDir);
}

function latestIsoDate(left: string | null | undefined, right: string): string {
  if (!left) {
    return right;
  }
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function makeProviderSessionRuntimeActivitySource(
  repository: ProviderSessionRuntimeRepositoryShape,
): TenantRuntimeLifecycleActivitySource {
  return ({ runtimes }) =>
    repository.list().pipe(
      Effect.catch((error) =>
        Effect.logWarning("tenant.runtime.lifecycle.provider-activity-load-failed", {
          error,
        }).pipe(Effect.as([] as ReadonlyArray<ProviderSessionRuntime>)),
      ),
      Effect.map((providerRuntimes) => {
        const lastActivityByRuntimeId: Record<string, string | null> = {};

        for (const providerRuntime of providerRuntimes) {
          if (!isProviderRuntimeActive(providerRuntime)) {
            continue;
          }

          const runtime = runtimes.find((candidate) =>
            providerRuntimeBelongsToTenantRuntime({
              providerRuntime,
              runtime: candidate,
            }),
          );
          if (!runtime) {
            continue;
          }

          const runtimeId = String(runtime.runtimeId);
          lastActivityByRuntimeId[runtimeId] = latestIsoDate(
            lastActivityByRuntimeId[runtimeId],
            providerRuntime.lastSeenAt,
          );
        }

        return lastActivityByRuntimeId;
      }),
    );
}

function shouldProbeRuntimeHealth(runtime: TenantRuntimeIsolation): boolean {
  return runtime.status === "starting" || runtime.status === "running";
}

function makeTenantRuntimeLifecycleHealthSource(input: {
  readonly healthProbe: TenantRuntimeHealthProbe;
  readonly failureCounts: Ref.Ref<Map<string, number>>;
}): TenantRuntimeLifecycleHealthSource {
  return ({ runtimes }) =>
    Effect.gen(function* () {
      const snapshots: Record<string, TenantRuntimeHealthSnapshot> = {};

      for (const runtime of runtimes) {
        if (!shouldProbeRuntimeHealth(runtime)) {
          continue;
        }

        const runtimeId = String(runtime.runtimeId);
        const health = yield* input.healthProbe(runtime);
        const failureCounts = yield* Ref.get(input.failureCounts);
        const previousFailures = failureCounts.get(runtimeId) ?? 0;
        const consecutiveHealthFailures =
          health.healthCheckSucceeded === false ? previousFailures + 1 : 0;

        yield* Ref.set(
          input.failureCounts,
          new Map(failureCounts).set(runtimeId, consecutiveHealthFailures),
        );
        snapshots[runtimeId] = {
          ...health,
          consecutiveHealthFailures,
        };
      }

      return snapshots;
    });
}

export const loadTenantRuntimeLifecycleSnapshotInput = (
  options: TenantRuntimeLifecycleSnapshotSourceOptions = {},
): Effect.Effect<TenantRuntimeLifecycleSnapshotInput, never, TenancyRepository> =>
  Effect.gen(function* () {
    const repository = yield* TenancyRepository;
    const [runtimeState, providerIsolation] = yield* Effect.all([
      repository.loadTenantRuntimeLifecycleState(),
      repository.loadProviderIsolation(),
    ]).pipe(
      Effect.catch((error) =>
        Effect.logWarning("tenant.runtime.lifecycle.snapshot-load-failed", {
          error,
        }).pipe(
          Effect.as([
            {
              runtimes: [],
              systemdUnits: [],
              completedSteps: [],
            },
            {
              providerAccounts: [],
              providerSessions: [],
            },
          ] as const),
        ),
      ),
    );
    const demandRuntimeIds = new Set<TenantRuntimeIsolation["runtimeId"]>();
    const lastActivityByRuntimeId: Record<string, string | null> = {};

    for (const providerSession of providerIsolation.providerSessions) {
      if (providerSession.endedAt !== null) {
        continue;
      }

      const runtime = runtimeState.runtimes.find((candidate) =>
        providerSessionBelongsToRuntime({
          providerSession,
          runtime: candidate,
        }),
      );
      if (!runtime) {
        continue;
      }

      demandRuntimeIds.add(runtime.runtimeId);
      const runtimeId = String(runtime.runtimeId);
      lastActivityByRuntimeId[runtimeId] = latestIsoDate(
        lastActivityByRuntimeId[runtimeId],
        providerSession.createdAt,
      );
    }
    const providerActivityByRuntimeId = options.activitySource
      ? yield* options.activitySource({
          runtimes: runtimeState.runtimes,
          providerSessions: providerIsolation.providerSessions,
        })
      : {};
    for (const [runtimeId, lastActivityAt] of Object.entries(providerActivityByRuntimeId)) {
      if (lastActivityAt !== null) {
        lastActivityByRuntimeId[runtimeId] = latestIsoDate(
          lastActivityByRuntimeId[runtimeId],
          lastActivityAt,
        );
      }
    }
    const healthByRuntimeId = options.healthSource
      ? yield* options.healthSource({ runtimes: runtimeState.runtimes })
      : {};

    return {
      demandRuntimeIds: Array.from(demandRuntimeIds),
      lastActivityByRuntimeId,
      healthByRuntimeId,
    };
  });

export const makeTenantRuntimeLifecycleOwner = (
  options: TenantRuntimeLifecycleOwnerLiveOptions = {},
) =>
  Effect.gen(function* () {
    const repository = yield* TenancyRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const schedulerRunner = options.schedulerRunner ?? runTenantRuntimeLifecycleSchedulerOnce;
    const sweepIntervalMs = Math.max(1, options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const now = options.now ?? (() => new Date().toISOString());
    const executor = createTenantRuntimeSystemdLifecycleExecutor();
    const failureCounts = yield* Ref.make(new Map<string, number>());
    const healthSource = makeTenantRuntimeLifecycleHealthSource({
      healthProbe: options.healthProbe ?? createTenantRuntimeSystemdHealthProbe(),
      failureCounts,
    });
    let providerSessionRuntimeRepository: ProviderSessionRuntimeRepositoryShape | null = null;
    if (!options.snapshotSource && !options.activitySource) {
      providerSessionRuntimeRepository = yield* ProviderSessionRuntimeRepository;
    }
    const activitySource =
      options.activitySource ??
      (providerSessionRuntimeRepository
        ? makeProviderSessionRuntimeActivitySource(providerSessionRuntimeRepository)
        : undefined);
    const snapshotSource =
      options.snapshotSource ??
      (() =>
        loadTenantRuntimeLifecycleSnapshotInput({
          ...(activitySource ? { activitySource } : {}),
          healthSource,
        }));

    const runOnce = snapshotSource().pipe(
      Effect.provideService(TenancyRepository, repository),
      Effect.flatMap((snapshotInput) =>
        schedulerRunner({
          now: now(),
          demandRuntimeIds: snapshotInput.demandRuntimeIds,
          healthByRuntimeId: snapshotInput.healthByRuntimeId,
          lastActivityByRuntimeId: snapshotInput.lastActivityByRuntimeId,
          maxWallClockMs: DEFAULT_PUBLIC_ACCESS_LIMITS.maxRuntimeWallClockMs,
          limits: DEFAULT_PUBLIC_ACCESS_LIMITS,
          executor,
          ...(options.unitDirectory ? { unitDirectory: options.unitDirectory } : {}),
        }),
      ),
      Effect.provideService(TenancyRepository, repository),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );

    const sweep = runOnce.pipe(
      Effect.tap((result) =>
        Effect.logInfo("tenant.runtime.lifecycle.sweep-complete", schedulerSummary(result)),
      ),
      Effect.catch((error) =>
        Effect.logWarning("tenant.runtime.lifecycle.sweep-failed", {
          error,
        }),
      ),
      Effect.catchDefect((defect) =>
        Effect.logWarning("tenant.runtime.lifecycle.sweep-defect", {
          defect,
        }),
      ),
    );

    const start: TenantRuntimeLifecycleOwnerShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs)))),
        );
        yield* Effect.logInfo("tenant.runtime.lifecycle.owner.started", {
          sweepIntervalMs,
        });
      });

    return {
      runOnce,
      start,
    } satisfies TenantRuntimeLifecycleOwnerShape;
  });

export const makeTenantRuntimeLifecycleOwnerLive = (
  options?: TenantRuntimeLifecycleOwnerLiveOptions,
) => Layer.effect(TenantRuntimeLifecycleOwner, makeTenantRuntimeLifecycleOwner(options));

export const TenantRuntimeLifecycleOwnerLive = makeTenantRuntimeLifecycleOwnerLive();
