import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  codexHomeFor,
  ensureCodexHome,
  providerAuthRoot,
  providerAuthUserDir,
  readClaudeToken,
  writeClaudeToken,
} from "./store.ts";

/**
 * The permissions on the provider credential directory, asserted rather than
 * intended.
 *
 * Every write in this module passes `mode` to `mkdir` and `writeFile`, and both
 * of those apply it only to something they create. A provider-auth tree that
 * arrived any other way — a state directory restored from a tar, a `cp -r`
 * without `-p`, a volume copied between the two deployments sharing one box —
 * keeps whatever modes it arrived with, for good, with a year-long provider
 * token inside it. These tests set that situation up by hand and then ask
 * whether writing a credential fixes it.
 *
 * What this does not test, because it is not true: that these modes keep this
 * server's own users apart. They cannot. Every shell this server spawns runs as
 * the OS user that owns these files, so a person with a terminal reads them by
 * absolute path whatever the mode says. The modes are the boundary against the
 * rest of the machine, and that is the boundary these tests hold.
 */

const stateDirs: string[] = [];
const notWindows = process.platform !== "win32";

async function makeStateDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "provider-auth-modes-"));
  stateDirs.push(dir);
  return dir;
}

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

afterEach(async () => {
  while (stateDirs.length > 0) {
    await rm(stateDirs.pop()!, { recursive: true, force: true });
  }
});

describe("provider credential permissions", () => {
  it.runIf(notWindows)(
    "tightens a provider directory and token file that were already world-readable",
    async () => {
      const stateDir = await makeStateDir();
      const userId = "user-restored";
      const claudeDir = path.join(providerAuthUserDir(stateDir, userId), "claude");
      // Exactly what a restored copy looks like: the tree is there, the modes
      // are the umask's, and a stale token is sitting in it.
      await mkdir(claudeDir, { recursive: true });
      await chmod(providerAuthRoot(stateDir), 0o755);
      await chmod(providerAuthUserDir(stateDir, userId), 0o755);
      await chmod(claudeDir, 0o755);
      const tokenPath = path.join(claudeDir, "oauth-token");
      await writeFile(tokenPath, "stale-token", "utf8");
      await chmod(tokenPath, 0o644);

      await writeClaudeToken(stateDir, userId, "fresh-token");

      expect(await modeOf(tokenPath)).toBe(0o600);
      expect(await modeOf(claudeDir)).toBe(0o700);
      expect(await modeOf(providerAuthUserDir(stateDir, userId))).toBe(0o700);
      expect(await modeOf(providerAuthRoot(stateDir))).toBe(0o700);
      // And the write still did its job.
      expect(await readClaudeToken(stateDir, userId)).toBe("fresh-token");
    },
  );

  it.runIf(notWindows)(
    "tightens a world-readable tree before a Codex login writes into it",
    async () => {
      const stateDir = await makeStateDir();
      const userId = "user-codex-restored";
      const codexDir = path.join(providerAuthUserDir(stateDir, userId), "codex");
      await mkdir(codexDir, { recursive: true });
      await chmod(providerAuthRoot(stateDir), 0o755);
      await chmod(providerAuthUserDir(stateDir, userId), 0o755);
      await chmod(codexDir, 0o755);

      const home = await ensureCodexHome(stateDir, userId);

      expect(home).toBe(codexHomeFor(stateDir, userId));
      expect(await modeOf(home)).toBe(0o700);
      expect(await modeOf(providerAuthUserDir(stateDir, userId))).toBe(0o700);
      expect(await modeOf(providerAuthRoot(stateDir))).toBe(0o700);
    },
  );

  it.runIf(notWindows)("leaves the state directory around the provider root alone", async () => {
    const stateDir = await makeStateDir();
    await chmod(stateDir, 0o755);

    await writeClaudeToken(stateDir, "user-scope", "token");

    // The walk stops at the provider-auth root. The state directory holds the
    // database, the logs and everything else, and this is not the module that
    // gets to decide what they are worth.
    expect(await modeOf(stateDir)).toBe(0o755);
    expect(await modeOf(providerAuthRoot(stateDir))).toBe(0o700);
  });
});
