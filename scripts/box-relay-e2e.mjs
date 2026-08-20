#!/usr/bin/env bun
/**
 * A hub and a box, on one laptop, actually talking.
 *
 * Everything else about the box verbs is covered by unit tests against a machine
 * that does not exist, which is the only way to test "refuses to kill the
 * production database" without a production database. This script is the other
 * half: two real processes, one real outbound websocket, real `lsof`, real child
 * processes that outlive the thing that started them, and a real refusal coming
 * back from the machine that owns the process.
 *
 * The hub runs **in this process**, and that is not a shortcut — it is forced.
 * The relay's live connections are held in module memory (`environmentRelay/
 * registry.ts`), deliberately, because a socket cannot outlive the process
 * holding it and a table claiming otherwise would be the stale green dot the
 * whole design exists to stop showing. So the only place a box command can be
 * dispatched from is the process the box dialled into. `t3 box …` typed at a
 * shell opens its own process, finds an empty registry, and correctly reports
 * that no box is connected under that name. Closing that gap means the hub
 * exposing the box verbs over HTTP, which is a route this change does not add.
 *
 * What this drives is therefore `BoxCommands` — the exact service every `t3 box`
 * subcommand is a thin wrapper over — with the exact formatters the CLI prints
 * with, so what appears below is what `t3 box` would print.
 *
 *     bun scripts/box-relay-e2e.mjs
 */

import { spawn } from "node:child_process";
import * as Fs from "node:fs/promises";
import * as Os from "node:os";
import * as Path from "node:path";
import * as Net from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Fiber, Layer, Option } from "effect";

import { NetService } from "@t3tools/shared/Net";

const ROOT = Path.resolve(import.meta.dirname, "..");
const SERVER_SRC = Path.join(ROOT, "apps/server/src");
const BIN = Path.join(SERVER_SRC, "bin.ts");

const { resolveServerConfig } = await import(Path.join(SERVER_SRC, "cli.ts"));
const { runServer } = await import(Path.join(SERVER_SRC, "server.ts"));
const { ServerConfig } = await import(Path.join(SERVER_SRC, "config.ts"));
const { BoxCommandsLive } = await import(Path.join(SERVER_SRC, "box/Layers/BoxCommands.ts"));
const { BoxSessionRelayLive } = await import(
  Path.join(SERVER_SRC, "box/Layers/BoxSessionRelay.ts")
);
const { BoxCommands } = await import(Path.join(SERVER_SRC, "box/Services/BoxCommands.ts"));
const { BoxSession } = await import(Path.join(SERVER_SRC, "box/Services/BoxSession.ts"));
const cliOutput = await import(Path.join(SERVER_SRC, "box/cliOutput.ts"));
const { BoxCommandJournalRepositoryLive } = await import(
  Path.join(SERVER_SRC, "persistence/Layers/BoxCommandJournal.ts")
);
const { AccountMachineRepositoryLive } = await import(
  Path.join(SERVER_SRC, "persistence/Layers/AccountMachines.ts")
);
const { EnvironmentRelayBindingRepositoryLive } = await import(
  Path.join(SERVER_SRC, "persistence/Layers/EnvironmentRelayBindings.ts")
);
const { layerConfig: SqlitePersistenceLayerLive } = await import(
  Path.join(SERVER_SRC, "persistence/Layers/Sqlite.ts")
);

// ── the noise this script makes ──────────────────────────────────────────────

let step = 0;
const heading = (title) => {
  step += 1;
  console.log(`\n[1m${step}. ${title}[0m`);
};
const say = (line) => console.log(`   ${line}`);
const show = (text) => {
  for (const line of String(text).trimEnd().split("\n")) console.log(`   │ ${line}`);
};

