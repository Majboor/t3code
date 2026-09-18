import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";
import { RequestError, type CreateElicitationRequest, type ElicitationSchema } from "@agentclientprotocol/sdk";

import {
  autoAcceptsRequestKind,
  buildElicitationAcceptResponse,
  GlmTerminalRegistry,
  mapElicitationFormSchema,
  planElicitationRequest,
  readSessionTextFile,
  writeSessionTextFile,
} from "./glmAcpManager.ts";

/**
 * Regression test for a real live bug: GLM's `runtimeMode` used to be
 * hardcoded to `"full-access"` as a cosmetic session-metadata label, never
 * actually threaded into the `session/request_permission` handler - so a
 * thread genuinely running in "Full access" mode still asked for approval on
 * every write, exactly like "Approval required" would. Confirmed live: a
 * write sat as a real pending approval for over 5 minutes until the turn
 * watchdog killed the turn, even though the composer showed "Full access".
 */
it("autoAcceptsRequestKind: full-access auto-accepts every request kind", () => {
  assert.equal(autoAcceptsRequestKind("full-access", "command"), true);
  assert.equal(autoAcceptsRequestKind("full-access", "file-change"), true);
  assert.equal(autoAcceptsRequestKind("full-access", "file-read"), true);
});

it("autoAcceptsRequestKind: auto-accept-edits only auto-accepts file kinds, still asks for commands", () => {
  assert.equal(autoAcceptsRequestKind("auto-accept-edits", "file-change"), true);
  assert.equal(autoAcceptsRequestKind("auto-accept-edits", "file-read"), true);
  assert.equal(autoAcceptsRequestKind("auto-accept-edits", "command"), false);
});

it("autoAcceptsRequestKind: approval-required never auto-accepts anything", () => {
  assert.equal(autoAcceptsRequestKind("approval-required", "command"), false);
  assert.equal(autoAcceptsRequestKind("approval-required", "file-change"), false);
  assert.equal(autoAcceptsRequestKind("approval-required", "file-read"), false);
});

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

/**
 * Tests for `glmAcpManager.ts`'s `elicitation/create` mapping logic.
 *
 * IMPORTANT CAVEAT (see the coordinator's task notes and `GlmAdapter.ts`'s
 * `respondToUserInput` comment): there is no confirmed live evidence that
 * `opencode acp` ever actually sends `elicitation/create` — live testing
 * against real prompts never triggered it, and OpenCode's own agent loop
 * asks clarifying questions as plain conversational text instead. These
 * tests verify the mapping/decline logic is correct *if* the request is
 * ever received; they do not (and cannot, without a live `opencode acp`
 * subprocess) verify this path is ever exercised end-to-end in production.
 *
 * These tests exercise `planElicitationRequest`/`buildElicitationAcceptResponse`
 * directly (the pure decision/round-trip logic), not the `elicitation/create`
 * JSON-RPC handler itself — that handler's pending-promise/subprocess wiring
 * is the same proven-live pattern `session/request_permission` already uses
 * (see `GlmAcpManager.startSession`), and is not independently re-verified
 * here.
 */

function formRequest(requestedSchema: ElicitationSchema, message = "Please provide input."): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: "session-1",
    message,
    requestedSchema,
  } as CreateElicitationRequest;
}

it("maps a single string-enum form elicitation to a single-select question, and round-trips the chosen answer into an accept response", () => {
  const request = formRequest(
    {
      type: "object",
      properties: {
        color: {
          type: "string",
          title: "Favorite color",
          enum: ["red", "green", "blue"],
        },
      },
    },
    "Which color should I use?",
  );

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.equal(plan.question.propertyName, "color");
  assert.equal(plan.question.multiSelect, false);
  assert.equal(plan.question.questionText, "Favorite color");
  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "red", description: "red" },
      { label: "green", description: "green" },
      { label: "blue", description: "blue" },
    ],
  );

  // Simulate the user picking "green" via T3's existing user-input UI —
  // `buildPendingUserInputAnswers` (apps/web/src/pendingUserInput.ts) submits
  // the option's `label`, not a separate value, as the answer.
  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { color: "green" },
  );
  assert.deepEqual(response, { action: "accept", content: { color: "green" } });
});

