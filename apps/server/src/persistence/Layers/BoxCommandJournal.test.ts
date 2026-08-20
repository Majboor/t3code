import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  BoxCommandJournalRepository,
  type RecordBoxCommandInput,
} from "../Services/BoxCommandJournal.ts";
import { BoxCommandJournalRepositoryLive } from "./BoxCommandJournal.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  Layer.mergeAll(
    BoxCommandJournalRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const USER = "supabase:abc";

/**
 * The suite shares one in-memory database, so each test works on a box of its
 * own and derives its entry ids from it. Two tests writing `entry-1` would
 * collide on the primary key, which is a fact about the fixture rather than
 * about the table.
 */
const entry = (
  box: string,
  suffix: string,
  over: Partial<RecordBoxCommandInput> = {},
): RecordBoxCommandInput => ({
  entryId: `${box}:${suffix}`,
  environmentId: box,
  userId: USER,
  turnId: "turn-7",
  verb: "run",
  command: "npm ci",
  serviceId: null,
  outcome: "ok",
  refusalReason: null,
  exitCode: 0,
  signal: null,
  pid: null,
  unmanaged: false,
  stdout: "added 412 packages\n",
  stderr: null,
  outputBytes: 20,
  startedAt: "2026-08-20T10:00:00.000Z",
  finishedAt: "2026-08-20T10:00:30.000Z",
  ...over,
});

layer("BoxCommandJournalRepository", (it) => {
  it.effect("keeps what was run, by which turn, and how it ended", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      const written = yield* journal.record(entry("box-basics", "run"));

      assert.equal(written.command, "npm ci");
      assert.equal(written.turnId, "turn-7");
      assert.equal(written.exitCode, 0);
      assert.equal(written.outcome, "ok");
      assert.isFalse(written.unmanaged);
    }),
  );

  it.effect("round-trips the override flag as a boolean and not a raw 1", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      const written = yield* journal.record(
        entry("box-override", "stop", { verb: "stop", unmanaged: true, pid: 991 }),
      );
      assert.isTrue(written.unmanaged);

      const read = yield* journal.get({ entryId: "box-override:stop", userId: USER });
      assert.isTrue(Option.isSome(read));
      assert.isTrue(Option.getOrThrow(read).unmanaged);
    }),
  );

  it.effect("records a refusal, which is the entry worth having most", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      const written = yield* journal.record(
        entry("box-refusal", "stop", {
          verb: "stop",
          command: "postgres",
          outcome: "refused",
          refusalReason: "service-not-ours",
          exitCode: null,
          stdout: null,
        }),
      );
      assert.equal(written.outcome, "refused");
      assert.equal(written.refusalReason, "service-not-ours");
      assert.isFalse(written.unmanaged);
    }),
  );

  it.effect("answers what happened here recently, newest first and bounded", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      for (const index of [1, 2, 3, 4]) {
        yield* journal.record(
          entry("box-recent", `step-${index}`, {
            command: `step ${index}`,
            startedAt: `2026-08-20T10:0${index}:00.000Z`,
          }),
        );
      }

      const recent = yield* journal.listRecent({ environmentId: "box-recent", limit: 2 });
      assert.deepEqual(
        recent.map((row) => row.command),
        ["step 4", "step 3"],
      );
    }),
  );

  it.effect("never mixes two boxes' histories", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      yield* journal.record(entry("box-mine", "a", { command: "mine" }));
      yield* journal.record(entry("box-theirs", "a", { command: "theirs" }));

      const recent = yield* journal.listRecent({ environmentId: "box-mine", limit: 10 });
      assert.deepEqual(
        recent.map((row) => row.command),
        ["mine"],
      );
    }),
  );

  it.effect("finds a detached start again after the connection is gone", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      yield* journal.record(
        entry("box-detached", "server", {
          command: "npm start",
          outcome: "running",
          exitCode: null,
          pid: 4821,
          stdout: null,
          finishedAt: null,
        }),
      );
      // A finished command is history, not something still running.
      yield* journal.record(entry("box-detached", "done"));

      const running = yield* journal.listUnfinished({
        environmentId: "box-detached",
        limit: 10,
      });
      assert.deepEqual(
        running.map((row) => row.pid),
        [4821],
      );
      assert.deepEqual(
        running.map((row) => row.command),
        ["npm start"],
      );
    }),
  );

  it.effect("closes an open row once, and only within its own box", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      yield* journal.record(
        entry("box-finish", "server", {
          outcome: "running",
          exitCode: null,
          pid: 4821,
          finishedAt: null,
        }),
      );

      const wrongBox = yield* journal.finish({
        entryId: "box-finish:server",
        environmentId: "box-somewhere-else",
        outcome: "ok",
        exitCode: 0,
        signal: null,
        stdout: "done",
        stderr: null,
        outputBytes: 4,
        finishedAt: "2026-08-20T11:00:00.000Z",
      });
      assert.isTrue(Option.isNone(wrongBox));

      const closed = yield* journal.finish({
        entryId: "box-finish:server",
        environmentId: "box-finish",
        outcome: "failed",
        exitCode: 137,
        signal: "SIGKILL",
        stdout: "starting\n",
        stderr: "killed\n",
        outputBytes: 18,
        finishedAt: "2026-08-20T11:00:00.000Z",
      });
      assert.isTrue(Option.isSome(closed));
      assert.equal(Option.getOrThrow(closed).exitCode, 137);
      assert.equal(Option.getOrThrow(closed).signal, "SIGKILL");

      // Closing twice must not rewrite a settled record.
      const again = yield* journal.finish({
        entryId: "box-finish:server",
        environmentId: "box-finish",
        outcome: "ok",
        exitCode: 0,
        signal: null,
        stdout: null,
        stderr: null,
        outputBytes: 0,
        finishedAt: "2026-08-20T12:00:00.000Z",
      });
      assert.isTrue(Option.isNone(again));

      const still = yield* journal.get({ entryId: "box-finish:server", userId: USER });
      assert.equal(Option.getOrThrow(still).exitCode, 137);

      // And it is no longer something that looks like it is still running.
      const running = yield* journal.listUnfinished({ environmentId: "box-finish", limit: 10 });
      assert.equal(running.length, 0);
    }),
  );

  it.effect("will not hand one account's output to another", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      yield* journal.record(entry("box-private", "run", { stdout: "DATABASE_URL=..." }));

      const mine = yield* journal.get({ entryId: "box-private:run", userId: USER });
      assert.isTrue(Option.isSome(mine));

      const theirs = yield* journal.get({ entryId: "box-private:run", userId: "supabase:xyz" });
      assert.isTrue(Option.isNone(theirs));
    }),
  );

  it.effect("keeps the true output size even when it stored less", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      const written = yield* journal.record(
        entry("box-big", "run", { stdout: "head…tail", outputBytes: 4_000_000 }),
      );
      assert.equal(written.outputBytes, 4_000_000);
    }),
  );

  it.effect("stores the override flag as the integer the column declares", () =>
    Effect.gen(function* () {
      const journal = yield* BoxCommandJournalRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* journal.record(entry("box-raw", "stop", { verb: "stop", unmanaged: true }));

      const rows = yield* sql`
        SELECT unmanaged FROM box_command_journal WHERE entry_id = 'box-raw:stop'
      `;
      assert.equal(rows.length, 1);
      assert.equal((rows[0] as { readonly unmanaged: number }).unmanaged, 1);
    }),
  );
});
