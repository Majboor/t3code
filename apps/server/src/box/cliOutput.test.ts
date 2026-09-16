import type { EnvironmentService } from "@t3tools/shared/serviceRegistry";
import { describe, expect, it } from "vitest";

import type { BoxCommandEntry } from "../persistence/Services/BoxCommandJournal.ts";
import {
  boxRefusalJson,
  describeBoxRunFailure,
  formatBoxHistory,
  formatBoxRefusal,
  formatBoxRun,
  formatBoxServices,
  formatBoxStop,
} from "./cliOutput.ts";
import type {
  BoxRefused,
  BoxRunReport,
  BoxServicesReport,
  BoxStopReport,
} from "./Services/BoxCommands.ts";

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
  startedBy: "supabase:abc",
  managedId: "svc-web",
  canManage: true,
};

const theirs: EnvironmentService = {
  ...ours,
  port: 5432,
  name: "postgres",
  ownership: "not-ours",
  ownershipReason: "pid 991 (postgres) holds this port and is not a process T3 started.",
  pid: 991,
  managedId: null,
  canManage: false,
};

const run = (over: Partial<BoxRunReport> = {}): BoxRunReport => ({
  outcome: "ran",
  entryId: "entry-1",
  command: "npm ci",
  exitCode: 0,
  signal: null,
  timedOut: false,
  detachedPid: null,
  stdout: { text: "added 412 packages\n", truncated: false, totalBytes: 20, omittedBytes: 0 },
  stderr: { text: "", truncated: false, totalBytes: 0, omittedBytes: 0 },
  durationMs: 4_200,
  ...over,
});

const entry = (over: Partial<BoxCommandEntry> = {}): BoxCommandEntry => ({
  entryId: "entry-1",
  environmentId: "box-1",
  userId: "supabase:abc",
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
  stdout: null,
  stderr: null,
  outputBytes: 0,
  startedAt: "2026-08-20T10:00:00.000Z",
  finishedAt: "2026-08-20T10:00:04.000Z",
  ...over,
});

describe("formatBoxRun", () => {
  it("leads with what happened rather than with the output", () => {
    const text = formatBoxRun(run());
    expect(text.split("\n")[0]).toBe("$ npm ci");
    expect(text).toContain("succeeded in 4.2s");
  });

  it("names the exit code on a failure", () => {
    expect(formatBoxRun(run({ exitCode: 1 }))).toContain("failed with exit code 1");
  });

  it("offers the handle only when something was actually cut", () => {
    expect(formatBoxRun(run())).not.toContain("t3 box output");
    const truncated = formatBoxRun(
      run({
        stdout: { text: "head…tail", truncated: true, totalBytes: 90_000, omittedBytes: 85_000 },
      }),
    );
    expect(truncated).toContain("t3 box output entry-1");
    expect(truncated).toContain("90000 bytes total, 85000 omitted");
  });

  it("says a detached process survives the turn and how to find it", () => {
    const text = formatBoxRun(run({ detachedPid: 5150, exitCode: null }));
    expect(text).toContain("left running as pid 5150");
    expect(text).toContain("t3 box history");
  });

  it("omits an empty stream instead of printing a blank heading", () => {
    expect(formatBoxRun(run())).not.toContain("stderr");
  });

  it("reports a timeout as its own outcome", () => {
    expect(formatBoxRun(run({ timedOut: true, exitCode: null }))).toContain("timed out");
  });
});

describe("describeBoxRunFailure", () => {
  it("passes a clean run", () => {
    expect(describeBoxRunFailure(run())).toBeNull();
  });

  it("fails a non-zero exit code, and says which", () => {
    expect(describeBoxRunFailure(run({ exitCode: 3 }))).toBe("Exit code 3: npm ci");
  });

  it("fails a signal and a timeout in their own words, not as a missing code", () => {
    expect(describeBoxRunFailure(run({ signal: "SIGKILL", exitCode: null }))).toBe(
      "Ended by SIGKILL: npm ci",
    );
    expect(describeBoxRunFailure(run({ timedOut: true, exitCode: null }))).toBe(
      "Timed out: npm ci",
    );
  });

  /**
   * A detached start has no exit code and never will. Treating "no code" as a
   * failure would make `--detach` exit non-zero on every successful use.
   */
  it("passes a detached start, which has no exit code by design", () => {
    expect(describeBoxRunFailure(run({ detachedPid: 5150, exitCode: null }))).toBeNull();
  });

  /**
   * The status line and the exit status are the same judgement said twice, and
   * a reader who sees "failed" in the output and 0 in `$?` cannot trust either.
   */
  it("agrees with what formatBoxRun prints", () => {
    for (const report of [
      run(),
      run({ exitCode: 3 }),
      run({ signal: "SIGKILL", exitCode: null }),
      run({ timedOut: true, exitCode: null }),
      run({ detachedPid: 5150, exitCode: null }),
    ]) {
      const saidFailure = /failed with exit code|timed out|ended by/.test(formatBoxRun(report));
      expect(describeBoxRunFailure(report) !== null).toBe(saidFailure);
    }
  });
});

