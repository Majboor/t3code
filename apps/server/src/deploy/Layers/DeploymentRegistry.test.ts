import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DeployTargetId, ProjectId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { DeploymentRegistryLive, resolveStreamIds } from "./DeploymentRegistry.ts";
import { DeploymentRegistry } from "../Services/DeploymentRegistry.ts";
import { AnalyticsRepositoryLive } from "../../persistence/Layers/Analytics.ts";
import { DeploymentRepositoryLive } from "../../persistence/Layers/Deployments.ts";
import { DeployRepositoryLive } from "../../persistence/Layers/DeployTargets.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { AnalyticsRepository } from "../../persistence/Services/Analytics.ts";
import { DeployRepository } from "../../persistence/Services/DeployTargets.ts";

const projectId = ProjectId.make("project-deployments");
const otherProjectId = ProjectId.make("project-elsewhere");
const targetId = DeployTargetId.make("deploy-target:staging");

function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-deployments-"));
  return DeploymentRegistryLive.pipe(
    Layer.provideMerge(DeploymentRepositoryLive),
    Layer.provideMerge(DeployRepositoryLive),
    Layer.provideMerge(AnalyticsRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "deployments.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** A target and one declared stream, which is the ground every case stands on. */
const seed = Effect.gen(function* () {
  const targets = yield* DeployRepository;
  const analytics = yield* AnalyticsRepository;

  yield* targets.upsertTarget({
    id: targetId,
    projectId,
    tenantId: null,
    name: "staging",
    kind: "command",
    command: "make deploy",
    ssh: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  });

  yield* analytics.upsertStream({
    id: "astream_pageview" as never,
    projectId,
    name: "page.view" as never,
    purpose: "Which pages get read",
    properties: [],
    ingestKeyName: "digest",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archivedAt: null,
  });
});

describe("resolveStreamIds", () => {
  it("refuses a name nobody declared rather than dropping it", () => {
    const result = resolveStreamIds(
      [{ id: "a" as never, name: "page.view" as never }],
      ["page.view", "checkout.done"],
    );
    assert.strictEqual(result.ok, false);
    assert.deepStrictEqual(result.ok === false ? result.missing : [], ["checkout.done"]);
  });

  it("counts the same stream named twice as one link", () => {
    const result = resolveStreamIds(
      [{ id: "a" as never, name: "page.view" as never }],
      ["page.view", "page.view"],
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.ok === true ? [...result.ids].map(String) : [], ["a"]);
  });
});

describe("DeploymentRegistry", () => {
  it.effect("records what is live, with the streams it reports to", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const deployment = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        url: "https://staging.example.test",
        status: "live",
        streams: ["page.view" as never],
      });

      assert.strictEqual(deployment.url, "https://staging.example.test");
      assert.strictEqual(deployment.status, "live");
      assert.deepStrictEqual([...deployment.analyticsStreamIds], ["astream_pageview"]);

      const listed = yield* registry.list({ projectId });
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.id, deployment.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("registering the same name again replaces what is serving", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const first = yield* registry.register({ projectId, targetId, name: "staging" });
      const second = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        url: "https://staging.example.test",
        status: "live",
      });

      assert.strictEqual(second.id, first.id);
      assert.strictEqual(second.url, "https://staging.example.test");

      const listed = yield* registry.list({ projectId });
      assert.strictEqual(listed.length, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  // What a redeploy that wires no analytics must not do. `DeployService`
  // registers every successful run, including ones with no analytics, so this
  // is the difference between a plain redeploy and one that silently unwires
  // the numbers an earlier run attached.
  it.effect("re-registering without naming streams leaves the existing ones alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        streams: ["page.view" as never],
      });
      const redeployed = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        status: "live",
      });

      assert.deepStrictEqual([...redeployed.analyticsStreamIds], ["astream_pageview"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("naming an empty set of streams clears them, which is not the same", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        streams: ["page.view" as never],
      });
      const cleared = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        streams: [],
      });

      assert.deepStrictEqual([...cleared.analyticsStreamIds], []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("a deployment registered without a claim is unknown, not live", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;
      const deployment = yield* registry.register({ projectId, targetId, name: "staging" });
      assert.strictEqual(deployment.status, "unknown");
      assert.strictEqual(deployment.url, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a stream the project never declared", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const error = yield* Effect.flip(
        registry.register({
          projectId,
          targetId,
          name: "staging",
          streams: ["checkout.done" as never],
        }),
      );

      assert.strictEqual(error.code, "invalid-deployment");
      assert.include(error.message, "checkout.done");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a target that belongs to another project", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const error = yield* Effect.flip(
        registry.register({ projectId: otherProjectId, targetId, name: "staging" }),
      );

      assert.strictEqual(error.code, "invalid-deployment");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("an update that says nothing about streams leaves them alone", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const registered = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        streams: ["page.view" as never],
      });
      const updated = yield* registry.update({
        deploymentId: registered.id,
        status: "stopped",
      });

      assert.strictEqual(updated.status, "stopped");
      assert.deepStrictEqual([...updated.analyticsStreamIds], ["astream_pageview"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("an update that gives streams replaces the set", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const registered = yield* registry.register({
        projectId,
        targetId,
        name: "staging",
        streams: ["page.view" as never],
      });
      const updated = yield* registry.update({ deploymentId: registered.id, streams: [] });

      assert.deepStrictEqual([...updated.analyticsStreamIds], []);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("an archived deployment is gone from the list and cannot be updated", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const registered = yield* registry.register({ projectId, targetId, name: "staging" });
      yield* registry.archive({ deploymentId: registered.id });

      const listed = yield* registry.list({ projectId });
      assert.strictEqual(listed.length, 0);

      const error = yield* Effect.flip(
        registry.update({ deploymentId: registered.id, status: "live" }),
      );
      assert.strictEqual(error.code, "deployment-not-found");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("archiving frees the name for a new deployment", () =>
    Effect.gen(function* () {
      yield* seed;
      const registry = yield* DeploymentRegistry;

      const first = yield* registry.register({ projectId, targetId, name: "staging" });
      yield* registry.archive({ deploymentId: first.id });

      // Retiring a deployment must not burn its name: the row stays for history,
      // so a plain unique index over (project, name) would fail this forever.
      const second = yield* registry.register({ projectId, targetId, name: "staging" });

      assert.notStrictEqual(second.id, first.id);
      const listed = yield* registry.list({ projectId });
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0]?.id, second.id);
    }).pipe(Effect.provide(makeLayer())),
  );
});
