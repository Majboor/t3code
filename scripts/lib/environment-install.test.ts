import { assert, describe, it } from "@effect/vitest";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  compareInstallVersions,
  conflictIsOwnService,
  decideEnrollmentPoll,
  describeEnvironmentInstallAvailability,
  detectInstallPlatform,
  ENROLLMENT_POLL_INTERVAL_MS,
  ENROLLMENT_TTL_MS,
  ENVIRONMENT_BUN_VERSION,
  ENVIRONMENT_DATA_DIR,
  ENVIRONMENT_DEFAULT_PORT,
  ENVIRONMENT_INSTALL_BASE_URL,
  ENVIRONMENT_PREFIX,
  ENVIRONMENT_SERVER_VERSION,
  ENVIRONMENT_SERVICE_USER,
  ENVIRONMENT_UNIT_MARKER,
  ENVIRONMENT_UNIT_NAME,
  ENVIRONMENT_UNIT_PATH,
  environmentInstallCommandLine,
  findPortConflict,
  parseListeningSockets,
  planInstallAction,
  readInstallerShellConstants,
  readInstallerShellFunction,
  resolveEnvironmentServerTarballUrl,
} from "./environment-install.ts";

const INSTALLER_PATH = path.resolve(import.meta.dirname, "../../infra/install/t3-environment.sh");

describe("detectInstallPlatform", () => {
  it("accepts the two Linux architectures there are builds for", () => {
    const x64 = detectInstallPlatform({ kernel: "Linux", machine: "x86_64", hasSystemd: true });
    assert.deepStrictEqual(x64, { supported: true, arch: "x64", bunAsset: "bun-linux-x64" });

    const arm = detectInstallPlatform({ kernel: "Linux", machine: "aarch64", hasSystemd: true });
    assert.deepStrictEqual(arm, {
      supported: true,
      arch: "aarch64",
      bunAsset: "bun-linux-aarch64",
    });
  });

  it("treats arm64 and aarch64 as the same machine", () => {
    // Some Linux userlands report `arm64` where others report `aarch64` on
    // identical silicon. Refusing one of them would decline to install on
    // hardware that is fully supported.
    const reported = detectInstallPlatform({ kernel: "Linux", machine: "arm64", hasSystemd: true });
    assert.deepStrictEqual(reported, {
      supported: true,
      arch: "aarch64",
      bunAsset: "bun-linux-aarch64",
    });
  });

  it("refuses 32-bit ARM rather than rounding it up to aarch64", () => {
    // The tempting bug: `armv7l` contains "arm", so a loose match maps it to the
    // 64-bit asset and downloads a binary the kernel cannot execute.
    const decision = detectInstallPlatform({
      kernel: "Linux",
      machine: "armv7l",
      hasSystemd: true,
    });

    assert.strictEqual(decision.supported, false);
    assert.include(decision.supported === false ? decision.reason : "", "armv7l");
  });

  it("tells a Mac user they are on a Mac, not about their CPU", () => {
    // Order matters: an Apple Silicon Mac reports `arm64`, which is a supported
    // architecture. If architecture were checked first this would pass the arch
    // gate and fail somewhere far less legible.
    const decision = detectInstallPlatform({
      kernel: "Darwin",
      machine: "arm64",
      hasSystemd: false,
    });

    assert.strictEqual(decision.supported, false);
    const reason = decision.supported === false ? decision.reason : "";
    assert.include(reason, "macOS");
    assert.include(reason, "t3 serve");
    assert.notInclude(reason, "arm64");
  });

  it("names the BSD it found instead of saying 'unsupported platform'", () => {
    const decision = detectInstallPlatform({
      kernel: "FreeBSD",
      machine: "x86_64",
      hasSystemd: false,
    });

    assert.strictEqual(decision.supported, false);
    assert.include(decision.supported === false ? decision.reason : "", "FreeBSD");
  });

  it("recognises a Windows shell environment and points at WSL2", () => {
    const decision = detectInstallPlatform({
      kernel: "MINGW64_NT-10.0",
      machine: "x86_64",
      hasSystemd: false,
    });

    assert.strictEqual(decision.supported, false);
    assert.include(decision.supported === false ? decision.reason : "", "WSL2");
  });

  it("refuses a supported architecture when systemd is not the running init", () => {
    // The plain-container case. Every other signal says this machine is fine;
    // only the absent /run/systemd/system says the unit would never start.
    const decision = detectInstallPlatform({
      kernel: "Linux",
      machine: "x86_64",
      hasSystemd: false,
    });

    assert.strictEqual(decision.supported, false);
    const reason = decision.supported === false ? decision.reason : "";
    assert.include(reason, "systemd");
    assert.include(reason, "Nothing was installed");
  });

  it("says so when uname produced nothing at all", () => {
    const decision = detectInstallPlatform({ kernel: "", machine: "", hasSystemd: true });

    assert.strictEqual(decision.supported, false);
    assert.include(decision.supported === false ? decision.reason : "", "uname");
  });
});