describe("formatBoxServices", () => {
  const report = (over: Partial<BoxServicesReport> = {}): BoxServicesReport => ({
    outcome: "listed",
    services: [ours, theirs],
    claims: [],
    probe: { tool: "lsof", processAttribution: true, limitation: "" },
    ...over,
  });

  it("says who started each thing and whether it may be stopped", () => {
    const text = formatBoxServices(report());
    expect(text).toContain("STARTED BY");
    expect(text).toContain("someone else");
    expect(text).toMatch(/5432\s+postgres\s+listening\s+someone else\s+991\s+no/);
    expect(text).toMatch(/3000\s+web\s+listening\s+T3\s+4821\s+yes/);
  });

  it("warns that a probe without process attribution is about ports, not processes", () => {
    const text = formatBoxServices(
      report({
        probe: {
          tool: "netstat",
          processAttribution: false,
          limitation: "Run as root to see process names.",
        },
      }),
    );
    expect(text).toContain("cannot name the process behind a socket");
    expect(text).toContain("Run as root");
  });

  it("says plainly when nothing is listening", () => {
    expect(formatBoxServices(report({ services: [] }))).toContain("Nothing is listening here.");
  });

  it("lists reservations with what they are held for", () => {
    const text = formatBoxServices(
      report({
        claims: [
          {
            port: 4000,
            claimedBy: "supabase:abc",
            purpose: "the api while it builds",
            claimedAt: "2026-08-20T10:00:00.000Z",
            expiresAt: "2026-08-20T10:10:00.000Z",
          },
        ] as BoxServicesReport["claims"],
      }),
    );
    expect(text).toContain("4000 — the api while it builds");
  });
});

describe("formatBoxRefusal", () => {
  const refused: BoxRefused = {
    outcome: "refused",
    entryId: "entry-9",
    refusal: {
      reason: "service-not-ours",
      headline: '"postgres" was not started by T3, so it is not T3\'s to stop.',
      remedy: "Leave it running and ask the person who owns this machine.",
    },
  };

  it("prints the refusal as the answer and records it", () => {
    const text = formatBoxRefusal(refused);
    expect(text).toContain("not T3's to stop");
    expect(text).toContain("Recorded as entry-9.");
  });

  it("never suggests a way around itself", () => {
    const text = formatBoxRefusal(refused).toLowerCase();
    expect(text).not.toContain("try again");
    expect(text).not.toContain("--force");
    expect(text).not.toContain("override");
  });

  it("carries the reason through to json for a caller that branches", () => {
    expect(boxRefusalJson(refused)).toMatchObject({
      refused: true,
      reason: "service-not-ours",
      id: "entry-9",
    });
  });
});

describe("formatBoxStop", () => {
  const stopped = (over: Partial<BoxStopReport> = {}): BoxStopReport => ({
    outcome: "stopped",
    entryId: "entry-5",
    service: ours,
    pid: 4821,
    unmanaged: false,
    signalled: true,
    ...over,
  });

  it("names what it signalled", () => {
    expect(formatBoxStop(stopped())).toContain("Sent SIGTERM to pid 4821 (web).");
  });

  it("calls out an override in the output, not only in the journal", () => {
    const text = formatBoxStop(stopped({ service: theirs, pid: 991, unmanaged: true }));
    expect(text).toContain("not a process T3 started");
    expect(text).toContain("on the record");
  });

  it("does not claim success when nothing could be signalled", () => {
    expect(formatBoxStop(stopped({ signalled: false }))).toContain("may already be gone");
  });
});

describe("formatBoxHistory", () => {
  it("shows refusals beside successes rather than hiding them", () => {
    const text = formatBoxHistory({
      outcome: "history",
      entries: [
        entry({
          entryId: "a",
          verb: "stop",
          command: "postgres",
          outcome: "refused",
          refusalReason: "service-not-ours",
          exitCode: null,
        }),
        entry({ entryId: "b" }),
      ],
    });
    expect(text).toContain("refused (service-not-ours)");
    expect(text).toContain("exit 0");
  });

  it("marks an override so it stands out in the record", () => {
    const text = formatBoxHistory({
      outcome: "history",
      entries: [entry({ verb: "stop", unmanaged: true, exitCode: null })],
    });
    expect(text).toContain("stop (override)");
  });

  it("says which processes are still running and by what pid", () => {
    const text = formatBoxHistory({
      outcome: "history",
      entries: [
        entry({
          command: "npm start",
          outcome: "running",
          pid: 5150,
          exitCode: null,
          finishedAt: null,
        }),
      ],
    });
    expect(text).toContain("running, pid 5150");
    expect(text).toContain("Still running: npm start (pid 5150)");
  });

  it("says plainly when a box has no history", () => {
    expect(formatBoxHistory({ outcome: "history", entries: [] })).toBe(
      "Nothing has been run on this box yet.",
    );
  });

  it("keeps a long command from wrecking the table", () => {
    const text = formatBoxHistory({
      outcome: "history",
      entries: [entry({ command: "x".repeat(200) })],
    });
    expect(text).toContain("…");
    expect(text.split("\n").every((line) => line.length < 160)).toBe(true);
  });
});
