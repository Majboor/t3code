#!/usr/bin/env node
/**
 * Puts the packs that ship with the product into the registry the app reads.
 *
 * The repo keeps packs in source layout — `packs/ssh-deploy/pack.json`, next
 * to its README and handover notes — because that is what is pleasant to edit
 * and review. A registry wants `<publisher>-<name>.pack/` with a `versions/`
 * directory. They are not the same shape, and nothing converted one to the
 * other, so the verified packs existed on a machine only if somebody had
 * installed them by hand. On a fresh checkout the prompt bar had nothing to
 * offer and the agent's `t3 pack search` found nothing — while five packs sat
 * in the repo.
 *
 *   bun run packs:install
 *
 * Idempotent: recording a version that is already there is a no-op, because a
 * registry never rewrites a release. Nothing is deleted, so a pack somebody
 * published locally is left alone.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { makeDirectoryRegistry } from "@t3tools/pack-cli/registry";
import { makeNodePackStore } from "@t3tools/pack-cli/store";
import { resolveRegistryRoot } from "@t3tools/pack-cli/registryRoot";

const packsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packs");
const root = resolveRegistryRoot(process.argv[2]);

const registry = makeDirectoryRegistry(makeNodePackStore(), root);

let installed = 0;
let already = 0;
const failures = [];

for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const manifestPath = path.join(packsDir, entry.name, "pack.json");

  let manifestJson;
  try {
    manifestJson = readFileSync(manifestPath, "utf8");
  } catch {
    // A directory without a manifest is not a pack; say so rather than
    // counting it as installed.
    failures.push(`${entry.name}: no pack.json`);
    continue;
  }

  try {
    const manifest = JSON.parse(manifestJson);
    const { name, version, publisher } = manifest.identity;
    const existing = await registry.get({ name, version });
    if (existing !== undefined) {
      already += 1;
      continue;
    }
    await registry.record({ name, publisher: publisher.handle, version, manifestJson });
    installed += 1;
    console.log(`  installed ${publisher.handle}/${name}@${version}`);
  } catch (cause) {
    failures.push(`${entry.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

console.log(
  `\n${installed} installed, ${already} already there, ${failures.length} failed → ${root}`,
);
for (const failure of failures) console.log(`  FAILED  ${failure}`);

// A pack that could not be installed is a pack the agent will not find, which
// is the failure this script exists to prevent. Do not exit 0 on it.
process.exit(failures.length === 0 ? 0 : 1);
