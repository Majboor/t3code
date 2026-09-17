import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { RequestError } from "@agentclientprotocol/sdk";

import { GlmTerminalRegistry, readSessionTextFile, writeSessionTextFile } from "./glmAcpManager.ts";

/**
 * Covers the containment check backing this file's `fs/read_text_file` /
 * `fs/write_text_file` ACP handlers: `path` is absolute but entirely
 * agent-supplied (opencode decides what to read/write), and the whole point
 * of scoping a GLM session's `opencode acp` subprocess to `cwd` is that it
 * should never be able to reach outside it. Uses real temp directories
 * (not mocks) since the point is proving the containment check is real,
 * not merely wired up.
 */
async function withTempCwd(run: (cwd: string) => Promise<void>): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "t3-glm-fs-test-"));
  try {
    await run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

it("readSessionTextFile reads a real file inside cwd", () =>
  withTempCwd(async (cwd) => {
    const filePath = join(cwd, "inside.txt");
    await writeFile(filePath, "line1\nline2\nline3", "utf8");

    const result = await readSessionTextFile(cwd, filePath);
    assert.equal(result.content, "line1\nline2\nline3");
  }));

it("readSessionTextFile honors 1-based line + limit", () =>
  withTempCwd(async (cwd) => {
    const filePath = join(cwd, "inside.txt");
    await writeFile(filePath, "line1\nline2\nline3\nline4", "utf8");

    const result = await readSessionTextFile(cwd, filePath, { line: 2, limit: 2 });
    assert.equal(result.content, "line2\nline3");
  }));

it("readSessionTextFile rejects a path outside cwd (absolute escape)", () =>
  withTempCwd(async (cwd) => {
    await assert.rejects(() => readSessionTextFile(cwd, "/etc/passwd"), /outside the session's working directory/);
  }));

it("readSessionTextFile rejects a path outside cwd (../ escape)", () =>
  withTempCwd(async (cwd) => {
    const outsideDir = await mkdtemp(join(tmpdir(), "t3-glm-fs-test-outside-"));
    try {
      const outsideFile = join(outsideDir, "secret.txt");
      await writeFile(outsideFile, "should never be read", "utf8");
      // `path` must be absolute per the ACP schema, but a malicious/buggy
      // agent could still send one built with literal `..` segments that
      // only resolve outside `cwd` once normalized - built by hand (not via
      // `path.join`, which would normalize it before it ever reaches the
      // function under test) so the literal `..` segments genuinely reach
      // `resolveSessionFsPath`'s own `path.resolve` call.
      const escapePath = `${cwd}/../../${outsideFile.split("/").slice(1).join("/")}`;
      await assert.rejects(
        () => readSessionTextFile(cwd, escapePath),
        /outside the session's working directory/,
      );
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  }));

it("readSessionTextFile rejects a sibling directory whose name merely starts with cwd's name", () =>
  withTempCwd(async (cwd) => {
    // Regression guard for a naive `startsWith(root)` check (without the
    // trailing-separator boundary) that would wrongly treat
    // "/tmp/t3-glm-fs-test-XXXX-evil" as inside "/tmp/t3-glm-fs-test-XXXX".
    const siblingPath = `${cwd}-evil`;
    await mkdir(siblingPath, { recursive: true });
    try {
      const siblingFile = join(siblingPath, "secret.txt");
      await writeFile(siblingFile, "should never be read", "utf8");
      await assert.rejects(
        () => readSessionTextFile(cwd, siblingFile),
        /outside the session's working directory/,
      );
    } finally {
      await rm(siblingPath, { recursive: true, force: true });
    }
  }));

it("writeSessionTextFile writes a real file inside cwd, verified by reading it back", () =>
  withTempCwd(async (cwd) => {
    const filePath = join(cwd, "written.txt");
    await writeSessionTextFile(cwd, filePath, "hello from opencode");

    const onDisk = await readFile(filePath, "utf8");
    assert.equal(onDisk, "hello from opencode");
  }));

it("writeSessionTextFile rejects a path outside cwd and does not create the file", () =>
  withTempCwd(async (cwd) => {
    const outsideDir = await mkdtemp(join(tmpdir(), "t3-glm-fs-test-outside-"));
    try {
      const outsidePath = join(outsideDir, "should-not-exist.txt");
      await assert.rejects(
        () => writeSessionTextFile(cwd, outsidePath, "malicious content"),
        /outside the session's working directory/,
      );
      await assert.rejects(() => readFile(outsidePath, "utf8"), /ENOENT/);
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  }));

/**
 * Real-process tests for `GlmTerminalRegistry`, the self-contained tracker
 * backing the ACP `terminal/*` client-method handlers in `glmAcpManager.ts`
 * (see that file for why it exists instead of reusing
 * `apps/server/src/terminal/`'s PTY manager). These spawn real child
 * processes (`node -e ...`, `sleep`) rather than mocking `child_process`, so
 * they exercise the actual output buffering, exit-status plumbing, and
 * kill/release semantics an opencode subprocess would drive over the wire.
 */

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns a value or `timeoutMs` elapses, failing loudly instead of hanging forever on a regression. */
async function waitUntil<T>(check: () => T | null, timeoutMs: number, description: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = check();
    if (result !== null) return result;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
    }
    await sleepMs(20);
  }
}

it("terminal/create runs a real short-lived command and terminal/output eventually shows its output and a non-null exitStatus", async () => {
  const registry = new GlmTerminalRegistry(process.cwd());
  const terminalId = registry.create({
    command: process.execPath,
    args: ["-e", "console.log('hello-from-terminal')"],
  });

  const result = await waitUntil(
    () => {
      const current = registry.output(terminalId);
      return current.exitStatus !== null ? current : null;
    },
    5000,
    "terminal command to exit",
  );

  assert.match(result.output, /hello-from-terminal/);
  assert.equal(result.truncated, false);
  assert.equal(result.exitStatus?.exitCode, 0);
  assert.equal(result.exitStatus?.signal, null);

  registry.release(terminalId);
});

it("wait_for_exit resolves with the correct exit code for both a success and a failure command", async () => {
  const registry = new GlmTerminalRegistry(process.cwd());

  const successId = registry.create({ command: process.execPath, args: ["-e", "process.exit(0)"] });
  const successStatus = await registry.waitForExit(successId);
  assert.equal(successStatus.exitCode, 0);
  registry.release(successId);

  const failureId = registry.create({ command: process.execPath, args: ["-e", "process.exit(1)"] });
  const failureStatus = await registry.waitForExit(failureId);
  assert.equal(failureStatus.exitCode, 1);
  registry.release(failureId);
});

it("kill actually terminates a genuinely long-running command, not just returns", async () => {
  const registry = new GlmTerminalRegistry(process.cwd());
  const terminalId = registry.create({ command: "sleep", args: ["30"] });

  const startedAt = Date.now();
  registry.kill(terminalId);

  // `waitForExit` only resolves once Node's `exit` event fires, which only
  // happens after the OS actually reaps the process (via waitpid) — this is
  // not observable unless the process genuinely died, so this is proof the
  // process is gone, not just that `kill()` returned. Bounding it well under
  // the command's natural 30s runtime additionally proves it died early
  // rather than completing naturally.
  const status = await Promise.race([
    registry.waitForExit(terminalId),
    sleepMs(8000).then(() => {
      throw new Error("kill() did not terminate the process within 8s");
    }),
  ]);

  const elapsedMs = Date.now() - startedAt;
  assert.ok(elapsedMs < 10000, `expected kill to end the process well under 30s, took ${elapsedMs}ms`);
  assert.equal(status.signal, "SIGTERM");
  assert.equal(status.exitCode, null);

  // Per ACP's `terminal/kill` semantics, the terminal remains valid after
  // killing (only `release` frees it) — `output()` must still work and now
  // report the exit status.
  const output = registry.output(terminalId);
  assert.notEqual(output.exitStatus, null);

  registry.release(terminalId);
});

it("rejects a cwd that resolves outside the session's own cwd", () => {
  const sessionCwd = mkdtempSync(join(tmpdir(), "glm-terminal-test-"));
  const registry = new GlmTerminalRegistry(sessionCwd);

  assert.throws(
    () => registry.create({ command: process.execPath, args: ["-e", ""], cwd: "/etc" }),
    (err: unknown) => err instanceof RequestError && err.code === -32602,
  );

  assert.throws(
    () => registry.create({ command: process.execPath, args: ["-e", ""], cwd: "../../" }),
    (err: unknown) => err instanceof RequestError && err.code === -32602,
  );
});

it("accepts a cwd inside the session's own cwd, and defaults to it when omitted", async () => {
  const sessionCwd = mkdtempSync(join(tmpdir(), "glm-terminal-test-"));
  const nestedCwd = join(sessionCwd, "nested");
  mkdirSync(nestedCwd);
  const registry = new GlmTerminalRegistry(sessionCwd);

  const nestedId = registry.create({
    command: process.execPath,
    args: ["-e", "console.log(process.cwd())"],
    cwd: nestedCwd,
  });
  const nestedStatus = await registry.waitForExit(nestedId);
  assert.equal(nestedStatus.exitCode, 0);
  assert.match(registry.output(nestedId).output, new RegExp(nestedCwd.replace(/[/\\]/g, "\\$&")));
  registry.release(nestedId);

  const defaultedId = registry.create({
    command: process.execPath,
    args: ["-e", "console.log(process.cwd())"],
  });
  const defaultedStatus = await registry.waitForExit(defaultedId);
  assert.equal(defaultedStatus.exitCode, 0);
  assert.match(registry.output(defaultedId).output, new RegExp(sessionCwd.replace(/[/\\]/g, "\\$&")));
  registry.release(defaultedId);
});

it("disposeAll kills every still-tracked terminal", async () => {
  const registry = new GlmTerminalRegistry(process.cwd());
  const terminalId = registry.create({ command: "sleep", args: ["30"] });

  // Registered while the process is still running (and the terminal still
  // tracked), so this captures the exit waiter before `disposeAll` clears
  // the tracking map — the underlying child process object it closes over
  // still reports its real exit independent of the map.
  const exitPromise = registry.waitForExit(terminalId);
  registry.disposeAll();

  // disposeAll uses SIGKILL directly (session teardown, no grace period
  // needed) so this should resolve promptly.
  const status = await Promise.race([
    exitPromise,
    sleepMs(5000).then(() => {
      throw new Error("disposeAll() did not terminate the process within 5s");
    }),
  ]);
  assert.equal(status.exitCode, null);
  assert.ok(status.signal === "SIGKILL" || status.signal === "SIGTERM", `expected a kill signal, got ${status.signal}`);
});
