import { assert, it } from "@effect/vitest";
import type { EnvironmentService, PortClaim } from "@t3tools/shared/serviceRegistry";
import { Effect, Layer } from "effect";

import { BoxCommandJournalRepositoryLive } from "../../persistence/Layers/BoxCommandJournal.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoxCommandJournalRepository } from "../../persistence/Services/BoxCommandJournal.ts";
import { BOX_OUTPUT_HEAD_BYTES, BOX_OUTPUT_TAIL_BYTES } from "../decideBoxCommand.ts";
import { BoxCommands, type BoxCaller } from "../Services/BoxCommands.ts";
import {
  BoxSession,
  type BoxExecOutcome,
  type BoxInspection,
  type BoxSessionShape,
} from "../Services/BoxSession.ts";
import { BoxCommandsLive } from "./BoxCommands.ts";

const USER = "supabase:abc";

/**
 * A box that does not exist.
 *
 * Every interesting rule here is about refusing to touch somebody's production
 * service, so the whole point is to test it against a machine with a production
 * service on it — which is not a thing a test may have. The fake records what it
 * was asked to do, and the assertions are mostly about what it was *not* asked
 * to do.
 */
interface FakeBox {
  readonly layer: Layer.Layer<BoxSession>;
  readonly signalled: Array<number>;
  readonly executed: Array<string>;
}

const ours: EnvironmentService = {
  port: 3000,
  name: "web",
  state: "listening",
  ownership: "ours",
  ownershipReason: "pid 4821 is the process T3 started for this port.",
  pid: 4821,
  command: "npm run dev",
  address: "127.0.0.1",
  since: "2026-08-20T10:00:00.000Z",
  startedBy: USER,
  managedId: "svc-web",
  canManage: true,
};

const theirs: EnvironmentService = {
  port: 5432,
  name: "postgres",
  state: "listening",
  ownership: "not-ours",
  ownershipReason: "pid 991 (postgres) holds this port and is not a process T3 started.",
  pid: 991,
  command: null,
  address: "0.0.0.0",
  since: null,
  startedBy: null,
  managedId: null,
  canManage: false,
};

const makeFakeBox = (
  over: {
    readonly reachable?: boolean;
    readonly revoked?: boolean;
    readonly services?: ReadonlyArray<EnvironmentService>;
    readonly claims?: ReadonlyArray<PortClaim>;
    readonly exec?: Partial<BoxExecOutcome>;
    readonly log?: string;
  } = {},
): FakeBox => {
  const signalled: Array<number> = [];
  const executed: Array<string> = [];

  const inspection: BoxInspection = {
    services: over.services ?? [ours, theirs],
    claims: over.claims ?? [],
    probe: { tool: "lsof", processAttribution: true, limitation: "" },
  };

  const shape: BoxSessionShape = {
    facts: () =>
      Effect.succeed({
        machineId: "machine-1",
        revoked: over.revoked ?? false,
        reachable: over.reachable ?? true,
      }),
    inspect: () => Effect.succeed(inspection),
    exec: (input) => {
      executed.push(input.request.command);
      return Effect.succeed({
        exitCode: 0,
        signal: null,
        stdout: "",
        stderr: "",
        pid: null,
        timedOut: false,
        ...over.exec,
      });
    },
    signal: (input) => {
      signalled.push(input.pid);
      return Effect.succeed(true);
    },
    readServiceLog: () => Effect.succeed(over.log ?? "listening on 3000\n"),
    claimPort: (input) =>
      Effect.succeed({
        port: input.port,
        claimedBy: input.userId,
        purpose: input.purpose,
        claimedAt: "2026-08-20T10:00:00.000Z",
        expiresAt: "2026-08-20T10:10:00.000Z",
      } as PortClaim),
    releasePort: () => Effect.succeed(true),
  };

  return { layer: Layer.succeed(BoxSession, shape), signalled, executed };
};

const run = <A, E>(
  box: FakeBox,
  body: Effect.Effect<A, E, BoxCommands | BoxCommandJournalRepository>,
) =>
  body.pipe(
    Effect.provide(
      BoxCommandsLive.pipe(
        Layer.provide(box.layer),
        Layer.provideMerge(
          BoxCommandJournalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
        ),
      ),
    ),
  );

const caller = (environmentId: string): BoxCaller => ({
  environmentId,
  userId: USER,
  turnId: "turn-7",
});

it.effect("runs a command and hands back an exit code rather than a screenful", () => {
  const box = makeFakeBox({ exec: { exitCode: 0, stdout: "added 412 packages\n" } });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.run({
        ...caller("box-run"),
        command: "npm ci",
        detach: false,
      });

      assert.equal(report.outcome, "ran");
      if (report.outcome !== "ran") return;
      assert.equal(report.exitCode, 0);
      assert.equal(report.stdout.text, "added 412 packages\n");
      assert.isFalse(report.stdout.truncated);
      assert.deepEqual(box.executed, ["npm ci"]);
    }),
  );
});

