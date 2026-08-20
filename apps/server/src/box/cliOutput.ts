/**
 * What the box verbs actually print.
 *
 * Kept out of `cli.ts` for the reason `deploy/cliOutput.ts` is: the wording is
 * the feature. The reader is usually an agent, and an agent acts on the sentence
 * rather than on the exit code — a refusal phrased as an obstacle gets worked
 * around, and the same refusal phrased as the answer gets reported to the person
 * who can actually decide. Pure strings in one file means that wording can be
 * asserted without a machine, a database, or a running box.
 *
 * @module Box
 */

import type { EnvironmentService } from "@t3tools/shared/serviceRegistry";

import type { BoxCommandEntry } from "../persistence/Services/BoxCommandJournal.ts";
import type {
  BoxHistoryReport,
  BoxLogsReport,
  BoxOutputReport,
  BoxPortReport,
  BoxRefused,
  BoxRunReport,
  BoxServicesReport,
  BoxStopReport,
} from "./Services/BoxCommands.ts";

function renderTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column] ?? 0))
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/**
 * A refusal, said so that it reads as the answer.
 *
 * No "try", no flag, no next command. What follows a refusal is a decision
 * somebody else has to make, and a line offering a way around it converts a
 * boundary into a speed bump.
 */
export function formatBoxRefusal(report: BoxRefused): string {
  return `${report.refusal.headline}\n${report.refusal.remedy}\n\nRecorded as ${report.entryId}.`;
}

function formatStream(label: string, stream: BoxRunReport["stdout"]): string {
  if (stream.totalBytes === 0) {
    return "";
  }
  const note = stream.truncated
    ? ` (${stream.totalBytes} bytes total, ${stream.omittedBytes} omitted)`
    : "";
  return `\n${label}${note}:\n${stream.text}`;
}

export function formatBoxRun(report: BoxRunReport): string {
  const status = report.timedOut
    ? "timed out"
    : report.detachedPid !== null
      ? `started and left running as pid ${report.detachedPid}`
      : report.signal !== null
        ? `ended by ${report.signal}`
        : report.exitCode === 0
          ? "succeeded"
          : `failed with exit code ${report.exitCode}`;

  const lines = [`$ ${report.command}`, `${status} in ${formatElapsed(report.durationMs)}.`];

  const streams = `${formatStream("stdout", report.stdout)}${formatStream("stderr", report.stderr)}`;

  // Only offered when there is genuinely more to fetch. Printing the handle on
  // every command would train the reader to ignore it, and it is worth reading
  // on exactly the runs where the interesting part was cut.
  const more =
    report.stdout.truncated || report.stderr.truncated
      ? `\n\nFull output: t3 box output ${report.entryId}`
      : `\n\nRecorded as ${report.entryId}.`;

  const detached =
    report.detachedPid === null
      ? ""
      : "\nIt keeps running after this turn ends; `t3 box history` finds it again.";

  return `${lines.join("\n")}${detached}${streams}${more}`;
}

function ownershipLabel(service: EnvironmentService): string {
  switch (service.ownership) {
    case "ours":
      return "T3";
    case "not-ours":
      return "someone else";
    case "unknown":
      return "unknown";
  }
}

export function formatBoxServices(report: BoxServicesReport): string {
  if (report.services.length === 0) {
    return `Nothing is listening here.\n${probeNote(report)}`;
  }

  const table = renderTable(
    ["PORT", "NAME", "STATE", "STARTED BY", "PID", "STOPPABLE"],
    report.services.map((service) => [
      String(service.port),
      service.name ?? "—",
      service.state,
      ownershipLabel(service),
      service.pid === null ? "—" : String(service.pid),
      service.canManage ? "yes" : "no",
    ]),
  );

  const claims =
    report.claims.length === 0
      ? ""
      : `\n\nReserved:\n${report.claims
          .map((claim) => `  ${claim.port} — ${claim.purpose} (until ${claim.expiresAt})`)
          .join("\n")}`;

  // Said every time, because a screenful of "unknown" from a netstat-only probe
  // reads as a bug rather than as the honest limit it is.
  return `${table}${claims}\n\n${probeNote(report)}`;
}

function probeNote(report: BoxServicesReport): string {
  return report.probe.processAttribution
    ? `Inspected with ${report.probe.tool}.`
    : `Inspected with ${report.probe.tool}, which cannot name the process behind a socket — every row here is about a port, not about a process. ${report.probe.limitation}`.trim();
}

export function formatBoxStop(report: BoxStopReport): string {
  const name = report.service.name ?? `port ${report.service.port}`;
  const outcome = report.signalled
    ? `Sent SIGTERM to pid ${report.pid} (${name}).`
    : `Could not signal pid ${report.pid} (${name}); it may already be gone.`;

  // An override is called out in the output, not just in the table. Whoever
  // reads this transcript later should not have to query the journal to learn
  // that something T3 did not start was killed on purpose.
  const warning = report.unmanaged
    ? `\n\nThis was not a process T3 started. That is now on the record for this box.`
    : "";

  return `${outcome}${warning}\n\nRecorded as ${report.entryId}.`;
}