describe("compareInstallVersions", () => {
  it("compares numerically, not as strings", () => {
    // The bug this exists to prevent: "0.0.9" > "0.0.10" as strings, so a
    // string comparison turns the upgrade a person asked for into a refused
    // downgrade.
    assert.strictEqual(compareInstallVersions("0.0.9", "0.0.10"), -1);
    assert.strictEqual(compareInstallVersions("0.0.10", "0.0.9"), 1);
    assert.strictEqual(compareInstallVersions("0.1.0", "0.0.99"), 1);
  });

  it("reads a missing segment as zero", () => {
    assert.strictEqual(compareInstallVersions("0.1", "0.1.0"), 0);
    assert.strictEqual(compareInstallVersions("1", "1.0.0"), 0);
    assert.strictEqual(compareInstallVersions("1.0.0.1", "1.0.0"), 1);
  });

  it("ignores a leading v", () => {
    assert.strictEqual(compareInstallVersions("v0.0.20", "0.0.20"), 0);
  });

  it("sorts a prerelease before the release it leads to", () => {
    // SemVer's rule, and also the only reading under which rc -> release is an
    // upgrade rather than a downgrade the installer refuses to perform.
    assert.strictEqual(compareInstallVersions("0.1.0-rc.1", "0.1.0"), -1);
    assert.strictEqual(compareInstallVersions("0.1.0", "0.1.0-rc.1"), 1);
    assert.strictEqual(compareInstallVersions("0.1.0-rc.1", "0.1.0-rc.2"), -1);
    assert.strictEqual(compareInstallVersions("0.1.0-rc.1", "0.1.0-rc.1"), 0);
  });

  it("does not blow up on a garbage segment", () => {
    // A VERSION file can be truncated or hand-edited. Whatever this returns,
    // it must return something rather than producing NaN comparisons that make
    // every branch of planInstallAction false.
    assert.strictEqual(compareInstallVersions("0.0.abc", "0.0.0"), 0);
  });
});

describe("planInstallAction", () => {
  it("installs when nothing is there", () => {
    const decision = planInstallAction({ installed: null, requested: "0.0.20" });
    assert.strictEqual(decision.action, "install");
  });

  it("upgrades in place", () => {
    const decision = planInstallAction({ installed: "0.0.19", requested: "0.0.20" });
    assert.strictEqual(decision.action, "upgrade");
    assert.include(decision.message, "0.0.19");
    assert.include(decision.message, "0.0.20");
  });

  it("reinstalls the same version rather than doing nothing", () => {
    // The commonest reason somebody pastes the line twice is that the first run
    // left something broken. A no-op there is a script that refuses to fix the
    // problem it caused.
    const decision = planInstallAction({ installed: "0.0.20", requested: "0.0.20" });
    assert.strictEqual(decision.action, "reinstall");
    assert.include(decision.message, "Data is untouched");
  });

  it("refuses to go backwards, and says how to override", () => {
    // The newer server has already migrated the data directory; pointing an
    // older one at it is how a database gets damaged.
    const decision = planInstallAction({ installed: "0.1.0", requested: "0.0.20" });
    assert.strictEqual(decision.action, "refuse-downgrade");
    assert.include(decision.message, "--uninstall");
  });
});

