import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { EnvironmentId, PortNumber, ServiceId, UserId } from "@t3tools/contracts";

import { EnvironmentServiceRepositoryLive } from "../../persistence/Layers/EnvironmentServices.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import type { ListenerProbeResult } from "../listenerProbe.ts";
import { ServiceRegistry } from "../Services/ServiceRegistry.ts";
import { makeServiceRegistryLive, type ServiceRegistryProbe } from "./ServiceRegistry.ts";

const ENVIRONMENT = EnvironmentId.make("env-1");
const OTHER_ENVIRONMENT = EnvironmentId.make("env-2");
const ALICE = UserId.make("user-alice");
const BOB = UserId.make("user-bob");

/**
 * A machine we can describe exactly.
 *
 * The real probe reads whatever the developer's laptop happens to be serving,
 * which makes every assertion here a coin toss. `alive` is a set rather than a
 * predicate so a test can kill a process between two calls, which is the case
 * the registry exists to survive.
 */
function fakeMachine(initial: {
  listeners?: ListenerProbeResult["listeners"];
  tool?: ListenerProbeResult["tool"];
  processAttribution?: boolean;
  alive?: ReadonlyArray<number>;
}) {
  const state = {
    listeners: initial.listeners ?? [],
    tool: initial.tool ?? ("lsof" as const),
    processAttribution: initial.processAttribution ?? true,
    alive: new Set(initial.alive ?? []),
  };

  const probe: ServiceRegistryProbe = {
    listeners: () =>
      Promise.resolve({
        tool: state.tool,
        listeners: state.listeners,
        processAttribution: state.processAttribution,
        limitation: "",
      }),
    isAlive: (pid) => state.alive.has(pid),
  };

  return { probe, state };
}

function layerFor(probe: ServiceRegistryProbe) {
  return makeServiceRegistryLive(probe).pipe(
    Layer.provideMerge(EnvironmentServiceRepositoryLive),
    Layer.provide(SqlitePersistenceMemory),
  );
}

const listener = (port: number, pid: number | null, processName: string | null = null) => ({
  port,
  address: "0.0.0.0",
  protocol: "tcp" as const,
  pid,
  processName,
});

