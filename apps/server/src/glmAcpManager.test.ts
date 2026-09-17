import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "@effect/vitest";

import { readSessionTextFile, writeSessionTextFile } from "./glmAcpManager.ts";

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