describe("parseListeningSockets", () => {
  const SS_OUTPUT = [
    'LISTEN 0      4096   127.0.0.1:3773       0.0.0.0:*    users:(("bun",pid=1042,fd=21))',
    'LISTEN 0      511      0.0.0.0:80          0.0.0.0:*    users:(("apache2",pid=812,fd=4))',
    'LISTEN 0      4096        [::]:22             [::]:*    users:(("sshd",pid=655,fd=4))',
    'LISTEN 0      4096   127.0.0.1:37730      0.0.0.0:*    users:(("grafana",pid=9001,fd=8))',
  ].join("\n");

  it("reads address, port and holder off each row", () => {
    const sockets = parseListeningSockets(SS_OUTPUT);

    assert.strictEqual(sockets.length, 4);
    assert.deepStrictEqual(sockets[0], {
      address: "127.0.0.1",
      port: 3773,
      process: "bun (pid 1042)",
      pid: 1042,
    });
  });

  it("never takes a port from the peer column", () => {
    // The quiet trap: every listening row's peer column is `0.0.0.0:*`, which
    // has a colon and digits in it. A parser that scans the whole line for
    // something port-shaped reports a collision on every box with any listener.
    const sockets = parseListeningSockets(SS_OUTPUT);

    assert.deepStrictEqual(
      sockets.map((socket) => socket.port),
      [3773, 80, 22, 37730],
    );
  });

  it("splits IPv6 on the last colon, not the first", () => {
    const sockets = parseListeningSockets(SS_OUTPUT);
    const ssh = sockets.find((socket) => socket.port === 22);

    assert.deepStrictEqual(ssh, { address: "::", port: 22, process: "sshd (pid 655)", pid: 655 });
  });

  it("keeps 37730 distinct from 3773", () => {
    // A prefix match would call these the same port and refuse to install
    // because of an unrelated service.
    const sockets = parseListeningSockets(SS_OUTPUT);

    assert.strictEqual(sockets.filter((socket) => socket.port === 3773).length, 1);
  });

  it("survives a header row and blank lines", () => {
    const sockets = parseListeningSockets(
      ["State Recv-Q Send-Q Local Address:Port Peer Address:Port", "", SS_OUTPUT, ""].join("\n"),
    );

    assert.strictEqual(sockets.length, 4);
  });

  it("reports a null holder rather than inventing one when ss ran without -p", () => {
    const sockets = parseListeningSockets("LISTEN 0 4096 0.0.0.0:3773 0.0.0.0:*");

    assert.deepStrictEqual(sockets[0], {
      address: "0.0.0.0",
      port: 3773,
      process: null,
      pid: null,
    });
  });
});

const listener = (
  address: string,
  port: number,
  process: string | null = null,
  pid: number | null = null,
) => ({ address, port, process, pid });