it.effect("bounds a noisy install in the reply and keeps the whole thing in the journal", () => {
  const noisy = Array.from({ length: 12_000 }, (_, index) => `npm progress ${index}`).join("\n");
  const box = makeFakeBox({ exec: { exitCode: 1, stdout: noisy, stderr: "npm ERR! boom\n" } });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.run({
        ...caller("box-noisy"),
        command: "npm install",
        detach: false,
      });
      if (report.outcome !== "ran") return assert.fail("expected a run");

      assert.isTrue(report.stdout.truncated);
      assert.isBelow(
        report.stdout.text.length,
        BOX_OUTPUT_HEAD_BYTES + BOX_OUTPUT_TAIL_BYTES + 100,
      );
      // Both ends survive: the first thing it did and the last thing it said.
      assert.include(report.stdout.text, "npm progress 0");
      assert.include(report.stdout.text, "npm progress 11999");
      assert.include(report.stderr.text, "npm ERR! boom");

      // The handle fetches what the reply did not carry.
      const stored = yield* commands.output({ ...caller("box-noisy"), entryId: report.entryId });
      assert.include(stored.entry.stdout ?? "", "npm progress 6000");
      assert.equal(stored.entry.exitCode, 1);
      assert.equal(stored.entry.outcome, "failed");

      const recent = yield* journal.listRecent({ environmentId: "box-noisy", limit: 10 });
      assert.equal(recent.length, 1);
      assert.equal(recent[0]!.command, "npm install");
    }),
  );
});

it.effect("leaves a detached process running and findable after the turn", () => {
  const box = makeFakeBox({ exec: { exitCode: null, pid: 5150, stdout: "" } });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.run({
        ...caller("box-detach"),
        command: "npm start",
        detach: true,
      });
      if (report.outcome !== "ran") return assert.fail("expected a run");

      assert.equal(report.detachedPid, 5150);

      // Nothing waited for it, so nothing may claim it finished.
      const running = yield* journal.listUnfinished({ environmentId: "box-detach", limit: 10 });
      assert.deepEqual(
        running.map((entry) => entry.pid),
        [5150],
      );
      assert.equal(running[0]!.outcome, "running");
      assert.isNull(running[0]!.finishedAt);

      // And a later session finds it by asking what happened here.
      const history = yield* commands.history({ ...caller("box-detach"), limit: 10 });
      if (history.outcome !== "history") return assert.fail("expected history");
      assert.equal(history.entries[0]!.command, "npm start");
      assert.equal(history.entries[0]!.pid, 5150);
    }),
  );
});

it.effect("stops what T3 started", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.stop({
        ...caller("box-stop-ours"),
        target: "web",
        acknowledgedTarget: null,
      });

      assert.equal(report.outcome, "stopped");
      if (report.outcome !== "stopped") return;
      assert.isFalse(report.unmanaged);
      assert.deepEqual(box.signalled, [4821]);
    }),
  );
});

it.effect("refuses to stop a process T3 did not start, and signals nothing", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.stop({
        ...caller("box-stop-theirs"),
        target: "postgres",
        acknowledgedTarget: null,
      });

      assert.equal(report.outcome, "refused");
      if (report.outcome !== "refused") return;
      assert.equal(report.refusal.reason, "service-not-ours");
      // The one assertion that matters: nothing was killed.
      assert.deepEqual(box.signalled, []);

      // And the attempt is on the record.
      const recent = yield* journal.listRecent({
        environmentId: "box-stop-theirs",
        limit: 10,
      });
      assert.equal(recent.length, 1);
      assert.equal(recent[0]!.outcome, "refused");
      assert.equal(recent[0]!.refusalReason, "service-not-ours");
      assert.isFalse(recent[0]!.unmanaged);
    }),
  );
});

it.effect("marks an override in the journal so the audit question is answerable", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.stop({
        ...caller("box-override"),
        target: "postgres",
        acknowledgedTarget: "pid:991",
      });

      assert.equal(report.outcome, "stopped");
      if (report.outcome !== "stopped") return;
      assert.isTrue(report.unmanaged);
      assert.deepEqual(box.signalled, [991]);

      const recent = yield* journal.listRecent({ environmentId: "box-override", limit: 10 });
      assert.isTrue(recent[0]!.unmanaged);
      assert.equal(recent[0]!.pid, 991);
    }),
  );
});

