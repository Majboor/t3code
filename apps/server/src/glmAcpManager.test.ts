import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { RequestError } from "@agentclientprotocol/sdk";

import { GlmTerminalRegistry } from "./glmAcpManager.ts";

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