describe("findPortConflict", () => {
  it("finds nothing when the port is free", () => {
    const conflict = findPortConflict({
      port: 3773,
      host: "127.0.0.1",
      listeners: [listener("0.0.0.0", 80), listener("::", 22)],
    });

    assert.strictEqual(conflict, null);
  });

  it("returns the offender so the caller can name it", () => {
    // "Port 3773 is in use" starts an investigation. "held by apache2 (pid 812)"
    // ends one.
    const conflict = findPortConflict({
      port: 3773,
      host: "127.0.0.1",
      listeners: [listener("127.0.0.1", 3773, "apache2 (pid 812)")],
    });

    assert.deepStrictEqual(conflict, listener("127.0.0.1", 3773, "apache2 (pid 812)"));
  });

  it("does not confuse 3773 with 37730", () => {
    const conflict = findPortConflict({
      port: 3773,
      host: "0.0.0.0",
      listeners: [listener("127.0.0.1", 37730, "grafana")],
    });

    assert.strictEqual(conflict, null);
  });

  it("lets two specific addresses share a port", () => {
    // This is what makes the script usable on a busy host. A service already on
    // 10.0.0.5:3773 does not stop us binding 127.0.0.1:3773, and refusing here
    // would decline to install for no reason.
    const conflict = findPortConflict({
      port: 3773,
      host: "127.0.0.1",
      listeners: [listener("10.0.0.5", 3773, "someone-else")],
    });

    assert.strictEqual(conflict, null);
  });

  it("catches an existing wildcard when we want a specific address", () => {
    // bind(2) fails here, so the check must too — otherwise the install
    // "succeeds" and the unit crash-loops.
    const conflict = findPortConflict({
      port: 3773,
      host: "127.0.0.1",
      listeners: [listener("0.0.0.0", 3773, "t3code (pid 700)")],
    });

    assert.strictEqual(conflict?.process, "t3code (pid 700)");
  });

  it("catches an existing specific address when we want a wildcard", () => {
    const conflict = findPortConflict({
      port: 3773,
      host: "0.0.0.0",
      listeners: [listener("127.0.0.1", 3773, "t3code (pid 700)")],
    });

    assert.strictEqual(conflict?.process, "t3code (pid 700)");
  });

  it("sees through an IPv4-mapped IPv6 loopback address", () => {
    // A dual-stack listener on loopback is routinely reported this way. Treating
    // it as a different address is how a real collision gets missed.
    const conflict = findPortConflict({
      port: 3773,
      host: "127.0.0.1",
      listeners: [listener("::ffff:127.0.0.1", 3773, "bun (pid 1042)")],
    });

    assert.strictEqual(conflict?.process, "bun (pid 1042)");
  });
});

const socket = (pid: number | null) => ({
  address: "127.0.0.1",
  port: 3773,
  process: "bun",
  pid,
});

describe("conflictIsOwnService", () => {
  it("recognises our own running server, so an upgrade can proceed", () => {
    assert.isTrue(
      conflictIsOwnService({ conflict: socket(277), ownMainPid: 277, unitIsOurs: true }),
    );
  });

  it("refuses a stranger that grabbed the port while our service was stopped", () => {
    // The bug this was written for, found by running the installer for real: a
    // check that only asked "is there an install here" waved through any
    // process at all once an environment had ever been installed. The unit is
    // genuinely ours and a version is genuinely on disk — and the socket still
    // belongs to somebody else.
    assert.isFalse(
      conflictIsOwnService({ conflict: socket(421), ownMainPid: 277, unitIsOurs: true }),
    );
  });

  it("treats systemd's MainPID of 0 as 'not running', not as a match", () => {
    // An inactive unit reports 0. Nothing holds a socket under pid 0, so a
    // naive equality check would still be false here — but a check that merely
    // tested "MainPID is set" would call every conflict ours.
    assert.isFalse(
      conflictIsOwnService({ conflict: socket(421), ownMainPid: 0, unitIsOurs: true }),
    );
  });

  it("refuses when the pid is unknown, rather than assuming the best", () => {
    // ss without -p, or run unprivileged. Absence of evidence is not ownership,
    // and the safe direction costs a refusal the person can override with
    // --port while the other direction costs somebody else an outage.
    assert.isFalse(
      conflictIsOwnService({ conflict: socket(null), ownMainPid: 277, unitIsOurs: true }),
    );
    assert.isFalse(
      conflictIsOwnService({ conflict: socket(277), ownMainPid: null, unitIsOurs: true }),
    );
  });

  it("refuses when the unit is not one we wrote, whatever the pids say", () => {
    assert.isFalse(
      conflictIsOwnService({ conflict: socket(277), ownMainPid: 277, unitIsOurs: false }),
    );
  });

  it("is false when there is no conflict to attribute", () => {
    assert.isFalse(conflictIsOwnService({ conflict: null, ownMainPid: 277, unitIsOurs: true }));
  });
});