it.effect("refuses a stale override rather than killing whatever inherited the pid", () => {
  const box = makeFakeBox({ services: [{ ...theirs, pid: 1201 }] });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.stop({
        ...caller("box-stale"),
        target: "postgres",
        acknowledgedTarget: "pid:991",
      });

      assert.equal(report.outcome, "refused");
      if (report.outcome !== "refused") return;
      assert.equal(report.refusal.reason, "override-mismatch");
      assert.deepEqual(box.signalled, []);
    }),
  );
});

it.effect("answers history on a box nothing can reach", () => {
  const reachable = makeFakeBox();
  return run(
    reachable,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      yield* commands.run({ ...caller("box-offline"), command: "npm ci", detach: false });

      // The same journal, now behind a box that has gone away.
      const journal = yield* BoxCommandJournalRepository;
      const entries = yield* journal.listRecent({ environmentId: "box-offline", limit: 10 });
      assert.equal(entries.length, 1);
    }),
  );
});

it.effect("refuses every acting verb on an unreachable box but still tells its history", () => {
  const box = makeFakeBox({ reachable: false });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const attempted = yield* commands.run({
        ...caller("box-down"),
        command: "npm ci",
        detach: false,
      });
      assert.equal(attempted.outcome, "refused");
      if (attempted.outcome === "refused") {
        assert.equal(attempted.refusal.reason, "box-unreachable");
      }
      assert.deepEqual(box.executed, []);

      const history = yield* commands.history({ ...caller("box-down"), limit: 10 });
      assert.equal(history.outcome, "history");
      if (history.outcome !== "history") return;
      // The refusal itself is the history, which is the useful thing to find.
      assert.equal(history.entries[0]!.refusalReason, "box-unreachable");
    }),
  );
});

it.effect("refuses everything on a machine the account disconnected", () => {
  const box = makeFakeBox({ revoked: true });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const attempted = yield* commands.run({
        ...caller("box-revoked"),
        command: "npm ci",
        detach: false,
      });
      assert.equal(attempted.outcome, "refused");
      if (attempted.outcome === "refused") {
        assert.equal(attempted.refusal.reason, "machine-revoked");
      }

      const history = yield* commands.history({ ...caller("box-revoked"), limit: 10 });
      assert.equal(history.outcome, "refused");
      assert.deepEqual(box.executed, []);
    }),
  );
});

it.effect("reads captured logs for something we started, and bounds them", () => {
  const box = makeFakeBox({ log: "x".repeat(80_000) });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.logs({ ...caller("box-logs"), target: "web" });
      assert.equal(report.outcome, "logs");
      if (report.outcome !== "logs") return;
      assert.isTrue(report.output.truncated);
      assert.equal(report.output.totalBytes, 80_000);
    }),
  );
});

it.effect("explains that a stranger's logs were never captured", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.logs({ ...caller("box-logs-theirs"), target: "postgres" });
      assert.equal(report.outcome, "refused");
      if (report.outcome !== "refused") return;
      assert.equal(report.refusal.reason, "no-captured-logs");
    }),
  );
});

it.effect("claims a port and records what it is held for", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.claimPort({
        ...caller("box-claim"),
        port: 4000,
        purpose: "the api while it builds",
      });
      assert.equal(report.outcome, "port");
      if (report.outcome !== "port") return;
      assert.isTrue(report.held);

      const recent = yield* journal.listRecent({ environmentId: "box-claim", limit: 10 });
      assert.include(recent[0]!.command ?? "", "the api while it builds");
    }),
  );
});

it.effect("will not release a reservation somebody else holds", () => {
  const box = makeFakeBox({
    claims: [
      {
        port: 4000,
        claimedBy: "supabase:xyz",
        purpose: "their api",
        claimedAt: "2026-08-20T10:00:00.000Z",
        expiresAt: "2026-08-20T10:10:00.000Z",
      } as PortClaim,
    ],
  });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.releasePort({ ...caller("box-release"), port: 4000 });
      assert.equal(report.outcome, "refused");
      if (report.outcome !== "refused") return;
      assert.equal(report.refusal.reason, "claim-not-yours");
    }),
  );
});

it.effect("will not hand one account's command output to another", () => {
  const box = makeFakeBox({ exec: { stdout: "DATABASE_URL=secret" } });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.run({
        ...caller("box-private"),
        command: "env",
        detach: false,
      });
      if (report.outcome !== "ran") return assert.fail("expected a run");

      const stranger = yield* commands
        .output({
          environmentId: "box-private",
          userId: "supabase:xyz",
          turnId: null,
          entryId: report.entryId,
        })
        .pipe(Effect.flip);
      assert.equal(stranger.code, "not-found");
    }),
  );
});