export function formatBoxLogs(report: BoxLogsReport): string {
  const name = report.service.name ?? `port ${report.service.port}`;
  const note = report.output.truncated
    ? ` (${report.output.totalBytes} bytes total, ${report.output.omittedBytes} omitted)`
    : "";
  return `${name}${note}:\n${report.output.text}`;
}

export function formatBoxPort(report: BoxPortReport, verb: "claim" | "release"): string {
  if (verb === "release") {
    return `Released port ${report.port}.\n\nRecorded as ${report.entryId}.`;
  }
  return report.claim === null
    ? `Port ${report.port} could not be reserved — something took it first.\n\nRecorded as ${report.entryId}.`
    : `Port ${report.port} is reserved for you until ${report.claim.expiresAt}: ${report.claim.purpose}.\n\nStart what you reserved it for; the reservation lapses if nothing takes it.`;
}

function outcomeLabel(entry: BoxCommandEntry): string {
  switch (entry.outcome) {
    case "ok":
      return entry.exitCode === null ? "ok" : `exit ${entry.exitCode}`;
    case "failed":
      return entry.exitCode === null ? "failed" : `exit ${entry.exitCode}`;
    case "refused":
      return `refused (${entry.refusalReason ?? "no reason recorded"})`;
    case "running":
      return entry.pid === null ? "running" : `running, pid ${entry.pid}`;
  }
}

/**
 * What happened here recently.
 *
 * Refusals are shown alongside successes rather than filtered out. A history
 * that only lists what worked hides the most useful entry there is: the moment
 * somebody tried to stop a process they did not start.
 */
export function formatBoxHistory(report: BoxHistoryReport): string {
  if (report.entries.length === 0) {
    return "Nothing has been run on this box yet.";
  }

  const table = renderTable(
    ["WHEN", "VERB", "WHAT", "RESULT", "TURN"],
    report.entries.map((entry) => [
      entry.startedAt,
      entry.unmanaged ? `${entry.verb} (override)` : entry.verb,
      truncateCell(entry.command ?? "—", 48),
      outcomeLabel(entry),
      entry.turnId ?? "—",
    ]),
  );

  const running = report.entries.filter((entry) => entry.outcome === "running");
  const stillRunning =
    running.length === 0
      ? ""
      : `\n\nStill running: ${running
          .map((entry) => `${entry.command ?? "?"} (pid ${entry.pid ?? "?"})`)
          .join(", ")}`;

  return `${table}${stillRunning}`;
}

function truncateCell(value: string, width: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`;
}

export function formatBoxOutput(report: BoxOutputReport): string {
  const entry = report.entry;
  const parts = [`$ ${entry.command ?? "—"}`, `${outcomeLabel(entry)} at ${entry.startedAt}.`];
  if (entry.stdout !== null && entry.stdout.length > 0) {
    parts.push(`\nstdout:\n${entry.stdout}`);
  }
  if (entry.stderr !== null && entry.stderr.length > 0) {
    parts.push(`\nstderr:\n${entry.stderr}`);
  }
  if (entry.stdout === null && entry.stderr === null) {
    parts.push("\nThis command captured no output.");
  }
  return parts.join("\n");
}

// ── json ────────────────────────────────────────────────────────────────────

export function boxRunJson(report: BoxRunReport): unknown {
  return {
    id: report.entryId,
    command: report.command,
    exitCode: report.exitCode,
    signal: report.signal,
    timedOut: report.timedOut,
    detachedPid: report.detachedPid,
    durationMs: report.durationMs,
    stdout: report.stdout,
    stderr: report.stderr,
  };
}

export function boxRefusalJson(report: BoxRefused): unknown {
  return {
    refused: true,
    id: report.entryId,
    reason: report.refusal.reason,
    headline: report.refusal.headline,
    remedy: report.refusal.remedy,
  };
}

export function boxHistoryJson(report: BoxHistoryReport): unknown {
  return {
    entries: report.entries.map((entry) => ({
      id: entry.entryId,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      verb: entry.verb,
      command: entry.command,
      outcome: entry.outcome,
      refusalReason: entry.refusalReason,
      exitCode: entry.exitCode,
      pid: entry.pid,
      unmanaged: entry.unmanaged,
      turnId: entry.turnId,
    })),
  };
}

export function boxServicesJson(report: BoxServicesReport): unknown {
  return { services: report.services, claims: report.claims, probe: report.probe };
}

function formatElapsed(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const seconds = ms / 1_000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}