describe("decideEnrollmentPoll", () => {
  const ttlMs = 600_000;

  it("stops happily on 200", () => {
    assert.deepStrictEqual(decideEnrollmentPoll({ status: 200, elapsedMs: 4000, ttlMs }), {
      kind: "collected",
    });
  });

  it("keeps waiting on 425, because nobody has clicked yet", () => {
    assert.deepStrictEqual(decideEnrollmentPoll({ status: 425, elapsedMs: 4000, ttlMs }), {
      kind: "wait",
      delayMs: ENROLLMENT_POLL_INTERVAL_MS,
    });
  });

  it("gives up on 409, because that code will never work again", () => {
    // 425 and 409 are the whole loop. The server picked two different codes
    // precisely so a poller could tell "not yet" from "finished forever";
    // conflating them either abandons a live enrollment or hammers a dead one.
    const decision = decideEnrollmentPoll({ status: 409, elapsedMs: 4000, ttlMs });

    assert.strictEqual(decision.kind, "stop");
    assert.include(decision.kind === "stop" ? decision.reason : "", "denied");
  });

  it("backs off further on 429 than on an ordinary wait", () => {
    const rateLimited = decideEnrollmentPoll({ status: 429, elapsedMs: 4000, ttlMs });
    assert.strictEqual(rateLimited.kind, "wait");
    assert.isAbove(
      rateLimited.kind === "wait" ? rateLimited.delayMs : 0,
      ENROLLMENT_POLL_INTERVAL_MS,
    );
  });

  it("retries a 503, which is the server's opaque transient", () => {
    assert.strictEqual(decideEnrollmentPoll({ status: 503, elapsedMs: 4000, ttlMs }).kind, "wait");
  });

  it("does not retry a 404, which does not improve with time", () => {
    const decision = decideEnrollmentPoll({ status: 404, elapsedMs: 4000, ttlMs });

    assert.strictEqual(decision.kind, "stop");
    assert.include(decision.kind === "stop" ? decision.reason : "", "--account-url");
  });

  it("stops on the deadline even while the server still says 425", () => {
    // The server reports expiry at read time rather than by rewriting a status
    // column, so a poll can keep receiving 425 right up to the edge. Without
    // this the loop would run past the window and then report whatever the
    // server happened to say, instead of the truthful "it expired".
    const decision = decideEnrollmentPoll({ status: 425, elapsedMs: ttlMs, ttlMs });

    assert.strictEqual(decision.kind, "stop");
    assert.include(decision.kind === "stop" ? decision.reason : "", "approval window closed");
  });

  it("still succeeds on a 200 that arrives on the deadline", () => {
    // The credential has already been issued and the enrollment row is already
    // spent. Discarding it for being late would throw away the one session the
    // flow will ever mint for this code.
    assert.deepStrictEqual(decideEnrollmentPoll({ status: 200, elapsedMs: ttlMs, ttlMs }), {
      kind: "collected",
    });
  });

  it("stops on a status it has never seen rather than looping forever", () => {
    const decision = decideEnrollmentPoll({ status: 418, elapsedMs: 4000, ttlMs });

    assert.strictEqual(decision.kind, "stop");
    assert.include(decision.kind === "stop" ? decision.reason : "", "418");
  });
});

describe("install availability", () => {
  it("has no URL, because nothing is published", () => {
    // Guarding the honest state on purpose. If someone sets a base URL to make
    // the docs look finished, this test is where they have to justify it.
    assert.strictEqual(ENVIRONMENT_INSTALL_BASE_URL, null);
    assert.strictEqual(environmentInstallCommandLine(), null);
    assert.strictEqual(resolveEnvironmentServerTarballUrl("0.0.20"), null);
  });

  it("explains the absence instead of showing a dead command", () => {
    const availability = describeEnvironmentInstallAvailability();

    assert.strictEqual(availability.published, false);
    assert.include(availability.detail, "infra/install/t3-environment.sh");
    assert.notInclude(availability.detail, "curl -fsSL http");
  });
});

