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
 * dispatched from is the process the box dialled into.
 *
 * Everything asking it to is a **real `t3` process**. Every verb below is
 * `bun bin.ts box …` spawned as a child with its own base directory — no
 * database, no relay registry, nothing but a hub address and a credential — and
 * what is asserted is that child's exit status and the JSON it printed. That is
 * the thing that could not be faked: the previous run of this script drove
 * `BoxCommands` in-process because a shell could not reach a box at all, and a
 * subprocess that comes back with the right exit code is the only proof the gap
 * is shut.
 *
 * Two steps are still in-process, and both are on purpose:
 *
 *   - the hub, for the reason above;
 *   - the one step that puts a `signal` on the wire *without* going through
 *     `decideBoxCommand`. That is the whole point of it — a real CLI cannot
 *     construct that request, because the caller-side rules are in front of it,
 *     and what is being proved is that a caller which skipped them is still
 *     refused by the machine that owns the process.
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
const { BoxSessionRelayLive } = await import(
  Path.join(SERVER_SRC, "box/Layers/BoxSessionRelay.ts")
);
const { BoxSession } = await import(Path.join(SERVER_SRC, "box/Services/BoxSession.ts"));
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

/**
 * Runs `t3 …` in its own process and hands back everything about how it went.
 *
 * The exit status is a result here rather than a throw, because half of what is
 * being checked below is a refusal — and a refusal exits non-zero on purpose, so
 * that a script cannot read "declined to stop your database" as "stopped".
 */
const t3Raw = (args, { stdin, env } = {}) =>
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
    child.once("close", (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });

/** The same, for the setup steps where a non-zero exit means the run is over. */
const t3 = async (args, options) => {
  const { code, stdout, stderr } = await t3Raw(args, options);
  if (code !== 0) throw new Error(`t3 ${args.join(" ")} exited ${code}\n${stderr}`);
  return stdout;
};

/**
 * The JSON object a command printed, out of everything else on the stream.
 *
 * `--json` output and the log line for a non-zero exit share stdout, so this
 * takes the block between a line that is exactly `{` and the next line that is
 * exactly `}` — which is what `JSON.stringify(value, null, 2)` produces and
 * nothing nested inside it does.
 */
const asJson = (text) => {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trimEnd() === "{");
  if (start < 0) return null;
  const end = lines.findIndex((line, index) => index > start && line.trimEnd() === "}");
  if (end < 0) return null;
  try {
    return JSON.parse(lines.slice(start, end + 1).join("\n"));
  } catch {
    return null;
  }
};