describe("ServiceRegistry — reading the machine", () => {
  it.effect("reports an unrecorded listener as not ours and unmanageable", () => {
    const { probe } = fakeMachine({ listeners: [listener(5432, 812, "postgres")] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const result = yield* registry.list({ environmentId: ENVIRONMENT });

      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0]?.ownership, "not-ours");
      assert.strictEqual(result.services[0]?.canManage, false);
      assert.strictEqual(result.services[0]?.name, "postgres");
      assert.strictEqual(result.probe.tool, "lsof");
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("carries the probe's limitation so a wall of unknowns is legible", () => {
    const probe: ServiceRegistryProbe = {
      listeners: () =>
        Promise.resolve({
          tool: "netstat",
          listeners: [listener(3000, null)],
          processAttribution: false,
          limitation: "netstat answered, and it cannot say which process holds a port.",
        }),
      isAlive: () => false,
    };
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const result = yield* registry.list({ environmentId: ENVIRONMENT });

      assert.strictEqual(result.probe.processAttribution, false);
      assert.include(result.probe.limitation, "cannot say which process");
      assert.strictEqual(result.services[0]?.ownership, "unknown");
      assert.strictEqual(result.services[0]?.canManage, false);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("says nothing was seen rather than that nothing is running", () => {
    const probe: ServiceRegistryProbe = {
      listeners: () =>
        Promise.resolve({
          tool: "none",
          listeners: [],
          processAttribution: false,
          limitation: "None of lsof, ss or netstat could be run here.",
        }),
      isAlive: () => false,
    };
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const result = yield* registry.list({ environmentId: ENVIRONMENT });
      assert.deepStrictEqual(result.services, []);
      assert.strictEqual(result.probe.tool, "none");
      assert.notStrictEqual(result.probe.limitation, "");
    }).pipe(Effect.provide(layerFor(probe)));
  });
});

describe("ServiceRegistry — what we started", () => {
  it.effect("records a start and then owns the listener behind it", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });

      state.listeners = [listener(3000, 4821, "bun")];
      const result = yield* registry.list({ environmentId: ENVIRONMENT });

      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0]?.ownership, "ours");
      assert.strictEqual(result.services[0]?.canManage, true);
      assert.strictEqual(result.services[0]?.name, "hello");
      assert.strictEqual(result.services[0]?.startedBy, ALICE);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses to record a pid that is not running", () => {
    const { probe } = fakeMachine({ alive: [] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const outcome = yield* registry
        .register({
          environmentId: ENVIRONMENT,
          asking: ALICE,
          name: "ghost",
          port: PortNumber.make(3000),
          pid: 999_999,
          command: "bun run dev",
        })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.include(outcome.failure.message, "no process 999999");
      }
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("stops believing in a service once its process is gone", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });

      // The process dies and something unrelated takes the port.
      state.alive.delete(4821);
      state.listeners = [listener(3000, 9102, "gunicorn")];

      const result = yield* registry.list({ environmentId: ENVIRONMENT });
      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0]?.ownership, "not-ours");
      assert.strictEqual(result.services[0]?.canManage, false);
      assert.strictEqual(result.services[0]?.pid, 9102);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("never merges our record with a stranger holding the same port", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });

      // Our process is alive but is no longer the one on the port.
      state.listeners = [listener(3000, 9102, "gunicorn")];

      const result = yield* registry.list({ environmentId: ENVIRONMENT });
      assert.strictEqual(result.services.length, 2);
      assert.strictEqual(result.services[0]?.state, "displaced");
      assert.strictEqual(result.services[0]?.ownership, "ours");
      assert.strictEqual(result.services[1]?.ownership, "not-ours");
      assert.strictEqual(result.services[1]?.canManage, false);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("replaces a restarted service rather than keeping the dead pid", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const start = {
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        command: "bun run dev",
      };
      yield* registry.register({ ...start, pid: 4821 });

      state.alive.clear();
      state.alive.add(5000);
      yield* registry.register({ ...start, pid: 5000 });

      state.listeners = [listener(3000, 5000, "bun")];
      const result = yield* registry.list({ environmentId: ENVIRONMENT });
      assert.strictEqual(result.services.length, 1);
      assert.strictEqual(result.services[0]?.pid, 5000);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("keeps one machine's services out of another's", () => {
    const { probe } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });
      const elsewhere = yield* registry.list({ environmentId: OTHER_ENVIRONMENT });
      assert.deepStrictEqual(elsewhere.services, []);
    }).pipe(Effect.provide(layerFor(probe)));
  });
});

describe("ServiceRegistry — releasing", () => {
  it.effect("releases a service it started", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });
      state.listeners = [listener(3000, 4821, "bun")];

      const before = yield* registry.list({ environmentId: ENVIRONMENT });
      const managedId = before.services[0]?.managedId;
      assert.isNotNull(managedId);

      const released = yield* registry.release({
        environmentId: ENVIRONMENT,
        serviceId: managedId as never,
        asking: ALICE,
      });
      assert.strictEqual(released.released, true);

      const after = yield* registry.list({ environmentId: ENVIRONMENT });
      // The process is still listening; we have only stopped claiming it.
      assert.strictEqual(after.services[0]?.ownership, "not-ours");
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("treats a second release as done rather than as an error", () => {
    const { probe } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });
      const listed = yield* registry.list({ environmentId: ENVIRONMENT });
      const managedId = listed.services[0]?.managedId as never;

      yield* registry.release({ environmentId: ENVIRONMENT, serviceId: managedId, asking: ALICE });
      const again = yield* registry.release({
        environmentId: ENVIRONMENT,
        serviceId: managedId,
        asking: ALICE,
      });
      assert.strictEqual(again.released, false);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses to release something this environment never started", () => {
    const { probe } = fakeMachine({ alive: [] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const outcome = yield* registry
        .release({
          environmentId: ENVIRONMENT,
          serviceId: ServiceId.make("service:nobody"),
          asking: ALICE,
        })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.code, "service-not-found");
      }
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses to release a service belonging to another machine", () => {
    const { probe } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });
      const listed = yield* registry.list({ environmentId: ENVIRONMENT });
      const outcome = yield* registry
        .release({
          environmentId: OTHER_ENVIRONMENT,
          serviceId: listed.services[0]?.managedId as never,
          asking: ALICE,
        })
        .pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
    }).pipe(Effect.provide(layerFor(probe)));
  });
});

