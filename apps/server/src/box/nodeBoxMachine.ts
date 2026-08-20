/**
 * A real machine, behind the `BoxMachine` seam.
 *
 * Everything here is the part that cannot be tested on a laptop without
 * depending on what that laptop happens to have installed and be serving:
 * spawning processes, asking the kernel what is listening, writing a log file.
 * The rules live next door in `decideBoxSignal` and `boxResponder`, which is why
 * this file has no `if` in it about permission.
 *
 * It reuses the environment's own service registry rather than keeping a second
 * set of start records. A box already answers "what is running here" for `t3 env
 * services`, from a SQLite table and a probe, and a second table would be a
 * second answer to the same question — with the wrong one holding the kill
 * switch. Ownership is therefore derived exactly once, by
 * `@t3tools/shared/serviceRegistry`, from records this machine wrote.
 *
 * @module Box
 */

import { spawn } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Path from "node:path";

import { Effect, Option } from "effect";
import { PortNumber, ServiceId, UserId } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ObservedListener, PortClaim } from "@t3tools/shared/serviceRegistry";

import type { EnvironmentServiceRepositoryShape } from "../persistence/Services/EnvironmentServices.ts";
import {
  isProcessAlive,
  probeListeners,
  type ListenerProbeResult,
} from "../environment/listenerProbe.ts";
import type { ServiceRegistryShape } from "../environment/Services/ServiceRegistry.ts";
import { runProcess } from "../processRunner.ts";
import type { BoxProcessSignal } from "./boxProtocol.ts";
import type { BoxMachine } from "./boxResponder.ts";
import type { BoxExecOutcome, BoxInspection } from "./Services/BoxSession.ts";

/**
 * How long a detached start is watched before the box answers.
 *
 * Long enough for a server to bind its port and for a broken command to fall
 * over, short enough that the caller's thirty-second budget for a detached start
 * is nowhere near troubled. What happens in this window is the difference
 * between `t3 box run --detach` returning a pid and returning a pid plus the
 * service it became: a process that is listening is registered, and registering
 * is what makes it findable, readable and stoppable once the connection that
 * started it is long gone.
 */
const DETACH_SETTLE_MS = 2_000;
const DETACH_POLL_MS = 150;

/** What a reservation with nothing said about it is held for. */
const UNSTATED_PURPOSE = "Reserved through t3 box.";

export interface NodeBoxMachineOptions {
  readonly registry: ServiceRegistryShape;
  readonly services: EnvironmentServiceRepositoryShape;
  readonly environmentId: EnvironmentId;
  /** Where a detached start's captured output is written. */
  readonly logDirectory: string;
  /** Where commands run. The box's own working directory. */
  readonly workingDirectory: string;
  readonly probeListeners?: (() => Promise<ListenerProbeResult>) | undefined;
  readonly isAlive?: ((pid: number) => boolean) | undefined;
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly settleMs?: number | undefined;
}

/**
 * Runs an Effect and turns its failure into a rejected promise.
 *
 * The failure is flattened into an ordinary `Error` carrying the sentence the
 * service wrote, rather than escaping as a fiber failure: this value ends up in
 * a refusal that a person reads, and "FiberFailure(…)" is not a sentence.
 */
const attempt = <A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.map((value) => ({ ok: true, value }) as const),
      Effect.catch((error: E) => Effect.succeed({ ok: false, message: error.message } as const)),
    ),
  ).then((outcome) => {
    if (outcome.ok) {
      return outcome.value;
    }
    throw new Error(outcome.message);
  });

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A shell invocation for a command that arrived as one string.
 *
 * `sh -c` and not a parsed argument vector, because `t3 box run` is the agent
 * acting as its own unprivileged user and a shell is what that user has. This is
 * emphatically not the privileged path — that one is `t3 box unit`, it reaches a
 * root-owned helper, and it never builds a command line from anything a caller
 * supplied. Keeping the two apart is what makes "what did this need root for"
 * answerable by reading the command rather than the implementation.
 */
function shellInvocation(command: string): { readonly file: string; readonly args: Array<string> } {
  return process.platform === "win32"
    ? { file: command, args: [] }
    : { file: "/bin/sh", args: ["-c", command] };
}

