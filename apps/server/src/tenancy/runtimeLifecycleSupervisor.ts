import { Data, Effect } from "effect";

import { recordTenantRuntimeLifecycleAction } from "../observability/Metrics.ts";
import {
  type TenantRuntimeLifecycleExecutionStep,
  type TenantRuntimeLifecyclePlan,
  type TenantRuntimeLifecyclePlanInput,
  deriveTenantRuntimeLifecycleExecutionSteps,
  planTenantRuntimeLifecycle,
} from "./runtimeLifecyclePlanner.ts";

export class TenantRuntimeLifecycleSupervisorError extends Data.TaggedError(
  "TenantRuntimeLifecycleSupervisorError",
)<{
  readonly message: string;
  readonly step: TenantRuntimeLifecycleExecutionStep;
  readonly cause: TenantRuntimeLifecycleExecutorError;
}> {}

export class TenantRuntimeLifecycleExecutorError extends Data.TaggedError(
  "TenantRuntimeLifecycleExecutorError",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface TenantRuntimeLifecycleStepExecutor {
  readonly provisionAndStart: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly recordDeniedStart: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly markRunning: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly stop: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly restart: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly quarantine: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
  readonly markStopped: (
    step: TenantRuntimeLifecycleExecutionStep,
  ) => Effect.Effect<void, TenantRuntimeLifecycleExecutorError>;
}

export interface TenantRuntimeLifecycleSupervisorInput extends TenantRuntimeLifecyclePlanInput {
  readonly executor: TenantRuntimeLifecycleStepExecutor;
  readonly completedStepIds?: ReadonlySet<string> | ReadonlyArray<string>;
}

export interface TenantRuntimeLifecycleSupervisorStepResult {
  readonly step: TenantRuntimeLifecycleExecutionStep;
  readonly outcome: "executed" | "skipped";
}

export interface TenantRuntimeLifecycleSupervisorResult {
  readonly plan: TenantRuntimeLifecyclePlan;
  readonly steps: ReadonlyArray<TenantRuntimeLifecycleExecutionStep>;
  readonly results: ReadonlyArray<TenantRuntimeLifecycleSupervisorStepResult>;
}

function hasCompletedStep(
  completedStepIds: TenantRuntimeLifecycleSupervisorInput["completedStepIds"],
  stepId: string,
): boolean {
  if (!completedStepIds) {
    return false;
  }
  return "has" in completedStepIds
    ? completedStepIds.has(stepId)
    : completedStepIds.includes(stepId);
}

function executorEffect(
  executor: TenantRuntimeLifecycleStepExecutor,
  step: TenantRuntimeLifecycleExecutionStep,
): Effect.Effect<void, TenantRuntimeLifecycleExecutorError> {
  switch (step.operation) {
    case "provision-and-start":
      return executor.provisionAndStart(step);
    case "record-denied-start":
      return executor.recordDeniedStart(step);
    case "mark-running":
      return executor.markRunning(step);
    case "stop":
      return executor.stop(step);
    case "restart":
      return executor.restart(step);
    case "quarantine":
      return executor.quarantine(step);
    case "mark-stopped":
      return executor.markStopped(step);
  }
}

function recordStepMetric(
  step: TenantRuntimeLifecycleExecutionStep,
  outcome: "success" | "failure" | "skipped",
): Effect.Effect<void> {
  return recordTenantRuntimeLifecycleAction({
    operation: step.operation,
    sourceAction: step.sourceAction,
    outcome,
    targetStatus: step.targetStatus,
    processAction: step.processAction,
    tenantId: String(step.runtime.tenantId),
    runtimeId: String(step.runtime.runtimeId),
  });
}

function runLifecycleStep(
  input: TenantRuntimeLifecycleSupervisorInput,
  step: TenantRuntimeLifecycleExecutionStep,
): Effect.Effect<
  TenantRuntimeLifecycleSupervisorStepResult,
  TenantRuntimeLifecycleSupervisorError
> {
  if (hasCompletedStep(input.completedStepIds, step.idempotencyKey)) {
    return recordStepMetric(step, "skipped").pipe(
      Effect.as({
        step,
        outcome: "skipped" as const,
      }),
    );
  }

  return executorEffect(input.executor, step).pipe(
    Effect.tap(() => recordStepMetric(step, "success")),
    Effect.as({
      step,
      outcome: "executed" as const,
    }),
    Effect.catch((cause) =>
      recordStepMetric(step, "failure").pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new TenantRuntimeLifecycleSupervisorError({
              message: `Tenant runtime lifecycle step failed: ${step.operation}.`,
              step,
              cause,
            }),
          ),
        ),
      ),
    ),
  );
}

export function superviseTenantRuntimeLifecycle(
  input: TenantRuntimeLifecycleSupervisorInput,
): Effect.Effect<TenantRuntimeLifecycleSupervisorResult, TenantRuntimeLifecycleSupervisorError> {
  const plan = planTenantRuntimeLifecycle(input);
  const steps = deriveTenantRuntimeLifecycleExecutionSteps(plan);

  return Effect.forEach(steps, (step) => runLifecycleStep(input, step), {
    concurrency: 1,
  }).pipe(
    Effect.map((results) => ({
      plan,
      steps,
      results,
    })),
  );
}