describe("the installer script agrees with this module", () => {
  // The script cannot import any of the above: it runs on a bare VPS before a
  // runtime exists. So it carries its own copy of the shared constants and this
  // test is what stops the two drifting. Without it they agree exactly once,
  // on the day they were written.
  const script = fs.readFileSync(INSTALLER_PATH, "utf8");
  const constants = readInstallerShellConstants(script);

  it("declares a parseable constants block", () => {
    assert.isAbove(constants.size, 0, "the drift-checked constants block was not found");
  });

  it("uses the same paths, user and unit name", () => {
    assert.strictEqual(constants.get("T3_PREFIX"), ENVIRONMENT_PREFIX);
    assert.strictEqual(constants.get("T3_DATA_DIR"), ENVIRONMENT_DATA_DIR);
    assert.strictEqual(constants.get("T3_SERVICE_USER"), ENVIRONMENT_SERVICE_USER);
    assert.strictEqual(constants.get("T3_UNIT_NAME"), ENVIRONMENT_UNIT_NAME);
    assert.strictEqual(constants.get("T3_UNIT_PATH"), ENVIRONMENT_UNIT_PATH);
    assert.strictEqual(constants.get("T3_UNIT_MARKER"), ENVIRONMENT_UNIT_MARKER);
  });

  it("uses the same port and versions", () => {
    assert.strictEqual(constants.get("T3_DEFAULT_PORT"), String(ENVIRONMENT_DEFAULT_PORT));
    assert.strictEqual(constants.get("T3_BUN_VERSION"), ENVIRONMENT_BUN_VERSION);
    assert.strictEqual(constants.get("T3_SERVER_VERSION"), ENVIRONMENT_SERVER_VERSION);
  });

  it("polls on the same status codes the decision table branches on", () => {
    assert.strictEqual(constants.get("T3_ENROLL_STATUS_COLLECTED"), "200");
    assert.strictEqual(constants.get("T3_ENROLL_STATUS_WAIT"), "425");
    assert.strictEqual(constants.get("T3_ENROLL_STATUS_RATE_LIMITED"), "429");
  });

  it("has no base URL either", () => {
    assert.strictEqual(constants.get("T3_INSTALL_BASE_URL"), "");
  });

  it("waits exactly as long as the server keeps an enrollment alive", () => {
    // The one constant in this file that belongs to somebody else. Waiting
    // longer than DEVICE_ENROLLMENT_TTL_MS means polling a code that expired
    // minutes ago; giving up sooner abandons an enrollment that was still live.
    // Read from the server's own source so that changing it there fails here.
    const serverSource = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../apps/server/src/deviceEnrollment/http.ts"),
      "utf8",
    );
    const declaration = /DEVICE_ENROLLMENT_TTL_MS\s*=\s*([0-9*\s_]+);/.exec(serverSource);
    assert.isNotNull(declaration, "could not find DEVICE_ENROLLMENT_TTL_MS in the server source");

    // Only digits, underscores and `*` matched above, so this is arithmetic
    // rather than evaluation of anything the file might contain.
    const serverTtlMs = (declaration?.[1] ?? "")
      .split("*")
      .map((factor) => Number.parseInt(factor.trim().replaceAll("_", ""), 10))
      .reduce((product, factor) => product * factor, 1);

    assert.strictEqual(serverTtlMs, ENROLLMENT_TTL_MS);
    assert.strictEqual(constants.get("T3_ENROLL_TTL_SECONDS"), String(ENROLLMENT_TTL_MS / 1000));
  });

  it("gates every destructive step on the ownership marker", () => {
    // The single most important property on a shared box: this script may only
    // stop, overwrite or delete a unit it wrote itself. `unit_is_ours` is the
    // only thing that establishes that, so every one of those verbs has to sit
    // behind it.
    assert.include(script, "unit_is_ours");
    assert.match(script, /if unit_is_ours; then\n\s+log "stopping and disabling/);
    assert.match(script, /if \[ -f "\$T3_UNIT_PATH" \] && ! unit_is_ours; then/);
  });

  it("proves port ownership by pid rather than by the install existing", () => {
    // Regression guard for the bug above. The shell has to consult systemd's
    // MainPID and compare it; a version file and a unit file are not evidence
    // that the process on our port is ours.
    assert.include(script, "own_service_pid");
    assert.include(script, "MainPID");
    assert.match(script, /\[ "\$preflight_conflict_pid" = "\$preflight_own_pid" \]/);
  });

  it("never passes --remove to userdel", () => {
    // userdel --remove deletes the home directory, and the home directory is
    // the data directory that uninstalling promises to keep. This is a
    // one-character mistake with an unrecoverable outcome.
    assert.notMatch(script, /userdel[^\n]*--remove/);
    assert.notMatch(script, /userdel\s+-r\b/);
  });

  it("never removes the data directory", () => {
    assert.notMatch(script, /rm -rf "\$T3_DATA_DIR"/);
  });
});