describe("ServiceRegistry — port claims", () => {
  it.effect("claims a free port and hands back the reservation", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const result = yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server",
      });
      assert.isNotNull(result.claim);
      assert.strictEqual(result.claim?.claimedBy, ALICE);
      // Compared against the moment the claim was taken rather than the wall
      // clock: the registry reads time through Effect, so a test clock and a
      // real one both have to produce a deadline that is after the start.
      assert.isTrue(
        Date.parse(result.claim?.expiresAt ?? "") > Date.parse(result.claim?.claimedAt ?? ""),
      );
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses a port somebody else has reserved, and says who", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server",
      });
      const second = yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: BOB,
        port: PortNumber.make(4500),
        purpose: "something else",
      });
      assert.isNull(second.claim);
      assert.strictEqual(second.verdict.availability, "claimed");
      assert.include(second.verdict.headline, ALICE);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("lets the holder extend their own reservation", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server",
      });
      const again = yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server, still",
        holdMs: 60_000,
      });
      assert.isNotNull(again.claim);
      assert.strictEqual(again.verdict.availability, "held");
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses a port something is already listening on", () => {
    const { probe } = fakeMachine({ listeners: [listener(5432, 812, "postgres")] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const result = yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(5432),
        purpose: "my database",
      });
      assert.isNull(result.claim);
      assert.strictEqual(result.verdict.availability, "in-use");
      assert.include(result.verdict.suggestion, "Do not stop it");
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("stops a lapsed reservation from holding a port", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "a build that never finished",
        holdMs: 1_000,
      });
      yield* TestClock.adjust(Duration.millis(1_200));
      const check = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: BOB,
        port: 4500,
      });
      assert.strictEqual(check.verdict.free, true);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("releases only the asker's own reservation", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server",
      });

      const byBob = yield* registry.releasePort({
        environmentId: ENVIRONMENT,
        asking: BOB,
        port: PortNumber.make(4500),
      });
      assert.strictEqual(byBob.released, false);

      const byAlice = yield* registry.releasePort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
      });
      assert.strictEqual(byAlice.released, true);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("clears the reservation when the thing it was held for starts", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: PortNumber.make(4500),
        purpose: "the new admin server",
      });
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "admin",
        port: PortNumber.make(4500),
        pid: 4821,
        command: "bun run admin",
      });
      state.listeners = [listener(4500, 4821, "bun")];

      const result = yield* registry.list({ environmentId: ENVIRONMENT });
      assert.deepStrictEqual(result.claims, []);
      assert.strictEqual(result.services[0]?.ownership, "ours");
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("refuses a port that is not a port", () => {
    const { probe } = fakeMachine({});
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      const check = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: 70_000,
      });
      assert.strictEqual(check.verdict.availability, "out-of-range");
      assert.strictEqual(check.verdict.free, false);
    }).pipe(Effect.provide(layerFor(probe)));
  });
});

describe("ServiceRegistry — checking a port", () => {
  it.effect("offers an alternative only when the answer was no", () => {
    const { probe } = fakeMachine({ listeners: [listener(5432, 812, "postgres")] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;

      const taken = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: 5432,
      });
      assert.strictEqual(taken.verdict.free, false);
      assert.isNotNull(taken.suggestion);

      const open = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: 4900,
      });
      assert.strictEqual(open.verdict.free, true);
      assert.isNull(open.suggestion);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("does not suggest a port it has already reserved for somebody", () => {
    const { probe } = fakeMachine({ listeners: [listener(5432, 812, "postgres")] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.claimPort({
        environmentId: ENVIRONMENT,
        asking: BOB,
        port: PortNumber.make(4000),
        purpose: "bob's thing",
      });
      const taken = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: 5432,
      });
      assert.notStrictEqual(taken.suggestion, 4000);
    }).pipe(Effect.provide(layerFor(probe)));
  });

  it.effect("does not tell the caller to leave its own service alone", () => {
    const { probe, state } = fakeMachine({ alive: [4821] });
    return Effect.gen(function* () {
      const registry = yield* ServiceRegistry;
      yield* registry.register({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        name: "hello",
        port: PortNumber.make(3000),
        pid: 4821,
        command: "bun run dev",
      });
      state.listeners = [listener(3000, 4821, "bun")];

      const check = yield* registry.checkPort({
        environmentId: ENVIRONMENT,
        asking: ALICE,
        port: 3000,
      });
      assert.strictEqual(check.verdict.availability, "in-use");
      assert.include(check.verdict.suggestion, "Restart or stop it through T3");
    }).pipe(Effect.provide(layerFor(probe)));
  });
});