/** A filename-safe handle for one detached start, and the name it is known by. */
function mintRunName(): string {
  return `run-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** How a detached start ended, if it ended while the box was still watching. */
interface DetachedExit {
  value: { readonly code: number | null; readonly signal: string | null } | null;
}

/**
 * Sends the signal, and says whether anything received it.
 *
 * Whether it *may* be sent was decided before this was called, by
 * `decideBoxSignal`, from this machine's own registry. A process that has
 * already gone, or one this user may not signal, answers `false` rather than
 * raising: the caller journals the answer either way, and "nothing was ended"
 * is the useful sentence.
 */
async function sendSignal(input: {
  readonly pid: number;
  readonly signal: BoxProcessSignal;
}): Promise<boolean> {
  try {
    process.kill(input.pid, input.signal);
    return true;
  } catch {
    return false;
  }
}

export function createNodeBoxMachine(options: NodeBoxMachineOptions): BoxMachine {
  const probe = options.probeListeners ?? probeListeners;
  const alive = options.isAlive ?? isProcessAlive;
  const sleep = options.sleep ?? defaultSleep;
  const settleMs = options.settleMs ?? DETACH_SETTLE_MS;

  const logPathFor = (name: string) => Path.join(options.logDirectory, `${name}.log`);

  const inspect = async (): Promise<BoxInspection> => {
    const listed = await attempt(options.registry.list({ environmentId: options.environmentId }));
    return {
      services: listed.services,
      claims: listed.claims,
      probe: listed.probe,
    };
  };

  /**
   * Waits out a detached start, and says what became of it.
   *
   * Two things are being watched at once and both are outcomes worth reporting.
   * A process that exits inside the window did not become a service and the
   * caller needs its exit code and its output, or `--detach` becomes the flag
   * that makes failures silent. A process that is still there and listening
   * *did*, and the port it holds is the fact that lets it be registered.
   */
  const settleDetached = async (input: {
    readonly pid: number;
    readonly exit: DetachedExit;
  }): Promise<{ readonly listener: ObservedListener | null }> => {
    const deadline = Date.now() + settleMs;
    let listener: ObservedListener | null = null;

    while (Date.now() < deadline) {
      await sleep(DETACH_POLL_MS);
      if (input.exit.value !== null || !alive(input.pid)) {
        return { listener: null };
      }
      const probed = await probe();
      const found = probed.listeners
        .filter((entry) => entry.pid === input.pid)
        .toSorted((left, right) => left.port - right.port);
      if (found.length > 0) {
        listener = found[0] ?? null;
        break;
      }
    }

    return { listener };
  };

  /**
   * Starts something and leaves it running.
   *
   * `detached: true` plus `unref()` is what makes the process survive this
   * server: it gets its own process group, so it is not taken down when the
   * connection that asked for it goes away, when the turn ends, or when T3
   * itself is restarted. That is the whole point of a box — something has to
   * still be serving tomorrow.
   *
   * Its streams go to a file rather than to a pipe for the same reason. A pipe
   * belongs to this process; when this process goes, the process on the other
   * end of it gets `EPIPE` on its next `console.log` and dies of it hours later,
   * for reasons nothing records.
   */
  const startDetached = async (input: {
    readonly command: string;
    readonly actorUserId: string;
  }): Promise<BoxExecOutcome> => {
    const name = mintRunName();
    const logPath = logPathFor(name);
    await Fs.mkdir(options.logDirectory, { recursive: true });
    const log = await Fs.open(logPath, "a");

    const invocation = shellInvocation(input.command);
    // A box rather than a bare `let`, because the assignment happens in a
    // listener and TypeScript's flow analysis does not follow one — reading a
    // `let` back would be reading a type it has narrowed to `null`.
    const exit: DetachedExit = { value: null };

    const child = spawn(invocation.file, invocation.args, {
      cwd: options.workingDirectory,
      detached: true,
      shell: process.platform === "win32",
      stdio: ["ignore", log.fd, log.fd],
    });
    child.once("close", (code, signal) => {
      exit.value = { code, signal };
    });

    const started = await new Promise<number | null>((resolve) => {
      child.once("spawn", () => resolve(child.pid ?? null));
      child.once("error", () => resolve(null));
    });
    child.unref();
    // The child holds its own duplicate of this descriptor, so closing ours does
    // not close its output — and leaving it open would leak one per detached
    // start for the life of the server.
    await log.close();

    if (started === null) {
      const captured = await Fs.readFile(logPath, "utf8").catch(() => "");
      return {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: captured.length > 0 ? captured : `${input.command} could not be started.`,
        pid: null,
        timedOut: false,
      };
    }

    const settled = await settleDetached({ pid: started, exit });

    if (exit.value !== null || !alive(started)) {
      const captured = await Fs.readFile(logPath, "utf8").catch(() => "");
      return {
        exitCode: exit.value?.code ?? null,
        signal: exit.value?.signal ?? null,
        stdout: captured,
        stderr: "",
        // No pid, because there is no process. Reporting the number it briefly
        // held would hand the caller a handle to something that is not there,
        // and pids are recycled.
        pid: null,
        timedOut: false,
      };
    }

    if (settled.listener !== null) {
      // Registered only once the machine confirms it is serving. A start record
      // for a port nobody is listening on is a claim the registry cannot
      // corroborate, and the registry's entire rule is that a record plus a
      // matching pid is what makes something ours.
      await attempt(
        options.registry.register({
          environmentId: options.environmentId,
          asking: UserId.make(input.actorUserId),
          name,
          port: PortNumber.make(settled.listener.port),
          pid: started,
          command: input.command,
        }),
      );
    }

    return { exitCode: null, signal: null, stdout: "", stderr: "", pid: started, timedOut: false };
  };

  const exec: BoxMachine["exec"] = async (input) => {
    if (input.detach) {
      return startDetached({ command: input.command, actorUserId: input.actorUserId });
    }

    const invocation = shellInvocation(input.command);
    const result = await runProcess(invocation.file, invocation.args, {
      cwd: options.workingDirectory,
      timeoutMs: input.timeoutMs,
      // A non-zero exit is an answer, not a fault: reporting the exit code is
      // the whole reason an agent asked.
      allowNonZeroExit: true,
      outputMode: "truncate",
    });

    return {
      exitCode: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      pid: null,
      timedOut: result.timedOut,
    };
  };

  const readServiceLog: BoxMachine["readServiceLog"] = async (input) => {
    const found = await attempt(
      options.services.get({ serviceId: ServiceId.make(input.managedId) }),
    );
    if (Option.isNone(found) || found.value.environmentId !== options.environmentId) {
      // Checked on the box and not taken from the caller's word: a service id is
      // a string that arrived over a relay, and reading a file named by one
      // without confirming this machine wrote the record would be a way to ask a
      // box for a path.
      throw new Error("This box has no record of starting that service.");
    }
    return Fs.readFile(logPathFor(found.value.name), "utf8").catch(() => "");
  };

  const claimPort: BoxMachine["claimPort"] = async (input) => {
    const purpose = input.purpose.trim();
    const result = await attempt(
      options.registry.claimPort({
        environmentId: options.environmentId,
        asking: UserId.make(input.actorUserId),
        port: PortNumber.make(input.port),
        purpose: purpose.length === 0 ? UNSTATED_PURPOSE : purpose,
      }),
    );
    return result.claim satisfies PortClaim | null as PortClaim | null;
  };

  const releasePort: BoxMachine["releasePort"] = async (input) => {
    // The holder check lives in the repository, which filters the delete by
    // `claimedBy`. That is the box refusing to forget somebody else's
    // reservation from its own records, rather than trusting that the caller
    // checked — and the caller did check, which is exactly why this must too.
    const result = await attempt(
      options.registry.releasePort({
        environmentId: options.environmentId,
        asking: UserId.make(input.actorUserId),
        port: PortNumber.make(input.port),
      }),
    );
    return result.released;
  };

  return {
    inspect,
    exec,
    signal: sendSignal,
    readServiceLog,
    claimPort,
    releasePort,
  } satisfies BoxMachine;
}
