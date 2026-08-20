/**
 * Asking a machine what it is listening on.
 *
 * There is no portable system call for this, so the answer comes from whichever
 * tool the machine happens to have, and the tools disagree about how much they
 * will tell you. `lsof` names the process; `ss` names it on Linux and does not
 * exist on macOS; `netstat` exists nearly everywhere and, on macOS, will not
 * name a process without privilege. Which one answered therefore changes what
 * may be *concluded*, not merely how the output is spelled — a `netstat` reading
 * cannot support "that is not our process", because it cannot see processes at
 * all.
 *
 * So a probe reports `processAttribution` alongside its listeners, and the
 * reconciler in `@t3tools/shared/serviceRegistry` turns an unattributable socket
 * into `unknown` rather than into an answer. Nothing here guesses. A machine
 * where every tool is missing returns an empty list and says it saw nothing,
 * which is different from saying nothing is running, and the difference reaches
 * the caller intact.
 *
 * The parsers are pure and separate from the running, because the running is the
 * part that cannot be tested on a developer's laptop without depending on what
 * that laptop happens to have installed and be serving.
 */
import type { ObservedListener } from "@t3tools/shared/serviceRegistry";

import { runProcess } from "../processRunner.ts";

/** Which tool answered, and therefore how much the answer is worth. */
export type ListenerProbeTool = "lsof" | "ss" | "netstat" | "none";

export interface ListenerProbeResult {
  readonly tool: ListenerProbeTool;
  readonly listeners: ReadonlyArray<ObservedListener>;
  /** Whether this tool can attribute a socket to a process at all. */
  readonly processAttribution: boolean;
  /**
   * Why the answer is as thin as it is, when it is thin. Empty when the probe
   * ran normally. Carried so a caller can say "I could not look" rather than
   * "nothing is running", which are opposite claims.
   */
  readonly limitation: string;
}

/**
 * `*` and `[::]` are the same statement as `0.0.0.0`: reachable from anywhere
 * the machine is. Normalised because the ownership rules and the UI both care
 * whether a thing is exposed, and three spellings of "yes" is three bugs.
 */
export function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "*" || trimmed === "[::]" || trimmed === "::") return "0.0.0.0";
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1);
  return trimmed;
}

/**
 * Splits `127.0.0.1:3000`, `[::1]:3000`, `*:3000` and macOS's `127.0.0.1.3000`
 * into an address and a port.
 *
 * The last separator wins, because an IPv6 address is full of colons and the
 * port is always at the end. Returns null for anything that does not end in a
 * port, which is how `*.*` and half-written lines are dropped rather than
 * becoming a listener on port NaN.
 */
