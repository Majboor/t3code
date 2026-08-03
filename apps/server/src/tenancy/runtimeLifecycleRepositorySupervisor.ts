import path from "node:path";

import type { TenantRuntimeIsolation } from "@t3tools/contracts";
import { deriveTenantRuntimeSystemdUnit } from "@t3tools/shared/tenancy";
import { Data, Effect, FileSystem } from "effect";

import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import type { TenancyRepositoryError } from "../persistence/Errors.ts";
import type {
  TenantRuntimeLifecycleCompletedStepPersistenceRecord,
  TenantRuntimeLifecyclePersistenceSnapshot,
  TenantRuntimeSystemdUnitPersistenceRecord,
} from "../persistence/Services/Tenancy.ts";
import type { TenantRuntimeLifecycleExecutionStep } from "./runtimeLifecyclePlanner.ts";
import {
  TenantRuntimeLifecycleExecutorError,
  TenantRuntimeLifecycleSupervisorError,
  type TenantRuntimeLifecycleStepExecutor,
  type TenantRuntimeLifecycleSupervisorInput,
  type TenantRuntimeLifecycleSupervisorResult,
  superviseTenantRuntimeLifecycle,
} from "./runtimeLifecycleSupervisor.ts";

export class TenantRuntimeLifecycleRepositorySupervisorError extends Data.TaggedError(
  "TenantRuntimeLifecycleRepositorySupervisorError",
)<{
  readonly message: string;
  readonly cause: TenancyRepositoryError | TenantRuntimeLifecycleSupervisorError;
}> {}

export interface TenantRuntimeLifecycleRepositorySupervisorInput extends Omit<
  TenantRuntimeLifecycleSupervisorInput,
  "completedStepIds"
> {
  readonly loadedState?: TenantRuntimeLifecyclePersistenceSnapshot;
  readonly unitDirectory?: string;
}

export interface TenantRuntimeLifecycleRepositorySupervisorResult extends TenantRuntimeLifecycleSupervisorResult {
  readonly persistedState: TenantRuntimeLifecyclePersistenceSnapshot;
}

const DEFAULT_SYSTEMD_UNIT_DIRECTORY = "/etc/systemd/system";

function mergeSystemdUnitRecords(
  existing: ReadonlyArray<TenantRuntimeSystemdUnitPersistenceRecord>,
  additions: ReadonlyArray<TenantRuntimeSystemdUnitPersistenceRecord>,
): ReadonlyArray<TenantRuntimeSystemdUnitPersistenceRecord> {
  const records = new Map<string, TenantRuntimeSystemdUnitPersistenceRecord>(
    existing.map((record) => [String(record.runtimeId), record]),
  );
  for (const addition of additions) {
    records.set(String(addition.runtimeId), addition);
  }
  return Array.from(records.values());
}

function mergeRuntimeDescriptors(
  existing: ReadonlyArray<TenantRuntimeIsolation>,
  additions: ReadonlyArray<TenantRuntimeIsolation>,
): ReadonlyArray<TenantRuntimeIsolation> {
  const runtimes = new Map<string, TenantRuntimeIsolation>(
    existing.map((runtime) => [String(runtime.runtimeId), runtime]),
  );
  for (const addition of additions) {
    runtimes.set(String(addition.runtimeId), addition);
  }
  return Array.from(runtimes.values());
}

function mergeCompletedStepRecords(
  existing: ReadonlyArray<TenantRuntimeLifecycleCompletedStepPersistenceRecord>,
  additions: ReadonlyArray<TenantRuntimeLifecycleCompletedStepPersistenceRecord>,
): ReadonlyArray<TenantRuntimeLifecycleCompletedStepPersistenceRecord> {
  const records = new Map<string, TenantRuntimeLifecycleCompletedStepPersistenceRecord>(
    existing.map((record) => [record.idempotencyKey, record]),
  );
  for (const addition of additions) {
    records.set(addition.idempotencyKey, addition);
  }
  return Array.from(records.values());
}

function completionRecord(
  step: TenantRuntimeLifecycleExecutionStep,
  completedAt: string,
): TenantRuntimeLifecycleCompletedStepPersistenceRecord {
  return {
    idempotencyKey: step.idempotencyKey,
    tenantId: step.runtime.tenantId,
    runtimeId: step.runtime.runtimeId,
    operation: step.operation,
    sourceAction: step.sourceAction,
    targetStatus: step.targetStatus,
    processAction: step.processAction,
    reason: step.reason,
    completedAt,
  };
}

function systemdUnitRecord(
  step: TenantRuntimeLifecycleExecutionStep,
  generatedAt: string,
): TenantRuntimeSystemdUnitPersistenceRecord {
  const unit = deriveTenantRuntimeSystemdUnit({ runtime: step.runtime });
  return {
    tenantId: step.runtime.tenantId,
    runtimeId: step.runtime.runtimeId,
    unitName: unit.unitName,
    unitFile: unit.unitFile,
    generatedAt,
    lastWrittenAt: generatedAt,
  };
}

