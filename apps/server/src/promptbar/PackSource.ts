/**
 * Reads `packs/*\/promptbar.json` off disk — the phrasing side of a pack, kept
 * separate from the full `pack.json` manifest (see `../packs/Manifest.ts`)
 * because retrieval only ever needs id/name/description/phrasings/params, and
 * a bad phrasings file for one pack should never stop the rest from indexing.
 *
 * Style follows `../packs/Manifest.ts`: this module is the registry's (here,
 * the retrieval index's) only contact with the shape on disk, so a renamed or
 * relocated field only has to change here.
 *
 * @module PackSource
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { Data, Effect, Schema } from "effect";

export class PackSourceError extends Data.TaggedError("PackSourceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const PromptbarPackParam = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  required: Schema.Boolean,
  desc: Schema.String,
});

const PromptbarPackFile = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  phrasings: Schema.Array(Schema.String),
  params: Schema.Array(PromptbarPackParam),
  prompt: Schema.String,
});

export interface PromptbarPackDefinition {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly phrasings: ReadonlyArray<string>;
  readonly params: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly desc: string;
  }>;
}

const decodePromptbarPackFile = Schema.decodeUnknownSync(PromptbarPackFile);

/**
 * A `packs/` directory only counts if it actually holds pack content (a
 * subdirectory with a `pack.json`), because `apps/server/src/packs/` is a
 * second, unrelated directory that is *also* named `packs` (it's this
 * server's own pack-registry module — `Manifest.ts`, `Layers/`, `Services/`
 * — not pack content) and sits closer to this file than the repo-root one
 * does. Walking up naively finds that one first and silently indexes zero
 * packs, which is exactly what happened before this check existed.
 */
function looksLikePacksContentDir(candidate: string): boolean {
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) return false;
  return fs.readdirSync(candidate, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) return false;
    return fs.existsSync(path.join(candidate, entry.name, "pack.json"));
  });
}

/**
 * Walks up from `startDir` looking for a `packs/` directory (the repo-root
 * source-of-truth checked out alongside `apps/`) — this file lives at a
 * different depth under `apps/server/src/...` in dev (`node --watch
 * src/bin.ts`) than it does bundled to `apps/server/dist/bin.mjs`, so a fixed
 * `../../../..` relative path would silently break one of the two. Capped so
 * a repo that genuinely has no `packs/` directory fails fast instead of
 * walking to filesystem root.
 */
export function findPacksDir(startDir: string, maxLevels = 12): string | null {
  let dir = startDir;
  for (let i = 0; i < maxLevels; i++) {
    const candidate = path.join(dir, "packs");
    if (looksLikePacksContentDir(candidate)) {
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** `findPacksDir` rooted at this module's own location. */
export function defaultPacksDir(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return findPacksDir(here);
}

/**
 * Reads every `packs/*\/promptbar.json` under `packsDir`. A pack directory
 * with no `promptbar.json` (e.g. `cloudflare-deploy`, which has none today)
 * is skipped, not an error — not every pack has opted into promptbar
 * retrieval yet. A `promptbar.json` that exists but fails to decode is
 * logged and skipped rather than failing the whole load, so one bad file
 * cannot take every other pack's retrieval down with it.
 */
export const loadPromptbarPacks = Effect.fn("loadPromptbarPacks")(function* (packsDir: string | null) {
  if (packsDir === null) {
    yield* Effect.logWarning("promptbar.packs.dir_not_found", {
      message: "No packs/ directory found; Promptbar retrieval will index zero packs.",
    });
    return [] as ReadonlyArray<PromptbarPackDefinition>;
  }

  const entries = yield* Effect.try({
    try: () => fs.readdirSync(packsDir, { withFileTypes: true }),
    catch: (cause) => new PackSourceError({ message: `Failed to read ${packsDir}`, cause }),
  });

  const packs: PromptbarPackDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(packsDir, entry.name, "promptbar.json");
    if (!fs.existsSync(file)) continue;

    const decoded = yield* Effect.try({
      try: () => decodePromptbarPackFile(JSON.parse(fs.readFileSync(file, "utf8"))),
      catch: (cause) => new PackSourceError({ message: `Malformed promptbar.json in ${entry.name}`, cause }),
    }).pipe(
      Effect.catch((error) => Effect.logWarning("promptbar.packs.skip_invalid", { pack: entry.name, message: error.message }).pipe(Effect.as(null))),
    );
    if (decoded === null) continue;

    packs.push({
      id: decoded.id,
      name: decoded.name,
      description: decoded.description,
      phrasings: decoded.phrasings,
      params: decoded.params,
    });
  }

  return packs as ReadonlyArray<PromptbarPackDefinition>;
});