/** The one sentence a failed `t3` command ends with, whichever stream it took. */
const failureSentence = ({ stdout, stderr }) => {
  const found = /Error: (.*)/.exec(`${stdout}\n${stderr}`);
  return found === null ? "" : found[1].trim();
};

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

  /**
   * `t3 box …`, as a person types it, in its own process.
   *
   * `--base-dir cliDir` is a directory this script created and never wrote a
   * database into, which is the point: the CLI carries no relay registry and no
   * journal, and everything it needs to drive somebody's server is an address
   * and a credential. `--hub` and `T3CODE_HUB_TOKEN` supply exactly those.
   */
  const cliDir = Path.join(root, "cli");
  const boxCli = (args, { token = approver, useStoredToken = false } = {}) => {
    const full = ["box", ...args, "--base-dir", cliDir, "--hub", hubBase];
    return t3Raw(full, { env: useStoredToken ? {} : { T3CODE_HUB_TOKEN: token } });
  };

  /**
   * The one thing a real CLI cannot do, in this process on purpose.
   *
   * `decideBoxCommand` runs in front of every verb, so a `t3 box stop` can never
   * put a refused signal on the wire — which is exactly why the box's own check
   * has to be proved some other way. This is the shape of a caller that skipped
   * the rules: a different build, a compromised hub, something written by
   * somebody who never read them.
   */
  const sessionLayer = BoxSessionRelayLive.pipe(
    Layer.provide(
      EnvironmentRelayBindingRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive)),
    ),
    Layer.provide(AccountMachineRepositoryLive.pipe(Layer.provide(SqlitePersistenceLayerLive))),
  );
  const driveSession = (use) =>
    Effect.runPromise(
      Effect.gen(function* () {
        return yield* use(yield* BoxSession);
      }).pipe(
        Effect.provide(sessionLayer.pipe(Layer.provide(Layer.succeed(ServerConfig, hubConfig)))),
        Effect.provide(runtimeLayer),
        Effect.scoped,
      ),
    );

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

  heading("`t3 box run` — a real CLI process, a real command, a real exit code");
  const ranOut = await boxCli([
    "run",
    environmentId,
    "--json",
    "echo hello-from-the-box && exit 7",
  ]);
  show(ranOut.stdout);
  const ran = asJson(ranOut.stdout);
  check(
    "a `t3 box run` typed at a shell reached the box at all",
    ranOut.code === 0 && ran !== null,
    `exit ${ranOut.code}: ${ranOut.stderr || ranOut.stdout}`,
  );
  check(
    "and brought back the command's real exit code",
    ran?.exitCode === 7,
    `got ${JSON.stringify(ran?.exitCode)}`,
  );
  check(
    "and the command's real output",
    ran?.stdout?.text?.includes("hello-from-the-box") === true,
    JSON.stringify(ran?.stdout?.text),
  );

  heading("`t3 box services` — real listeners, from the real probe");
  const listedOut = await boxCli(["services", environmentId, "--json"]);
  const listedBefore = asJson(listedOut.stdout);
  check(
    "the probe named a tool that can attribute processes",
    listedBefore?.probe?.processAttribution === true,
    `exit ${listedOut.code}: ${listedBefore?.probe?.tool ?? listedOut.stderr}`,
  );
  const strangerRow = (listedBefore?.services ?? []).find((entry) => entry.port === strangerPort);
  check(
    "the stranger's process is listed, and as not ours",
    strangerRow !== undefined && strangerRow.ownership === "not-ours",
    JSON.stringify(strangerRow),
  );

  heading("The credential can live in the secret store instead of the environment");
  // The same verb, with nothing in the environment at all: the token comes off
  // disk from the store `t3 secret set` writes, which is how a machine that does
  // this regularly is configured.
  await t3(["secret", "set", "hub-session-token", "--base-dir", cliDir], { stdin: approver });
  const storedOut = await boxCli(["services", environmentId, "--json"], { useStoredToken: true });
  check(
    "`t3 box` finds its credential in the secret store",
    storedOut.code === 0 && asJson(storedOut.stdout)?.probe !== undefined,
    `exit ${storedOut.code}: ${storedOut.stderr}`,
  );

  heading("`t3 box run --detach` — something that has to still be serving tomorrow");
  const detachedOut = await boxCli([
    "run",
    environmentId,
    "--json",
    "--detach",
    `node ${ourScript} ${oursPort}`,
  ]);
  show(detachedOut.stdout);
  const detached = asJson(detachedOut.stdout);
  check(
    "a detached start hands back a pid",
    typeof detached?.detachedPid === "number",
    `exit ${detachedOut.code}: ${detachedOut.stderr}`,
  );
  const listedAfter = asJson((await boxCli(["services", environmentId, "--json"])).stdout);
  const oursRow = (listedAfter?.services ?? []).find((entry) => entry.port === oursPort);
  check(
    "the detached process is listed as ours",
    oursRow !== undefined && oursRow.ownership === "ours" && oursRow.canManage === true,
    JSON.stringify(oursRow),
  );

  heading("`t3 box logs` — the output the box captured while nothing was watching");
  const logsOut = await boxCli(["logs", environmentId, String(oursPort), "--json"]);
  const logs = asJson(logsOut.stdout);
  check(
    "the detached process's own output came back",
    logs?.output?.text?.includes(`ours listening on ${oursPort}`) === true,
    `exit ${logsOut.code}: ${logsOut.stderr || logsOut.stdout}`,
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
  const listedAfterRestart = asJson((await boxCli(["services", environmentId, "--json"])).stdout);
  const survivor = (listedAfterRestart?.services ?? []).find((entry) => entry.port === oursPort);
  check(
    "after a restart the box still knows the process is its own",
    survivor !== undefined &&
      survivor.ownership === "ours" &&
      survivor.pid === detached.detachedPid,
    JSON.stringify(survivor),
  );

  heading("`t3 box stop` on somebody else's process — refused, and non-zero");
  const refusedOut = await boxCli(["stop", environmentId, String(strangerPort), "--json"]);
  show(refusedOut.stdout);
  const refusedByCaller = asJson(refusedOut.stdout);
  check(
    "the refusal comes back through the hub with its reason intact",
    refusedByCaller?.refused === true && refusedByCaller?.reason === "service-not-ours",
    JSON.stringify(refusedByCaller),
  );
  check(
    "and the CLI exits non-zero, so a script cannot read it as a stop",
    refusedOut.code !== 0,
    `exit ${refusedOut.code}`,
  );
  check("and the stranger is untouched", alive(stranger.pid));

  heading("The same thing with the caller-side rule bypassed — refused by the box");
  // IN-PROCESS ON PURPOSE. Straight at `BoxSession.signal`, which is the call
  // `decideBoxCommand` guards — and which no `t3 box stop` can reach past, since
  // the caller-side rules run in front of it. This is what a caller that skipped
  // them puts on the wire: a different build, a compromised hub, something
  // written by somebody who never read them. The box is the only thing left in
  // its way, and it is the one that has to say no.
  const refusedByBox = await driveSession((session) =>
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
  const stoppedOut = await boxCli(["stop", environmentId, String(oursPort), "--json"]);
  show(stoppedOut.stdout);
  const stopped = asJson(stoppedOut.stdout);
  await sleep(700);
  check(
    "the box's own process was stopped",
    stoppedOut.code === 0 && stopped?.signalled === true && !alive(detached.detachedPid),
    `exit ${stoppedOut.code}: ${JSON.stringify(stopped)}`,
  );

  heading("`t3 box port` — a reservation taken and given back");
  const claimedOut = await boxCli([
    "port",
    "claim",
    environmentId,
    String(oursPort),
    "--json",
    "--purpose",
    "the e2e's next server",
  ]);
  check(
    "a port was reserved on the box",
    asJson(claimedOut.stdout)?.held === true,
    `exit ${claimedOut.code}: ${claimedOut.stdout || claimedOut.stderr}`,
  );
  const releasedOut = await boxCli(["port", "release", environmentId, String(oursPort), "--json"]);
  check(
    "and released again",
    releasedOut.code === 0 && asJson(releasedOut.stdout)?.outcome === "port",
    `exit ${releasedOut.code}: ${releasedOut.stdout || releasedOut.stderr}`,
  );

  heading("`t3 box history` — what the journal recorded, including the refusals");
  const historyOut = await boxCli(["history", environmentId, "--json", "--limit", "20"]);
  const history = asJson(historyOut.stdout);
  check(
    "the refusal is in the journal, filed under the account that asked",
    (history?.entries ?? []).some((entry) => entry.refusalReason === "service-not-ours"),
    `exit ${historyOut.code}: ${historyOut.stderr}`,
  );

  heading("Somebody else's session — a 404, and the same sentence for both reasons");
  const strangerToken = await t3([
    "auth",
    "session",
    "issue",
    "--base-dir",
    hubDir,
    "--role",
    "owner",
    "--subject",
    "e2e-someone-else",
    "--token-only",
  ]);
  const crossAccount = await boxCli(["services", environmentId, "--json"], {
    token: strangerToken,
  });
  const madeUp = await boxCli(["services", "a-name-nobody-claimed", "--json"], {
    token: strangerToken,
  });
  show(`${failureSentence(crossAccount)}\n${failureSentence(madeUp)}`);
  check(
    "a session from another account cannot list this box",
    crossAccount.code !== 0 && /not connected to your account/.test(failureSentence(crossAccount)),
    `exit ${crossAccount.code}: ${failureSentence(crossAccount)}`,
  );
  check(
    "and cannot tell a real box from an invented one",
    failureSentence(crossAccount).length > 0 &&
      failureSentence(crossAccount) === failureSentence(madeUp),
    `${JSON.stringify(failureSentence(crossAccount))} vs ${JSON.stringify(failureSentence(madeUp))}`,
  );

  heading("No credential at all — said in words, before anything is reached");
  const anonymous = await t3Raw([
    "box",
    "services",
    environmentId,
    "--base-dir",
    Path.join(root, "empty-cli"),
    "--hub",
    hubBase,
  ]);
  show(failureSentence(anonymous));
  check(
    "a shell with no session is told what it needs, not what went wrong",
    anonymous.code !== 0 && /No credential to drive a box with/.test(failureSentence(anonymous)),
    `exit ${anonymous.code}: ${failureSentence(anonymous)}`,
  );

  heading("Disconnect the machine in the browser — and the shell stops working");
  const { payload: machineList } = await api(hubBase, "/api/devices/machines", {
    token: approver,
  });
  const enrolled = (machineList.machines ?? []).find((entry) => entry.label === "e2e-box");
  const revoked = await api(hubBase, `/api/devices/machines/${enrolled?.machineId}/revoke`, {
    method: "POST",
    token: approver,
  });
  check("the machine was disconnected over the real route", revoked.status === 200, revoked.status);
  const afterRevoke = await boxCli(["run", environmentId, "--json", "echo still-here"]);
  show(afterRevoke.stdout || afterRevoke.stderr);
  check(
    "a revoked machine refuses the verbs, through the same hook and no other",
    afterRevoke.code !== 0 && asJson(afterRevoke.stdout)?.reason === "machine-revoked",
    `exit ${afterRevoke.code}: ${afterRevoke.stdout || afterRevoke.stderr}`,
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
