import type { PublicAccessLimits, TenantRuntimeIsolation } from "@t3tools/contracts";
import { DEFAULT_PUBLIC_ACCESS_LIMITS } from "@t3tools/shared/tenancy";
import { Data, Effect, FileSystem } from "effect";

import type { TenancyRepositoryError } from "../persistence/Errors.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import type { TenantRuntimeLifecyclePersistenceSnapshot } from "../persistence/Services/Tenancy.ts";
import type { TenantRuntimeLifecyclePlanInput } from "./runtimeLifecyclePlanner.ts";
import type { TenantRuntimeLifecycleStepExecutor } from "./runtimeLifecycleSupervisor.ts";
import {
  TenantRuntimeLifecycleRepositorySupervisorError,
  type TenantRuntimeLifecycleRepositorySupervisorResult,
  superviseTenantRuntimeLifecycleWithRepository,
} from "./runtimeLifecycleRepositorySupervisor.ts";

export class TenantRuntimeLifecycleSchedulerError extends Data.TaggedError(
  "TenantRuntimeLifecycleSchedulerError",
)<{
  readonly message: string;
  readonly cause: TenancyRepositoryError | TenantRuntimeLifecycleRepositorySupervisorError;
}> {}

export interface TenantRuntimeLifecycleSchedulerInput extends Omit<
  TenantRuntimeLifecyclePlanInput,
  "runtimes"
> {
  readonly executor: TenantRuntimeLifecycleStepExecutor;
  readonly limits?: PublicAccessLimits;
  readonly unitDirectory?: string;
}

export interface TenantRuntimeLifecycleSchedulerAdmission {
  readonly activeTenantRuntimesForMachine: number;
  readonly maximumActiveTenantRuntimesForMachine: number;
  readonly admittedDemandRuntimeIds: ReadonlyArray<TenantRuntimeIsolation["runtimeId"]>;
  readonly deniedDemandRuntimeIds: ReadonlyArray<TenantRuntimeIsolation["runtimeId"]>;
}

export interface TenantRuntimeLifecycleSchedulerResult {
  readonly loadedState: TenantRuntimeLifecyclePersistenceSnapshot;
  readonly admission: TenantRuntimeLifecycleSchedulerAdmission;
  readonly supervisor: TenantRuntimeLifecycleRepositorySupervisorResult;
}

const ACTIVE_RUNTIME_STATUSES = new Set<TenantRuntimeIsolation["status"]>([
  "starting",
  "running",
  "stopping",
]);

function normalizeDemandRuntimeIds(
  demandRuntimeIds: TenantRuntimeLifecycleSchedulerInput["demandRuntimeIds"],
): ReadonlyArray<TenantRuntimeIsolation["runtimeId"]> {
  if (!demandRuntimeIds) {
    return [];
  }
  return Array.from(demandRuntimeIds) as unknown as ReadonlyArray<
    TenantRuntimeIsolation["runtimeId"]
  >;
}

function isActiveRuntime(runtime: TenantRuntimeIsolation): boolean {
  return ACTIVE_RUNTIME_STATUSES.has(runtime.status);
}

function applyMachineRuntimeAdmission(input: {
  readonly runtimes: ReadonlyArray<TenantRuntimeIsolation>;
  readonly demandRuntimeIds: TenantRuntimeLifecycleSchedulerInput["demandRuntimeIds"];
  readonly limits: PublicAccessLimits;
}): TenantRuntimeLifecycleSchedulerAdmission {
  const demandRuntimeIds = normalizeDemandRuntimeIds(input.demandRuntimeIds);
  const activeTenantRuntimesForMachine = input.runtimes.filter(isActiveRuntime).length;
  let availableStarts =
    input.limits.maxActiveTenantRuntimesPerMachine - activeTenantRuntimesForMachine;
  const admittedDemandRuntimeIds: TenantRuntimeIsolation["runtimeId"][] = [];
  const deniedDemandRuntimeIds: TenantRuntimeIsolation["runtimeId"][] = [];

  for (const runtimeId of demandRuntimeIds) {
    const runtime = input.runtimes.find((candidate) => candidate.runtimeId === runtimeId);
    if (!runtime || runtime.status !== "stopped") {
      admittedDemandRuntimeIds.push(runtimeId);
      continue;
    }

    if (availableStarts > 0) {
      admittedDemandRuntimeIds.push(runtimeId);
      availableStarts -= 1;
    } else {
      deniedDemandRuntimeIds.push(runtimeId);
    }
  }

  return {
    activeTenantRuntimesForMachine,
    maximumActiveTenantRuntimesForMachine: input.limits.maxActiveTenantRuntimesPerMachine,
    admittedDemandRuntimeIds,
    deniedDemandRuntimeIds,
  };
}

export function runTenantRuntimeLifecycleSchedulerOnce(
  input: TenantRuntimeLifecycleSchedulerInput,
): Effect.Effect<
  TenantRuntimeLifecycleSchedulerResult,
  TenantRuntimeLifecycleSchedulerError,
  FileSystem.FileSystem | TenancyRepository
> {
  return Effect.gen(function* () {
    const repository = yield* TenancyRepository;
    const loadedState = yield* repository.loadTenantRuntimeLifecycleState().pipe(
      Effect.mapError(
        (cause) =>
          new TenantRuntimeLifecycleSchedulerError({
            message: "Failed to load tenant runtime lifecycle state for scheduler tick.",
            cause,
          }),
      ),
    );
    const limits = input.limits ?? DEFAULT_PUBLIC_ACCESS_LIMITS;
    const admission = applyMachineRuntimeAdmission({
      runtimes: loadedState.runtimes,
      demandRuntimeIds: input.demandRuntimeIds,
      limits,
    });
    const supervisor = yield* superviseTenantRuntimeLifecycleWithRepository({
      ...input,
      runtimes: loadedState.runtimes,
      demandRuntimeIds: admission.admittedDemandRuntimeIds,
      loadedState,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TenantRuntimeLifecycleSchedulerError({
            message: "Tenant runtime lifecycle scheduler tick failed.",
            cause,
          }),
      ),
    );

    return {
      loadedState,
      admission,
      supervisor,
    };
  });
}