it.effect("lists what is running without writing a journal entry for looking", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.services(caller("box-list"));
      assert.equal(report.outcome, "listed");
      if (report.outcome !== "listed") return;
      assert.equal(report.services.length, 2);

      const recent = yield* journal.listRecent({ environmentId: "box-list", limit: 10 });
      assert.equal(recent.length, 0);
    }),
  );
});

/**
 * The privileged verb, and the thing that makes it different from every other
 * one: what reaches the machine is a call to one root-owned helper, not a
 * systemctl invocation, and the box gets to refuse it again after we have.
 */
it.effect("reaches the box's helper by absolute path, and never systemctl", () => {
  const box = makeFakeBox({
    exec: { exitCode: 0, stdout: "/etc/systemd/system/t3-app-web.service\n" },
  });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.unit({
        ...caller("box-unit"),
        verb: "create",
        name: "t3-app-web",
        create: {
          exec: "/var/lib/t3-environment/apps/web/run",
          args: ["--port=80"],
          workingDirectory: null,
          port: 80,
          description: "the web app",
        },
      });

      if (report.outcome !== "unit") return assert.fail("expected a unit report");
      assert.equal(report.name, "t3-app-web.service");
      // A low port is a capability on the unit, never a uid on the process.
      assert.isTrue(report.needsBindCapability);

      const dispatched = box.executed[0] ?? "";
      assert.include(dispatched, "/opt/t3-environment/libexec/t3-unit-helper");
      assert.notInclude(dispatched, "systemctl");
      assert.include(dispatched, "'create' 't3-app-web.service'");

      // Journalled like everything else the agent did to this box, under a verb
      // that says it went through the helper.
      const recent = yield* journal.listRecent({ environmentId: "box-unit", limit: 10 });
      assert.equal(recent.length, 1);
      assert.equal(recent[0]!.verb, "unit-create");
      assert.equal(recent[0]!.outcome, "ok");
    }),
  );
});

it.effect("records the box's own refusal as a refusal, not as a failed command", () => {
  // Exit 3 and a parseable reason is the helper saying no — most importantly,
  // saying no to a unit T3 did not write. A journal that filed this as `exit 3`
  // would bury the only row that says an agent tried.
  const box = makeFakeBox({
    exec: {
      exitCode: 3,
      stderr:
        "t3-unit-helper: refused (unit-not-ours): /etc/systemd/system/t3-app-web.service exists and was not written by this helper.\n",
    },
  });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.unit({
        ...caller("box-unit-refused"),
        verb: "stop",
        name: "t3-app-web",
        create: null,
      });

      if (report.outcome !== "refused") return assert.fail("expected a refusal");
      assert.equal(report.refusal.reason, "helper-refused");
      assert.include(report.refusal.headline, "unit-not-ours");

      const recent = yield* journal.listRecent({
        environmentId: "box-unit-refused",
        limit: 10,
      });
      assert.equal(recent[0]!.outcome, "refused");
      assert.equal(recent[0]!.refusalReason, "helper:unit-not-ours");
    }),
  );
});

it.effect("refuses a unit outside the prefix without dispatching anything", () => {
  const box = makeFakeBox();
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const journal = yield* BoxCommandJournalRepository;
      const report = yield* commands.unit({
        ...caller("box-unit-foreign"),
        verb: "stop",
        name: "days-tracker-api",
        create: null,
      });

      if (report.outcome !== "refused") return assert.fail("expected a refusal");
      assert.equal(report.refusal.reason, "unit-name-outside-prefix");
      // The point of deciding here as well as on the box: nothing was sent.
      assert.deepEqual(box.executed, []);

      const recent = yield* journal.listRecent({
        environmentId: "box-unit-foreign",
        limit: 10,
      });
      assert.equal(recent[0]!.verb, "unit-stop");
      assert.equal(recent[0]!.refusalReason, "unit-name-outside-prefix");
    }),
  );
});

it.effect("keeps the not-ours refusal in front of the helper", () => {
  // A listening process nothing here started, under exactly the name being
  // addressed. The registry's verdict answers first, and it answers the same
  // way it does for `t3 box stop`.
  const box = makeFakeBox({
    services: [{ ...theirs, name: "t3-app-web.service", port: 5432 }],
  });
  return run(
    box,
    Effect.gen(function* () {
      const commands = yield* BoxCommands;
      const report = yield* commands.unit({
        ...caller("box-unit-notours"),
        verb: "stop",
        name: "t3-app-web",
        create: null,
      });

      if (report.outcome !== "refused") return assert.fail("expected a refusal");
      assert.equal(report.refusal.reason, "service-not-ours");
      assert.deepEqual(box.executed, []);
    }),
  );
});
