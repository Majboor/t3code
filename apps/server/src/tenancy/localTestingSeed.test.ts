import * as NodeServices from "@effect/platform-node/NodeServices";
import { TenantId } from "@t3tools/contracts";
import {
  DEFAULT_PUBLIC_ACCESS_LIMITS,
  evaluateTenantUsageLimits,
  validateProviderAccountIsolation,
  validateTenantRuntimeIsolation,
} from "@t3tools/shared/tenancy";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../persistence/Layers/Tenancy.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { makeLocalTestingTenancySeed, saveLocalTestingTenancySeed } from "./localTestingSeed.ts";

function makeTenancyLayer<E, R>(persistenceLayer: Layer.Layer<SqlClient.SqlClient, E, R>) {
  return TenancyRepositoryLive.pipe(
    Layer.provide(persistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  );
}

it("builds multi-user and multi-tenant local testing seed snapshots", () => {
  const seed = makeLocalTestingTenancySeed({
    tenantRootDir: "/tmp/t3-local-tenants",
  });

  assert.deepStrictEqual(
    seed.organizations.tenants.map((tenant) => tenant.kind),
    ["personal", "corporate", "support"],
  );
  assert.deepStrictEqual(
    seed.workspaces.workspaces.map((workspace) => workspace.kind),
    ["personal", "corporate", "support"],
  );
  assert.equal(new Set(seed.organizations.memberships.map((entry) => entry.userId)).size, 4);
  assert.equal(seed.providerIsolation.providerAccounts.length, 2);
  for (const runtime of seed.runtimeLifecycle.runtimes) {
    assert.equal(validateTenantRuntimeIsolation(runtime).allowed, true);
  }
  for (const account of seed.providerIsolation.providerAccounts) {
    const runtime = seed.runtimeLifecycle.runtimes.find(
      (candidate) => candidate.tenantId === account.tenantId,
    );
    assert.ok(runtime);
    assert.equal(
      validateProviderAccountIsolation({
        account,
        runtimeLayout: {
          baseDir: runtime.baseDir,
          dataDir: runtime.dataDir,
          userdataDir: `${runtime.dataDir}/userdata`,
          secretsDir: runtime.secretsDir,
          attachmentsDir: runtime.attachmentsDir,
          worktreesDir: runtime.worktreesDir,
          runsDir: runtime.runsDir,
          providerHomesDir: runtime.providerHomesDir,
          logsDir: `${runtime.baseDir}/logs`,
        },
      }).allowed,
      true,
    );
  }
  assert.equal(
    evaluateTenantUsageLimits(
      {
        webSocketConnectionsForIp: 0,
        webSocketConnectionsForUser: 0,
        webSocketConnectionsForTenant: 0,
        rpcRequestsThisMinuteForUser: 0,
        rpcRequestsThisMinuteForTenant: 0,
        activeTurnsForUser: 0,
        activeTurnsForTenant: 0,
        activeProviderSessionsForUser: 0,
        activeProviderSessionsForTenant: 0,
        providerConnectFailuresForUser: 0,
        activeTenantRuntimesForMachine: seed.runtimeLifecycle.runtimes.length,
      },
      DEFAULT_PUBLIC_ACCESS_LIMITS,
    ).every((check) => check.allowed),
    true,
  );
});

it.effect("persists local testing tenancy seed snapshots", () =>
  Effect.gen(function* () {
    const layer = makeTenancyLayer(makeSqlitePersistenceLive(":memory:"));

    yield* Effect.gen(function* () {
      const repository = yield* TenancyRepository;
      yield* saveLocalTestingTenancySeed(repository, {
        tenantRootDir: "/tmp/t3-local-tenants",
      });

      const organizations = yield* repository.loadOrganizations();
      const collaboration = yield* repository.loadCollaboration();
      const workspaces = yield* repository.loadWorkspaces();
      const providerIsolation = yield* repository.loadProviderIsolation();
      const runtimeLifecycle = yield* repository.loadTenantRuntimeLifecycleState();

      assert.equal(organizations.tenants.length, 3);
      assert.equal(organizations.memberships.length, 2);
      assert.equal(organizations.employees.length, 2);
      assert.equal(collaboration.presence.length, 2);
      assert.equal(collaboration.memberships.length, 2);
      assert.equal(workspaces.workspaces.length, 3);
      assert.equal(providerIsolation.providerAccounts.length, 2);
      assert.equal(providerIsolation.providerSessions.length, 1);
      assert.equal(runtimeLifecycle.runtimes.length, 3);
      assert.ok(
        runtimeLifecycle.runtimes.some(
          (runtime) => runtime.tenantId === TenantId.make("tenant-local-acme"),
        ),
      );
    }).pipe(Effect.provide(layer));
  }),
);
