import { assert, describe, it } from "@effect/vitest";
import { Effect, Metric } from "effect";

import {
  recordPublicAccessLimitRejection,
  recordTenantRuntimeLifecycleAction,
  withMetrics,
} from "./Metrics.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("withMetrics", () => {
  it.effect("supports pipe-style usage", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_pipe_total");
      const timer = Metric.timer("with_metrics_pipe_duration");

      const result = yield* Effect.succeed("ok").pipe(
        withMetrics({
          counter,
          timer,
          attributes: {
            operation: "pipe",
          },
        }),
      );

      assert.equal(result, "ok");

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_total", {
          operation: "pipe",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_pipe_duration", {
          operation: "pipe",
        }),
        true,
      );
    }),
  );

  it.effect("supports direct invocation", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_direct_total");

      yield* withMetrics(Effect.fail("boom"), {
        counter,
        attributes: {
          operation: "direct",
        },
      }).pipe(Effect.exit);

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_direct_total", {
          operation: "direct",
          outcome: "failure",
        }),
        true,
      );
    }),
  );

  it.effect("evaluates attributes lazily after the wrapped effect runs", () =>
    Effect.gen(function* () {
      const counter = Metric.counter("with_metrics_lazy_total");
      const timer = Metric.timer("with_metrics_lazy_duration");
      let provider = "unknown";

      yield* Effect.sync(() => {
        provider = "codex";
      }).pipe(
        withMetrics({
          counter,
          timer,
          attributes: () => ({
            provider,
            operation: "lazy",
          }),
        }),
      );

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_total", {
          provider: "codex",
          operation: "lazy",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "with_metrics_lazy_duration", {
          provider: "codex",
          operation: "lazy",
        }),
        true,
      );
    }),
  );
});

describe("public access limit metrics", () => {
  it.effect("records rejected public access limit decisions", () =>
    Effect.gen(function* () {
      yield* recordPublicAccessLimitRejection({
        limit: "rpcRequestsThisMinuteForUser",
        operation: "rpc.dispatch",
        current: 121,
        maximum: 120,
        tenantId: "tenant-test",
        userId: "user-test",
      });

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_public_access_limit_rejections_total", {
          limit: "rpcRequestsThisMinuteForUser",
          operation: "rpc.dispatch",
          current: "121",
          maximum: "120",
          tenantId: "tenant-test",
          userId: "user-test",
        }),
        true,
      );
    }),
  );
});

describe("tenant runtime lifecycle metrics", () => {
  it.effect("records tenant runtime lifecycle action outcomes", () =>
    Effect.gen(function* () {
      yield* recordTenantRuntimeLifecycleAction({
        operation: "stop",
        sourceAction: "stop-expired",
        outcome: "success",
        targetStatus: "stopping",
        processAction: true,
        tenantId: "tenant-test",
        runtimeId: "runtime-test",
      });

      const snapshots = yield* Metric.snapshot;
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_tenant_runtime_lifecycle_actions_total", {
          operation: "stop",
          sourceAction: "stop-expired",
          outcome: "success",
          targetStatus: "stopping",
          processAction: "true",
          tenantId: "tenant-test",
          runtimeId: "runtime-test",
        }),
        true,
      );
    }),
  );
});
