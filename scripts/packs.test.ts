import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { makeDirectoryRegistry } from "@t3tools/pack-cli/registry";
import { makeNodePackStore } from "@t3tools/pack-cli/store";

import { verifyManifest } from "@t3tools/shared/packSigning";
import { describe, expect, it } from "vitest";

const PACKS_DIR = path.join(import.meta.dirname, "..", "packs");

const packNames = readdirSync(PACKS_DIR).filter((entry) => !entry.endsWith(".md"));

/**
 * The packs in this repository carry knowledge earned from real deployments, and
 * a signature is what lets a reader check the copy they are holding is the one
 * that was published. Editing a manifest without re-signing leaves a pack that
 * looks signed and does not verify, which is worse than an unsigned one — so
 * that is the thing worth failing a build over.
 */
describe("the packs in this repository", () => {
  it("has some", () => {
    expect(packNames.length).toBeGreaterThan(0);
  });

  it.each(packNames)("%s verifies against its own signature", async (name) => {
    const manifest = JSON.parse(
      readFileSync(path.join(PACKS_DIR, name, "pack.json"), "utf8"),
    ) as Record<string, unknown>;

    const result = await verifyManifest(manifest);
    // Naming the reason matters: "unsigned" means somebody forgot to sign, and
    // "invalid" means somebody edited after signing. They need different fixes.
    expect(result.state === "invalid" ? result.why : result.state).toBe("valid");
  });

  it.each(packNames)("%s says what it is for", (name) => {
    const manifest = JSON.parse(readFileSync(path.join(PACKS_DIR, name, "pack.json"), "utf8"));
    expect(manifest.capability.does.length).toBeGreaterThan(20);
    expect(manifest.provenance.handover.summary).not.toMatch(/^TODO/i);
  });
});

describe("installing the packs that ship with the product", () => {
  it("turns every source pack into one a registry can serve", async () => {
    // The repo keeps packs in source layout and the app reads registry layout.
    // Nothing converted one to the other, so on a fresh checkout the prompt bar
    // had nothing to offer and `t3 pack search` found nothing — while these
    // five sat in the repo. This is that conversion, checked.
    const root = path.join(mkdtempSync(path.join(tmpdir(), "t3-install-")), "packs");
    execFileSync("bun", [path.join(import.meta.dirname, "install-packs.mjs"), root], {
      encoding: "utf8",
    });

    const registry = makeDirectoryRegistry(makeNodePackStore(), root);
    const found = await registry.search({ query: "" });
    expect(found.hits.length).toBe(packNames.length);
    expect(found.hits.map((hit) => hit.record.ref.name)).toContain("ssh-deploy");
  });

  it("leaves the signature byte-for-byte intact", async () => {
    // Installing is a copy, not a rewrite. A pack that arrives unverifiable is
    // worse than one that never arrived, because the badge is the claim.
    const root = path.join(mkdtempSync(path.join(tmpdir(), "t3-install-")), "packs");
    execFileSync("bun", [path.join(import.meta.dirname, "install-packs.mjs"), root], {
      encoding: "utf8",
    });

    const record = await makeDirectoryRegistry(makeNodePackStore(), root).get({
      name: "ssh-deploy",
    });
    expect(record).toBeDefined();
    const verified = await verifyManifest(record!.manifest as never);
    // Report the reason on failure rather than just the state, so a broken
    // install says what it broke.
    expect(verified.state === "invalid" ? verified.why : verified.state).toBe("valid");
  });
});