it("maps a titled single-select enum (oneOf) using the option's title as the label and its own const as the round-tripped value", () => {
  const request = formRequest({
    type: "object",
    properties: {
      size: {
        type: "string",
        oneOf: [
          { const: "s", title: "Small" },
          { const: "l", title: "Large", description: "Extra room" },
        ],
      },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "Small", description: "Small" },
      { label: "Large", description: "Extra room" },
    ],
  );

  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { size: "Large" },
  );
  assert.deepEqual(response, { action: "accept", content: { size: "l" } });
});

it("maps a boolean form field to a Yes/No question and round-trips to a real boolean in the accept response", () => {
  const request = formRequest({
    type: "object",
    properties: {
      confirm: { type: "boolean", title: "Proceed?" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ],
  );

  const accepted = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { confirm: "Yes" },
  );
  assert.deepEqual(accepted, { action: "accept", content: { confirm: true } });

  const declined = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { confirm: "No" },
  );
  assert.deepEqual(declined, { action: "accept", content: { confirm: false } });
});

it("maps a multi-select array field (anyOf) to a multiSelect question and round-trips multiple chosen values", () => {
  const request = formRequest({
    type: "object",
    properties: {
      toppings: {
        type: "array",
        items: {
          anyOf: [
            { const: "cheese", title: "Cheese" },
            { const: "olives", title: "Olives" },
            { const: "mushroom", title: "Mushroom" },
          ],
        },
      },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;
  assert.equal(plan.question.multiSelect, true);

  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { toppings: ["Cheese", "Mushroom"] },
  );
  assert.deepEqual(response, { action: "accept", content: { toppings: ["cheese", "mushroom"] } });
});

it("declines a url-mode elicitation instead of erroring", () => {
  const request: CreateElicitationRequest = {
    mode: "url",
    sessionId: "session-1",
    message: "Please sign in via your browser.",
    elicitationId: "elicit-1",
    url: "https://example.com/auth",
  };

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
  if (plan.kind !== "decline") return;
  assert.deepEqual(plan.response, { action: "decline" });
  assert.match(plan.reason, /url/i);
});

it("declines an unrecognized/custom elicitation mode instead of erroring", () => {
  const request = {
    mode: "_vendor-extension-mode",
    sessionId: "session-1",
    message: "Some future elicitation mode.",
  } as unknown as CreateElicitationRequest;

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
  if (plan.kind !== "decline") return;
  assert.deepEqual(plan.response, { action: "decline" });
});

it("declines (does not force a bad UI for) a form schema with more than one property", () => {
  const request = formRequest({
    type: "object",
    properties: {
      first: { type: "string", enum: ["a", "b"] },
      second: { type: "string", enum: ["c", "d"] },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("declines (does not force a bad UI for) a free-text string field with no enum/oneOf", () => {
  const request = formRequest({
    type: "object",
    properties: {
      notes: { type: "string", title: "Notes" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("declines (does not force a bad UI for) a number/integer field", () => {
  const request = formRequest({
    type: "object",
    properties: {
      age: { type: "integer" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("mapElicitationFormSchema returns undefined for a schema with no properties at all", () => {
  assert.equal(mapElicitationFormSchema({ type: "object" }), undefined);
});

it("buildElicitationAcceptResponse declines rather than fabricating a value for an unrecognized answer label", () => {
  const response = buildElicitationAcceptResponse(
    { propertyName: "color", multiSelect: false, valueByLabel: new Map([["red", "red"]]) },
    { color: "purple" },
  );
  assert.deepEqual(response, { action: "decline" });
});