const failures = [];
const check = (label, ok, detail) => {
  if (ok) {
    console.log(`   [32m✓[0m ${label}`);
    return true;
  }
  failures.push(label);
  console.log(`   [31m✗[0m ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  return false;
};

// ── small helpers ────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = Net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

const waitFor = async (label, attempt, { tries = 100, everyMs = 200 } = {}) => {
  for (let index = 0; index < tries; index += 1) {
    const outcome = await attempt().catch(() => null);
    if (outcome !== null && outcome !== false && outcome !== undefined) return outcome;
    await sleep(everyMs);
  }
  throw new Error(`Gave up waiting for ${label}.`);
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};

/** Runs `t3 …` in its own process, exactly as a person would. */
const t3 = (args, { stdin, env } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn("bun", [BIN, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`t3 ${args.join(" ")} exited ${code}\n${stderr}`));
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

const api = async (base, path, { method = "GET", token, body } = {}) => {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }
  return { status: response.status, payload };
};

// ── the run ──────────────────────────────────────────────────────────────────

const runtimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);
const cleanups = [];
const root = await Fs.mkdtemp(Path.join(Os.tmpdir(), "t3-box-relay-e2e-"));
const hubDir = Path.join(root, "hub");
const boxDir = Path.join(root, "box");
const workDir = Path.join(root, "work");
await Fs.mkdir(workDir, { recursive: true });

/**
 * A process the box did not start, so there is something on the machine that is
 * genuinely not T3's to touch. This is the stand-in for the user's production
 * database sitting next to whatever the agent deployed.
 */
const strangerScript = Path.join(workDir, "stranger.js");
await Fs.writeFile(
  strangerScript,
  `require("node:http")\n  .createServer((_, response) => response.end("stranger"))\n  .listen(Number(process.argv[2]), "127.0.0.1");\n`,
);
const ourScript = Path.join(workDir, "ours.js");
await Fs.writeFile(
  ourScript,
  `const port = Number(process.argv[2]);\nconsole.log("ours listening on " + port);\nrequire("node:http")\n  .createServer((_, response) => response.end("ours"))\n  .listen(port, "127.0.0.1");\n`,
);

const finish = async (code) => {
  for (const cleanup of cleanups.toReversed()) {
    await cleanup().catch(() => {});
  }
  if (code !== 0) {
    // The box is another process; without its log a failure here says only that
    // nothing happened, which is the least useful true sentence available.
    const log = await Fs.readFile(Path.join(root, "box.log"), "utf8").catch(() => "");
    if (log.trim().length > 0) {
      console.log("\n--- box server log (tail) ---");
      console.log(log.split("\n").slice(-60).join("\n"));
    }
  }
  if (process.env["T3_E2E_KEEP"] === undefined) {
    await Fs.rm(root, { recursive: true, force: true }).catch(() => {});
  } else {
    console.log(`\nState kept in ${root}`);
  }
  process.exit(code);
};

try {
  const hubPort = await freePort();
  const boxPort = await freePort();
  const strangerPort = await freePort();
  const oursPort = await freePort();
  const hubBase = `http://127.0.0.1:${hubPort}`;

  heading("Start the hub, in this process, because that is where the relay lives");
  const hubConfig = await Effect.runPromise(
    resolveServerConfig(
      {
        mode: Option.some("web"),
        port: Option.some(hubPort),
        host: Option.some("127.0.0.1"),
        baseDir: Option.some(hubDir),
        cwd: Option.some(workDir),
        devUrl: Option.none(),
        hub: Option.none(),
        noBrowser: Option.some(true),
        unsafeNoAuth: Option.none(),
        bootstrapFd: Option.none(),
        autoBootstrapProjectFromCwd: Option.some(false),
        logWebSocketEvents: Option.none(),
      },
      Option.none(),
      { startupPresentation: "headless" },
    ).pipe(Effect.scoped, Effect.provide(runtimeLayer)),
  );

  const hubFiber = Effect.runFork(
    runServer.pipe(
      Effect.provideService(ServerConfig, hubConfig),
      Effect.scoped,
      Effect.provide(runtimeLayer),
    ),
  );
  cleanups.push(() => Effect.runPromise(Fiber.interrupt(hubFiber)));
  await waitFor("the hub to listen", async () => {
    const { status } = await api(hubBase, "/api/environments/relay/links");
    return status > 0;
  });
  say(`hub on ${hubBase} (state in ${hubDir})`);

  heading("Enroll the box as a machine on an account, the way a real one does");
  const approver = await t3([
    "auth",
    "session",
    "issue",
    "--base-dir",
    hubDir,
    "--role",
    "owner",
    "--subject",
    "e2e-owner",
    "--token-only",
  ]);
  const created = await api(hubBase, "/api/devices/enrollments", {
    method: "POST",
    body: { deviceLabel: "e2e-box", devicePlatform: "local" },
  });
  const code = created.payload.code;
  await api(hubBase, `/api/devices/enrollments/${code}/approve`, {
    method: "POST",
    token: approver,
    body: { machineRole: "runner" },
  });
  const collected = await api(hubBase, `/api/devices/enrollments/${code}/collect`, {
    method: "POST",
  });
  check(
    "the hub issued the box a machine credential",
    typeof collected.payload.sessionToken === "string",
  );
  await t3(["secret", "set", "hub-session-token", "--base-dir", boxDir], {
    stdin: collected.payload.sessionToken,
  });
  say(`credential stored in ${boxDir}/userdata/secrets`);

  heading("Start the box with --hub, and watch it dial out");
  const boxLogPath = Path.join(root, "box.log");
  const boxLog = await Fs.open(boxLogPath, "a");
  const startBox = async () => {
    const child = spawn(
      "bun",
      [BIN, "serve", "--base-dir", boxDir, "--port", String(boxPort), "--hub", hubBase, workDir],
      { cwd: ROOT, env: process.env, stdio: ["ignore", boxLog.fd, boxLog.fd] },
    );
    return child;
  };
  let box = await startBox();
  cleanups.push(async () => {
    box.kill("SIGKILL");
    await boxLog.close().catch(() => {});
  });

  const link = await waitFor(
    "the box to connect and be healthy",
    async () => {
      const { payload } = await api(hubBase, "/api/environments/relay/links", { token: approver });
      const found = (payload.environments ?? []).find((entry) => entry.state === "connected");
      return found ?? false;
    },
    { tries: 200 },
  );
  const environmentId = link.environmentId;
  // What `resolveAuthenticatedUserId` makes of a bearer session with no tenant
  // claim on it: the subject, namespaced. The links route does not echo it, and
  // deriving it the same way the hub does is better than guessing.
  const actorUserId = "auth:e2e-owner";
  check(
    "the hub reports the link as connected, not merely socket-open",
    link.state === "connected",
  );
  say(`environment ${environmentId}, owned by ${actorUserId}`);

  // The layer stack `t3 box` builds, over the hub's own database.
  const sessionLayer = BoxSessionRelayLive.pipe(
    Layer.provide(
      EnvironmentRelayBindingRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive)),
    ),
    Layer.provide(AccountMachineRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive))),
  );
  // `provideMerge` rather than `provide` for the session, because one step below
  // reaches past `BoxCommands` and calls `BoxSession.signal` directly — which is
  // the whole point of that step.
  const boxLayer = BoxCommandsLive.pipe(
    Layer.provideMerge(sessionLayer),
    Layer.provide(BoxCommandJournalRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive))),
    Layer.provide(Layer.succeed(ServerConfig, hubConfig)),
  );
  const drive = (use) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const commands = yield* BoxCommands;
        const session = yield* BoxSession;
        return yield* use({ commands, session });
      }).pipe(Effect.provide(boxLayer), Effect.provide(runtimeLayer), Effect.scoped),
    );
  const caller = { environmentId, userId: actorUserId, turnId: null };

  heading("Start something the box did not start, next to it");
  const stranger = spawn("node", [strangerScript, String(strangerPort)], {
    cwd: workDir,
    detached: true,
    stdio: "ignore",
  });
  stranger.unref();
  cleanups.push(async () => {
    try {
      process.kill(stranger.pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  });
  await waitFor("the stranger to bind", async () => {
    const response = await fetch(`http://127.0.0.1:${strangerPort}/`).catch(() => null);
    return response !== null;
  });
  say(`a stranger's process is pid ${stranger.pid} on port ${strangerPort}`);

  heading("`t3 box run` — a real command, a real exit code");
  const ran = await drive(({ commands }) =>
    commands.run({ ...caller, command: "echo hello-from-the-box && exit 7", detach: false }),
  );
  show(cliOutput.formatBoxRun(ran));
  check("a foreground run reports the real exit code", ran.exitCode === 7, `got ${ran.exitCode}`);
  check(
    "a foreground run brings back its output",
    ran.stdout.text.includes("hello-from-the-box"),
    JSON.stringify(ran.stdout.text),
  );

  heading("`t3 box services` — real listeners, from the real probe");
  const listedBefore = await drive(({ commands }) => commands.services(caller));
  show(cliOutput.formatBoxServices(listedBefore));
  check(
    "the probe named a tool that can attribute processes",
    listedBefore.probe.processAttribution === true,
    listedBefore.probe.tool,
  );
  const strangerRow = listedBefore.services.find((entry) => entry.port === strangerPort);
  check(
    "the stranger's process is listed, and as not ours",
    strangerRow !== undefined && strangerRow.ownership === "not-ours",
    JSON.stringify(strangerRow),
  );

  heading("`t3 box run --detach` — something that has to still be serving tomorrow");
  const detached = await drive(({ commands }) =>
    commands.run({ ...caller, command: `node ${ourScript} ${oursPort}`, detach: true }),
  );
  show(cliOutput.formatBoxRun(detached));
  check("a detached start hands back a pid", typeof detached.detachedPid === "number");
  const listedAfter = await drive(({ commands }) => commands.services(caller));
  const oursRow = listedAfter.services.find((entry) => entry.port === oursPort);
  check(
    "the detached process is listed as ours",
    oursRow !== undefined && oursRow.ownership === "ours" && oursRow.canManage === true,
    JSON.stringify(oursRow),
  );

  heading("`t3 box logs` — the output the box captured while nothing was watching");
  const logs = await drive(({ commands }) =>
    commands.logs({ ...caller, target: String(oursPort) }),
  );
  show(cliOutput.formatBoxLogs(logs));
  check(
    "the detached process's own output came back",
    logs.outcome === "logs" && logs.output.text.includes(`ours listening on ${oursPort}`),
    JSON.stringify(logs),
  );

  heading("The connection ends — and the process does not");
  box.kill("SIGTERM");
  await waitFor("the box server to exit", async () => box.exitCode !== null || box.killed);
  await sleep(1_000);
  check(
    "the detached process outlived the box server that started it",
    alive(detached.detachedPid),
    `pid ${detached.detachedPid}`,
  );
  const stillServing = await fetch(`http://127.0.0.1:${oursPort}/`).catch(() => null);
  check("and it is still serving", stillServing !== null && stillServing.status === 200);

  heading("The box comes back, and the process is still findable");
  box = await startBox();
  await waitFor(
    "the box to reconnect",
    async () => {
      const { payload } = await api(hubBase, "/api/environments/relay/links", { token: approver });
      return (payload.environments ?? []).some(
        (entry) => entry.environmentId === environmentId && entry.state === "connected",
      );
    },
    { tries: 200 },
  );
  const listedAfterRestart = await drive(({ commands }) => commands.services(caller));
  show(cliOutput.formatBoxServices(listedAfterRestart));
  const survivor = listedAfterRestart.services.find((entry) => entry.port === oursPort);
  check(
    "after a restart the box still knows the process is its own",
    survivor !== undefined &&
      survivor.ownership === "ours" &&
      survivor.pid === detached.detachedPid,
    JSON.stringify(survivor),
  );

  heading("`t3 box stop` on somebody else's process — refused by the caller");
  const refusedByCaller = await drive(({ commands }) =>
    commands.stop({ ...caller, target: String(strangerPort), acknowledgedTarget: null }),
  );
  show(cliOutput.formatBoxRefusal(refusedByCaller));
  check(
    "the caller-side rule refuses first",
    refusedByCaller.outcome === "refused" && refusedByCaller.refusal.reason === "service-not-ours",
    JSON.stringify(refusedByCaller),
  );
  check("and the stranger is untouched", alive(stranger.pid));

  heading("The same thing with the caller-side rule bypassed — refused by the box");
  // Straight at `BoxSession.signal`, which is the call `decideBoxCommand` guards.
  // This is what a caller that skipped the check — a different build, a
  // compromised hub, something written by somebody who did not read the rules —
  // puts on the wire, and the box is the only thing left in its way.
  const refusedByBox = await drive(({ session }) =>
    session
      .signal({
        environmentId,
        userId: actorUserId,
        pid: stranger.pid,
        signal: "SIGTERM",
        acknowledgedTarget: null,
      })
      .pipe(
        Effect.map((signalled) => ({ outcome: "signalled", signalled })),
        Effect.catch((error) => Effect.succeed({ outcome: "refused", error })),
      ),
  );
  show(
    refusedByBox.outcome === "refused"
      ? `${refusedByBox.error.code}: ${refusedByBox.error.message}`
      : `the box signalled it (${refusedByBox.signalled})`,
  );
  check(
    "the box refused it on its own, from its own registry",
    refusedByBox.outcome === "refused" && refusedByBox.error.code === "refused",
    JSON.stringify(refusedByBox),
  );
  await sleep(500);
  check("and the stranger is still alive", alive(stranger.pid));
  const strangerStillServing = await fetch(`http://127.0.0.1:${strangerPort}/`).catch(() => null);
  check("and still serving", strangerStillServing !== null);

  heading("`t3 box stop` on something the box did start — allowed");
  const stopped = await drive(({ commands }) =>
    commands.stop({ ...caller, target: String(oursPort), acknowledgedTarget: null }),
  );
  show(cliOutput.formatBoxStop(stopped));
  await sleep(700);
  check(
    "the box's own process was stopped",
    stopped.outcome === "stopped" && stopped.signalled === true && !alive(detached.detachedPid),
    JSON.stringify(stopped),
  );

  heading("`t3 box port` — a reservation taken and given back");
  const claimed = await drive(({ commands }) =>
    commands.claimPort({ ...caller, port: oursPort, purpose: "the e2e's next server" }),
  );
  check("a port was reserved on the box", claimed.held === true, JSON.stringify(claimed));
  const released = await drive(({ commands }) =>
    commands.releasePort({ ...caller, port: oursPort }),
  );
  check("and released again", released.outcome === "port", JSON.stringify(released));

  heading("`t3 box history` — what the journal recorded, including the refusals");
  const history = await drive(({ commands }) => commands.history({ ...caller, limit: 20 }));
  show(cliOutput.formatBoxHistory(history));
  check(
    "the caller-side refusal is in the journal",
    history.entries.some((entry) => entry.refusalReason === "service-not-ours"),
  );

  console.log("");
  if (failures.length === 0) {
    console.log("[32mAll checks passed.[0m");
    await finish(0);
  } else {
    console.log(`[31m${failures.length} check(s) failed:[0m`);
    for (const failure of failures) console.log(`  - ${failure}`);
    console.log(`\nBox server log: ${boxLogPath}`);
    await finish(1);
  }
} catch (error) {
  console.error("\n[31mThe run did not finish.[0m");
  console.error(error);
  await finish(1);
}
