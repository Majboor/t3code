/**
 * Where to look for packs.
 *
 * This lives on its own because two binaries need the same answer. `t3-pack`
 * and the `t3 pack` subcommands resolving it differently is not a tidiness
 * problem: it means a pack you can see with one is invisible to the other, and
 * the one it is invisible to is the one the agent runs.
 *
 * The ordering that matters is the last step. T3CODE_HOME moves the server's
 * state, so a server run against a scratch home has no packs under it — while
 * the packs are still installed under the default home, because that is where
 * installing puts them. Preferring the empty directory is how an agent gets
 * told "no pack matches" in a workspace holding five, which reads as packs
 * being useless rather than as it having looked in the wrong place.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_DIRECTORY = "packs";

export function resolveRegistryRoot(
  explicit: string | undefined,
  environment: Record<string, string | undefined> = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }

  const configured = environment["T3CODE_PACK_REGISTRY"];
  if (configured !== undefined && configured.length > 0) {
    return configured;
  }

  const fallback = join(homedir(), ".t3code", REGISTRY_DIRECTORY);
  const home = environment["T3CODE_HOME"];
  if (home === undefined || home.length === 0) {
    return fallback;
  }

  // When neither exists, name the home's own path: an error saying the
  // registry under your configured home is empty is followable, and one
  // pointing at a directory you never chose is not.
  const fromHome = join(home, REGISTRY_DIRECTORY);
  return exists(fromHome) || !exists(fallback) ? fromHome : fallback;
}