export function splitAddressPort(raw: string): { address: string; port: number } | null {
  const value = raw.trim();
  if (value.length === 0) return null;

  const separator = Math.max(value.lastIndexOf(":"), value.lastIndexOf("."));
  if (separator <= 0 || separator === value.length - 1) return null;

  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;

  return { address: normalizeAddress(value.slice(0, separator)), port };
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -F pcn`.
 *
 * Field output rather than the table, because the table's columns are aligned
 * by padding and a command name with a space in it silently shifts every column
 * after it. In field mode each line is one tagged value: `p` opens a process,
 * `c` names it, and every `n` after that is one of its sockets — so the process
 * is carried down the file until the next `p`.
 */
export function parseLsofListeners(stdout: string): ReadonlyArray<ObservedListener> {
  const listeners: ObservedListener[] = [];
  let pid: number | null = null;
  let processName: string | null = null;

  for (const line of stdout.split("\n")) {
    const tag = line[0];
    const value = line.slice(1).trim();

    if (tag === "p") {
      // A process whose id will not parse is a process we cannot attribute
      // anything to, so its sockets go in nameless rather than under a guess.
      // The emptiness check is load-bearing: `Number("")` is 0, and a pid of 0
      // would read downstream as a real process nobody started.
      const parsed = value.length === 0 ? Number.NaN : Number(value);
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
      processName = null;
      continue;
    }
    if (tag === "c") {
      processName = value.length > 0 ? value : null;
      continue;
    }
    if (tag !== "n") continue;

    // `->` marks an established connection. `-sTCP:LISTEN` should have removed
    // them, but the flag is silently ignored by some builds.
    if (value.includes("->")) continue;

    const split = splitAddressPort(value);
    if (!split) continue;

    listeners.push({
      port: split.port,
      address: split.address,
      protocol: "tcp",
      pid,
      processName,
    });
  }

  return listeners;
}

const SS_PROCESS = /pid=(\d+)/;
const SS_NAME = /\(\("([^"]+)"/;

/**
 * `ss -lntpH`: `LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=812,fd=6))`
 *
 * The process column is absent entirely when `ss` runs without privilege, which
 * is the normal case for a server not running as root. That produces a null pid
 * — the honest answer — rather than a missing row.
 */
export function parseSsListeners(stdout: string): ReadonlyArray<ObservedListener> {
  const listeners: ObservedListener[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    // `-H` suppresses the header, but not on older builds.
    if (trimmed.startsWith("State") || trimmed.startsWith("Netid")) continue;

    const columns = trimmed.split(/\s+/);
    const state = columns.find((column) => column === "LISTEN" || column === "UNCONN");
    if (state === undefined) continue;

    const stateIndex = columns.indexOf(state);
    const local = columns[stateIndex + 3];
    if (local === undefined) continue;

    const split = splitAddressPort(local);
    if (!split) continue;

    const pidMatch = SS_PROCESS.exec(trimmed);
    const nameMatch = SS_NAME.exec(trimmed);

    listeners.push({
      port: split.port,
      address: split.address,
      protocol: state === "UNCONN" ? "udp" : "tcp",
      pid: pidMatch ? Number(pidMatch[1]) : null,
      processName: nameMatch ? (nameMatch[1] ?? null) : null,
    });
  }

  return listeners;
}

/**
 * `netstat -an -p tcp` (macOS) or `netstat -ltn` (Linux).
 *
 * Every row here has a null pid and that is not a defect to be worked around:
 * macOS will not attribute a socket without privilege, and asking for it with
 * `sudo` from a background server is not something this product is going to do.
 * This is the probe of last resort, and its whole contribution is "the port is
 * taken" — which is enough to stop an agent binding it, and not enough to let
 * one kill anything.
 */
export function parseNetstatListeners(stdout: string): ReadonlyArray<ObservedListener> {
  const listeners: ObservedListener[] = [];

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/\bLISTEN\b/.test(trimmed)) continue;

    const columns = trimmed.split(/\s+/);
    const proto = columns[0] ?? "";
    if (!proto.toLowerCase().startsWith("tcp")) continue;

    // macOS: proto recv send local foreign state. Linux: proto recv send local
    // foreign state [pid/name]. The local address is the first column after the
    // two byte counts that parses as an address and a port.
    const split = columns
      .slice(1)
      .map(splitAddressPort)
      .find((entry) => entry !== null);
    if (!split) continue;

    listeners.push({
      port: split.port,
      address: split.address,
      protocol: "tcp",
      pid: null,
      processName: null,
    });
  }

  return listeners;
}

const PROBE_TIMEOUT_MS = 5_000;

async function tryProbe(
  command: string,
  args: ReadonlyArray<string>,
  parse: (stdout: string) => ReadonlyArray<ObservedListener>,
): Promise<ReadonlyArray<ObservedListener> | null> {
  try {
    const result = await runProcess(command, args, {
      timeoutMs: PROBE_TIMEOUT_MS,
      // `lsof` exits non-zero when any single file could not be examined, which
      // happens constantly on a machine with other users' processes on it. The
      // rows it did produce are still correct.
      allowNonZeroExit: true,
      outputMode: "truncate",
    });
    if (result.timedOut) return null;
    const listeners = parse(result.stdout);
    // An empty parse from a tool that ran is ambiguous: it could be an idle
    // machine, or output this parser does not understand. Treated as a failure
    // so the next tool gets a turn; a genuinely idle machine ends at `netstat`
    // returning nothing, and reports no listeners either way.
    return listeners.length > 0 ? listeners : null;
  } catch {
    return null;
  }
}

/**
 * The best answer this machine can give about what it is serving.
 *
 * Ordered by how much each tool knows, not by how likely it is to be installed:
 * a machine with both `lsof` and `netstat` should get the answer that names
 * processes, because that is the difference between an agent being allowed to
 * restart its own dev server and not.
 */
export async function probeListeners(): Promise<ListenerProbeResult> {
  const viaLsof = await tryProbe(
    "lsof",
    ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"],
    parseLsofListeners,
  );
  if (viaLsof) {
    return { tool: "lsof", listeners: viaLsof, processAttribution: true, limitation: "" };
  }

  const viaSs = await tryProbe("ss", ["-lntpH"], parseSsListeners);
  if (viaSs) {
    return {
      tool: "ss",
      listeners: viaSs,
      processAttribution: true,
      limitation: viaSs.every((listener) => listener.pid === null)
        ? "ss named no processes, which usually means it is running without the privilege to see them."
        : "",
    };
  }

  const viaNetstat = await tryProbe(
    "netstat",
    process.platform === "linux" ? ["-ltn"] : ["-an", "-p", "tcp"],
    parseNetstatListeners,
  );
  if (viaNetstat) {
    return {
      tool: "netstat",
      listeners: viaNetstat,
      processAttribution: false,
      limitation:
        "netstat answered, and it cannot say which process holds a port. Every listener here is reported as unknown ownership.",
    };
  }

  return {
    tool: "none",
    listeners: [],
    processAttribution: false,
    limitation:
      "None of lsof, ss or netstat could be run here, so nothing was observed. This is not a claim that the machine is idle.",
  };
}

/**
 * Whether a process id still exists.
 *
 * `kill(pid, 0)` sends no signal and only asks. `EPERM` means the process is
 * there and belongs to somebody else, which for our purposes is still "alive" —
 * we are checking existence, and a process we may not signal is emphatically
 * not gone.
 *
 * What this cannot tell you is whether the pid is still the *same* process.
 * Process ids are recycled, and after a reboot or a long uptime a number we
 * wrote down may belong to something entirely unrelated. That is why liveness
 * here only ever refreshes an existing record and never resurrects a swept one:
 * the TTL is the guard against a recycled pid keeping a ghost alive forever.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