function runtimeAfterCompletedStep(
  step: TenantRuntimeLifecycleExecutionStep,
  completedAt: string,
): TenantRuntimeIsolation {
  const runtime = step.runtime;
  switch (step.operation) {
    case "provision-and-start":
      return {
        ...runtime,
        status: step.targetStatus,
        lastStartedAt: completedAt,
        lastStoppedAt: null,
      };
    case "mark-running":
      return {
        ...runtime,
        status: step.targetStatus,
        lastStartedAt: runtime.lastStartedAt ?? completedAt,
      };
    case "stop":
    case "restart":
    case "quarantine":
      return {
        ...runtime,
        status: step.targetStatus,
        lastStoppedAt: completedAt,
      };
    case "mark-stopped":
      return {
        ...runtime,
        status: step.targetStatus,
        lastStoppedAt: runtime.lastStoppedAt ?? completedAt,
      };
    case "record-denied-start":
      return {
        ...runtime,
        status: step.targetStatus,
      };
  }
}

function writeTenantRuntimeSystemdUnitFile(
  step: TenantRuntimeLifecycleExecutionStep,
  unitDirectory: string,
): Effect.Effect<void, TenantRuntimeLifecycleExecutorError, FileSystem.FileSystem> {
  const unit = deriveTenantRuntimeSystemdUnit({ runtime: step.runtime });
  const unitPath = path.join(unitDirectory, unit.unitName);

  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(unitDirectory, { recursive: true });
    yield* fileSystem.writeFileString(unitPath, unit.unitFile);
  }).pipe(
    Effect.mapError(
      (cause) =>
        new TenantRuntimeLifecycleExecutorError({
          message: `Failed to write tenant runtime systemd unit: ${unitPath}.`,
          cause,
        }),
    ),
  );
}

function withSystemdUnitWrites(
  executor: TenantRuntimeLifecycleStepExecutor,
  unitDirectory: string,
  fileSystem: FileSystem.FileSystem,
): TenantRuntimeLifecycleStepExecutor {
  return {
    ...executor,
    provisionAndStart: (step) =>
      writeTenantRuntimeSystemdUnitFile(step, unitDirectory).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.flatMap(() => executor.provisionAndStart(step)),
      ),
  };
}

function completedStepIds(state: TenantRuntimeLifecyclePersistenceSnapshot): ReadonlyArray<string> {
  return state.completedSteps.map((step) => step.idempotencyKey);
}

function persistSuccessfulLifecycleState(input: {
  readonly previousState: TenantRuntimeLifecyclePersistenceSnapshot;
  readonly result: TenantRuntimeLifecycleSupervisorResult;
  readonly now: string;
}): TenantRuntimeLifecyclePersistenceSnapshot {
  const executedSteps = input.result.results
    .filter((entry) => entry.outcome === "executed")
    .map((entry) => entry.step);
  const unitRecords = executedSteps
    .filter((step) => step.operation === "provision-and-start")
    .map((step) => systemdUnitRecord(step, input.now));

  return {
    runtimes: mergeRuntimeDescriptors(
      input.previousState.runtimes,
      executedSteps.map((step) => runtimeAfterCompletedStep(step, input.now)),
    ),
    systemdUnits: mergeSystemdUnitRecords(input.previousState.systemdUnits, unitRecords),
    completedSteps: mergeCompletedStepRecords(
      input.previousState.completedSteps,
      executedSteps.map((step) => completionRecord(step, input.now)),
    ),
  };
}

export function superviseTenantRuntimeLifecycleWithRepository(
  input: TenantRuntimeLifecycleRepositorySupervisorInput,
): Effect.Effect<
  TenantRuntimeLifecycleRepositorySupervisorResult,
  TenantRuntimeLifecycleRepositorySupervisorError,
  FileSystem.FileSystem | TenancyRepository
> {
  return Effect.gen(function* () {
    const repository = yield* TenancyRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const previousState =
      input.loadedState ??
      (yield* repository.loadTenantRuntimeLifecycleState().pipe(
        Effect.mapError(
          (cause) =>
            new TenantRuntimeLifecycleRepositorySupervisorError({
              message: "Failed to load tenant runtime lifecycle state.",
              cause,
            }),
        ),
      ));
    const result = yield* superviseTenantRuntimeLifecycle({
      ...input,
      executor: withSystemdUnitWrites(
        input.executor,
        input.unitDirectory ?? DEFAULT_SYSTEMD_UNIT_DIRECTORY,
        fileSystem,
      ),
      completedStepIds: completedStepIds(previousState),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new TenantRuntimeLifecycleRepositorySupervisorError({
            message: "Tenant runtime lifecycle supervision failed.",
            cause,
          }),
      ),
    );
    const nextState = persistSuccessfulLifecycleState({
      previousState,
      result,
      now: input.now,
    });

    yield* repository.saveTenantRuntimeLifecycleState(nextState).pipe(
      Effect.mapError(
        (cause) =>
          new TenantRuntimeLifecycleRepositorySupervisorError({
            message: "Failed to save tenant runtime lifecycle state.",
            cause,
          }),
      ),
    );

    return {
      ...result,
      persistedState: nextState,
    };
  });
}
