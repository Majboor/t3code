/**
 * Puts `t3` on PATH for the agent.
 *
 * The agent is told it can look for a pack with `t3 pack search`. That is only
 * true if the command exists where the agent runs, and it does not: `t3` is a
 * workspace binary, so inside somebody's own project there is nothing on PATH
 * by that name. Telling an agent to run a command that is not there is worse
 * than saying nothing, because it will try, fail, and conclude packs are
 * broken.
 *
 * So the server writes a two-line shim pointing at the interpreter and entry
 * it was itself started with, and prepends its directory to the agent's PATH.
 * Whatever launched the server — `node src/bin.ts` in development, a packaged
 * binary in an install — is by definition a working way to reach the CLI.
 *
 * Returns undefined rather than guessing when the entry cannot be resolved.
 * The caller then leaves PATH alone, which is the honest outcome: no shim, and
 * nothing claiming otherwise.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Quotes a path for `sh`, which is the only shell this needs to survive. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function ensureAgentCliShim(binDir: string): string | undefined {
  const entry = process.argv[1];
  if (entry === undefined || entry.length === 0) {
    return undefined;
  }
  const resolvedEntry = resolve(entry);
  if (!existsSync(resolvedEntry)) {
    return undefined;
  }

  try {
    mkdirSync(binDir, { recursive: true });
    const shimPath = resolve(binDir, "t3");
    // `exec` so signals and the exit code belong to the CLI rather than to a
    // wrapper the agent cannot see.
    writeFileSync(
      shimPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(resolvedEntry)} "$@"\n`,
      { mode: 0o755 },
    );
    chmodSync(shimPath, 0o755);
    return dirname(shimPath);
  } catch {
    // A read-only home, a race with another server — none of it is worth
    // failing a turn over. The agent simply will not find `t3`.
    return undefined;
  }
}

/** PATH for a child process, with the shim directory looked at first. */
export function withShimOnPath(
  path: string | undefined,
  shimDir: string | undefined,
): string | undefined {
  if (shimDir === undefined) return path;
  return path === undefined || path.length === 0 ? shimDir : `${shimDir}:${path}`;
}
