import type { TenantRuntimeIsolation } from "@t3tools/contracts";
import {
  evaluateTenantRuntimeLifecycle,
  type TenantRuntimeLifecycleAction,
  type TenantRuntimeLifecycleDecision,
} from "@t3tools/shared/tenancy";

export interface TenantRuntimeHealthSnapshot {
  readonly healthCheckSucceeded?: boolean;
  readonly consecutiveHealthFailures?: number;
}

export interface TenantRuntimeLifecyclePlanInput {
  readonly runtimes: ReadonlyArray<TenantRuntimeIsolation>;
  readonly now: string;
  readonly demandRuntimeIds?: ReadonlySet<string> | ReadonlyArray<string>;
  readonly lastActivityByRuntimeId?:
    | ReadonlyMap<string, string | null>
    | Readonly<Record<string, string | null>>;
  readonly healthByRuntimeId?:
    | ReadonlyMap<string, TenantRuntimeHealthSnapshot>
    | Readonly<Record<string, TenantRuntimeHealthSnapshot>>;
  readonly maxWallClockMs?: number;
}

export interface TenantRuntimeLifecyclePlanEntry {
  readonly runtime: TenantRuntimeIsolation;
  readonly decision: TenantRuntimeLifecycleDecision;
}

export interface TenantRuntimeLifecyclePlan {
  readonly entries: ReadonlyArray<TenantRuntimeLifecyclePlanEntry>;
  readonly actionable: ReadonlyArray<TenantRuntimeLifecyclePlanEntry>;
}

export type TenantRuntimeLifecycleExecutionOperation =
  | "provision-and-start"
  | "record-denied-start"
  | "mark-running"
  | "stop"
  | "restart"
  | "quarantine"
  | "mark-stopped";

export interface TenantRuntimeLifecycleExecutionStep {
  readonly idempotencyKey: string;
  readonly operation: TenantRuntimeLifecycleExecutionOperation;
  readonly runtime: TenantRuntimeIsolation;
  readonly sourceAction: Exclude<TenantRuntimeLifecycleAction, "none">;
  readonly targetStatus: TenantRuntimeIsolation["status"];
  readonly reason: string;
  readonly processAction: boolean;
}

const LIFECYCLE_ACTION_OPERATIONS = {
  start: { operation: "provision-and-start", processAction: true },
  "deny-start": { operation: "record-denied-start", processAction: false },
  "mark-running": { operation: "mark-running", processAction: false },
  "stop-idle": { operation: "stop", processAction: true },
  "stop-expired": { operation: "stop", processAction: true },
  "restart-unhealthy": { operation: "restart", processAction: true },
  "quarantine-unhealthy": { operation: "quarantine", processAction: true },
  "cleanup-stopped": { operation: "mark-stopped", processAction: false },
} as const satisfies Record<
  Exclude<TenantRuntimeLifecycleAction, "none">,
  {
    readonly operation: TenantRuntimeLifecycleExecutionOperation;
    readonly processAction: boolean;
  }
>;

function hasRuntimeDemand(
  demandRuntimeIds: TenantRuntimeLifecyclePlanInput["demandRuntimeIds"],
  runtimeId: string,
): boolean {
  if (!demandRuntimeIds) {
    return false;
  }
  return "has" in demandRuntimeIds
    ? demandRuntimeIds.has(runtimeId)
    : demandRuntimeIds.includes(runtimeId);
}

function isReadonlyMap<A>(source: unknown): source is ReadonlyMap<string, A> {
  return source instanceof Map;
}

function lookupRecordValue<A>(
  source: ReadonlyMap<string, A> | Readonly<Record<string, A>> | undefined,
  key: string,
): A | undefined {
  if (!source) {
    return undefined;
  }
  return isReadonlyMap<A>(source) ? source.get(key) : source[key];
}

function executionStepIdempotencyKey(input: {
  readonly runtime: TenantRuntimeIsolation;
  readonly action: Exclude<TenantRuntimeLifecycleAction, "none">;
  readonly targetStatus: TenantRuntimeIsolation["status"];
}): string {
  return [
    "tenant-runtime-lifecycle",
    input.runtime.tenantId,
    input.runtime.runtimeId,
    input.action,
    input.runtime.status,
    input.targetStatus,
    input.runtime.lastStartedAt ?? "never-started",
    input.runtime.lastStoppedAt ?? "never-stopped",
  ].join(":");
}

export function planTenantRuntimeLifecycle(
  input: TenantRuntimeLifecyclePlanInput,
): TenantRuntimeLifecyclePlan {
  const entries = input.runtimes.map((runtime) => {
    const runtimeId = String(runtime.runtimeId);
    const health = lookupRecordValue(input.healthByRuntimeId, runtimeId);
    const lastActivityAt = lookupRecordValue(input.lastActivityByRuntimeId, runtimeId);
    const decision = evaluateTenantRuntimeLifecycle({
      runtime,
      now: input.now,
      demand: hasRuntimeDemand(input.demandRuntimeIds, runtimeId),
      ...(lastActivityAt === undefined ? {} : { lastActivityAt }),
      ...health,
      ...(input.maxWallClockMs === undefined ? {} : { maxWallClockMs: input.maxWallClockMs }),
    });
    return { runtime, decision };
  });

  return {
    entries,
    actionable: entries.filter((entry) => entry.decision.action !== "none"),
  };
}

export function deriveTenantRuntimeLifecycleExecutionSteps(
  plan: Pick<TenantRuntimeLifecyclePlan, "actionable">,
): ReadonlyArray<TenantRuntimeLifecycleExecutionStep> {
  return plan.actionable.map((entry) => {
    const action = entry.decision.action as Exclude<TenantRuntimeLifecycleAction, "none">;
    const actionOperation = LIFECYCLE_ACTION_OPERATIONS[action];
    return {
      idempotencyKey: executionStepIdempotencyKey({
        runtime: entry.runtime,
        action,
        targetStatus: entry.decision.nextStatus,
      }),
      operation: actionOperation.operation,
      runtime: entry.runtime,
      sourceAction: action,
      targetStatus: entry.decision.nextStatus,
      reason: entry.decision.reason,
      processAction: actionOperation.processAction,
    };
  });
}