/**
 * The awk in the script, run for real, against the same fixtures the module is.
 *
 * The constants above are compared as text, which is all a constant needs. The
 * port conflict rule is not a constant: it is the one piece of judgement the
 * script re-implements rather than parameterises, it is written in awk, and it
 * is the copy that actually executes on somebody's VPS. Reading it beside
 * `findPortConflict` and nodding is the check that has never caught anything.
 *
 * So this runs it. `find_port_conflict` is lifted out of the script — the whole
 * file cannot be sourced, because loading it runs `do_install` — and executed
 * with a stub `ss` on `PATH` that prints a fixture. Both sides then answer the
 * same question about the same output, and the answers have to match.
 *
 * The comparison is of the substance and not the spelling: whether there is a
 * conflict at all, which pid holds it, and which address and port. The awk
 * strips an `::ffff:` prefix before printing while the module strips it only
 * when comparing, so the addresses are normalised here before they are held to
 * each other. That is a difference in what gets shown to a person, and this test
 * is about what gets decided.
 */
/** `::ffff:127.0.0.1` and `127.0.0.1` are one address wearing two hats. */
const comparableAddress = (value: string) => value.replace(/^::ffff:/i, "").toLowerCase();

describe("the installer's port check agrees with findPortConflict when it is run", () => {
  const script = fs.readFileSync(INSTALLER_PATH, "utf8");
  const shellFunction = readInstallerShellFunction(script, "find_port_conflict");

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "t3-installer-drift-"));
  const binDirectory = path.join(workspace, "bin");
  const fixturePath = path.join(workspace, "ss-output.txt");
  fs.mkdirSync(binDirectory, { recursive: true });
  // A stub `ss` rather than the machine's own: the fixtures are the interesting
  // rows, and whatever this laptop happens to be serving is not a test.
  fs.writeFileSync(path.join(binDirectory, "ss"), '#!/bin/sh\ncat "$T3_TEST_SS_OUTPUT"\n');
  fs.chmodSync(path.join(binDirectory, "ss"), 0o755);

  const runShellCheck = (input: {
    readonly ssOutput: string;
    readonly port: number;
    readonly host: string;
    /** Whether the stub `ss` is reachable. Absent is a real state on a real box. */
    readonly ssInstalled?: boolean;
  }): string => {
    assert.isNotNull(shellFunction, "find_port_conflict was not found in the installer");
    fs.writeFileSync(fixturePath, `${input.ssOutput}\n`);
    // The port and host arrive as positional arguments rather than as text
    // interpolated into the program, so this harness cannot accidentally test a
    // shell it wrote itself.
    return (
      childProcess
        .execFileSync(
          "/bin/sh",
          [
            "-c",
            `${shellFunction}\nfind_port_conflict "$1" "$2"`,
            "sh",
            String(input.port),
            input.host,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              PATH:
                input.ssInstalled === false ? workspace : `${binDirectory}:${process.env["PATH"]}`,
              T3_TEST_SS_OUTPUT: fixturePath,
            },
          },
        )
        // Trailing only. An unattributed socket is printed with an *empty* pid
        // field, so the line legitimately begins with a tab and trimming both
        // ends would silently turn "no holder" into "no answer".
        .trimEnd()
    );
  };

  const assertAgrees = (input: {
    readonly ssOutput: string;
    readonly port: number;
    readonly host: string;
  }) => {
    const conflict = findPortConflict({
      port: input.port,
      host: input.host,
      listeners: parseListeningSockets(input.ssOutput),
    });
    const shellAnswer = runShellCheck(input);

    if (conflict === null) {
      assert.strictEqual(shellAnswer, "", "the shell found a conflict the module did not");
      return;
    }

    assert.notStrictEqual(shellAnswer, "", "the module found a conflict the shell did not");
    const [pidField = "", description = ""] = shellAnswer.split("\t");
    assert.strictEqual(
      pidField,
      conflict.pid === null ? "" : String(conflict.pid),
      "the two disagree about which pid holds the port",
    );

    const socket = description.split(" ")[0] ?? "";
    const separator = socket.lastIndexOf(":");
    assert.strictEqual(socket.slice(separator + 1), String(conflict.port));
    assert.strictEqual(
      comparableAddress(socket.slice(0, separator)),
      comparableAddress(conflict.address),
      "the two disagree about which address holds the port",
    );
  };

  const SS_OUTPUT = [
    'LISTEN 0      4096   127.0.0.1:3773       0.0.0.0:*    users:(("bun",pid=1042,fd=21))',
    'LISTEN 0      511      0.0.0.0:80          0.0.0.0:*    users:(("apache2",pid=812,fd=4))',
    'LISTEN 0      4096        [::]:22             [::]:*    users:(("sshd",pid=655,fd=4))',
    'LISTEN 0      4096   127.0.0.1:37730      0.0.0.0:*    users:(("grafana",pid=9001,fd=8))',
  ].join("\n");

  it("agrees that a wildcard listener collides with a specific bind", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 80, host: "127.0.0.1" });
  });

  it("agrees that a wildcard bind collides with a loopback listener", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 3773, host: "0.0.0.0" });
  });

  it("agrees that two different specific addresses do not collide", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 3773, host: "10.0.0.5" });
  });

  it("agrees that 37730 is not 3773", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 37730, host: "127.0.0.1" });
    assertAgrees({ ssOutput: SS_OUTPUT, port: 3773, host: "127.0.0.1" });
  });

  it("agrees about an IPv6 wildcard row", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 22, host: "::" });
  });

  it("agrees that an IPv6 wildcard listener blocks a specific IPv6 bind", () => {
    // Both directions of the wildcard rule have to be checked separately: this
    // is the one where the *listener* is the wildcard, and it is the only case
    // that fails if `::` goes missing from the shell's set of them.
    assertAgrees({ ssOutput: SS_OUTPUT, port: 22, host: "::1" });
  });

  it("agrees that a queue depth is not a port", () => {
    // Every row above has 4096 or 511 in its Recv-Q and Send-Q columns. A check
    // that scanned the line for a number would refuse to install on this box.
    assertAgrees({ ssOutput: SS_OUTPUT, port: 4096, host: "0.0.0.0" });
    assertAgrees({ ssOutput: SS_OUTPUT, port: 511, host: "0.0.0.0" });
  });

  it("agrees that the peer column holds nothing", () => {
    assertAgrees({ ssOutput: SS_OUTPUT, port: 9999, host: "0.0.0.0" });
  });

  it("agrees that ::ffff: loopback is loopback", () => {
    assertAgrees({
      ssOutput: 'LISTEN 0 4096 ::ffff:127.0.0.1:3773 *:* users:(("bun",pid=1042,fd=21))',
      port: 3773,
      host: "127.0.0.1",
    });
  });

  it("agrees that a holder with no pid is still a conflict", () => {
    // ss without -p, or run unprivileged. Both sides must report the collision
    // and neither may name a holder; `conflictIsOwnService` then refuses it,
    // which is the safe direction.
    assertAgrees({ ssOutput: "LISTEN 0 4096 0.0.0.0:3773 0.0.0.0:*", port: 3773, host: "0.0.0.0" });
  });

  it("agrees that an empty listing is not a conflict", () => {
    assertAgrees({ ssOutput: "", port: 3773, host: "0.0.0.0" });
  });

  it("skips the check rather than refusing when ss is not installed", () => {
    // The script warns and carries on; if the port really is taken the unit
    // fails to start and nothing else is touched. Refusing here would make the
    // installer unusable on a minimal image that simply lacks iproute2.
    assert.strictEqual(
      runShellCheck({ ssOutput: SS_OUTPUT, port: 80, host: "0.0.0.0", ssInstalled: false }),
      "",
    );
  });
});
