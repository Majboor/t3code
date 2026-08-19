import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { makeDirectoryRegistry } from "@t3tools/pack-cli/registry";
import { makeNodePackStore } from "@t3tools/pack-cli/store";
import { afterEach, describe, expect, it } from "vitest";

import type { WorkspaceOrigin } from "../deploy/cliOutput.ts";

import { packPageLinks, type PackLinkTarget } from "./packLinks.ts";
import { getVerifiedPack, resetVerifiedPackCache } from "./verifiedPacks.ts";

const workspace: WorkspaceOrigin = { origin: "http://127.0.0.1:3773", observed: true };

function withRegistry<T>(root: string | "none", run: () => Promise<T>): Promise<T> {
  process.env["T3CODE_VERIFIED_PACKS"] = root;
  resetVerifiedPackCache();
  return run();
}

afterEach(() => {
  process.env["T3CODE_VERIFIED_PACKS"] = "none";
  resetVerifiedPackCache();
});

/**
 * A registry holding the packs this machine has installed.
 *
 * Copied rather than pointed at so a test cannot write to somebody's own
 * registry, and taken from real packs rather than a fixture because the bug
 * this file is about only shows up on manifests carrying real ids — including
 * the one id `ssh-deploy` and `ssh-flask-deploy` both claim.
 */
function buildRegistry(): string {
  const installed = path.join(os.homedir(), ".t3code", "packs");
  const sources = fs.existsSync(installed)
    ? fs
        .readdirSync(installed, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.endsWith(".pack"))
        // A registry search answers with a page of results, so a machine with
        // a large registry would have this test asserting about which packs
        // fell off the end of it rather than about addresses.
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .slice(0, 8)
    : [];
  if (sources.length === 0) {
    throw new Error(
      `No packs under ${installed}; this test would otherwise assert nothing. Run scripts/install-packs.mjs.`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pack-links-"));
  for (const source of sources) {
    fs.cpSync(path.join(installed, source.name), path.join(root, source.name), {
      recursive: true,
    });
  }
  return root;
}

/**
 * The packs exactly as `t3 pack search` hands them to the link block: the
 * registry's served id and the name off the same record.
 *
 * Read through `makeDirectoryRegistry` rather than written out by hand,
 * because the id the CLI passes in is whatever that registry decided — a
 * manifest id when one pack claims it, a derived `pack:<publisher>/<name>` when
 * two do. A fixture would pin this file against a spelling instead of against
 * the thing the CLI actually prints.
 */
async function searchedPacks(root: string): Promise<ReadonlyArray<PackLinkTarget>> {
  const registry = makeDirectoryRegistry(makeNodePackStore(), root);
  const outcome = await registry.search({ query: "", limit: 50 });
  return outcome.hits.flatMap((hit) =>
    hit.record.ref.id === undefined
      ? []
      : [
          {
            name: hit.record.ref.name,
            id: hit.record.ref.id,
            qualified: hit.record.ref.qualified,
          },
        ],
  );
}

/** The pack id back out of a printed link, decoded the way the router decodes it. */
function packIdInLink(line: string): string | undefined {
  const url = /(https?:\/\/\S+)/.exec(line)?.[1];
  if (url === undefined) return undefined;
  return decodeURIComponent(new URL(url).pathname.replace(/^\/pack\//, ""));
}

describe("the links printed under a pack search", () => {
  /**
   * The test this file exists for. Every address the CLI prints is fed to the
   * same function the pack page reads through, and has to open the pack it was
   * printed for — not some other pack, and not nothing.
   */
  it("prints an address the pack page resolves, for every pack in the registry", async () => {
    const root = buildRegistry();
    const packs = await searchedPacks(root);
    expect(packs.length).toBeGreaterThan(0);

    const lines = await withRegistry(root, () =>
      packPageLinks({ packs, registryRoot: root, workspace }),
    );
    const linked = lines.filter((line) => line.includes("http"));
    expect(linked.length).toBe(packs.length);

    for (const [index, line] of linked.entries()) {
      const packId = packIdInLink(line);
      expect(packId, line).toBeDefined();
      const opened = await withRegistry(root, () => getVerifiedPack(packId ?? ""));
      // Named rather than merely present: an address that opens the pack next
      // door is worse than one that opens nothing, because the page looks fine.
      expect(opened?.manifest.identity.name, line).toBe(packs[index]?.name);
    }
  });

  /**
   * The bug in one assertion. The registry's own id — a manifest id, or the
   * derived address a contested one falls back to — is not something the pack
   * page can open, which is why it must never be what gets printed.
   */
  it("does not print the id the registry serves the pack under", async () => {
    const root = buildRegistry();
    const packs = await searchedPacks(root);

    const lines = await withRegistry(root, () =>
      packPageLinks({ packs, registryRoot: root, workspace }),
    );
    for (const pack of packs) {
      expect(await withRegistry(root, () => getVerifiedPack(pack.id))).toBeUndefined();
      expect(lines.join("\n")).not.toContain(`/pack/${encodeURIComponent(pack.id)}`);
    }
  });

  /**
   * Two publishers shipping one name land on one `verified:` id, and the
   * workspace offers only one of them. The other has no page, and a line
   * saying so is the difference between a reader who knows that and one who
   * thinks the link was forgotten.
   */
  it("says so out loud when a pack is shadowed by its namesake", async () => {
    const root = buildRegistry();
    const original = fs
      .readdirSync(root, { withFileTypes: true })
      .find((entry) => entry.isDirectory() && entry.name.endsWith("ssh-deploy.pack"));
    if (original === undefined) {
      throw new Error("The registry this test built has no ssh-deploy in it.");
    }
    const copy = path.join(root, `acme-${original.name.split("-").slice(1).join("-")}`);
    fs.cpSync(path.join(root, original.name), copy, { recursive: true });
    const manifestPath = path.join(copy, "pack.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.identity.publisher = { ...manifest.identity.publisher, handle: "acme" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const packs = await searchedPacks(root);
    const lines = await withRegistry(root, () =>
      packPageLinks({ packs, registryRoot: root, workspace }),
    );

    const shadowed = lines.filter((line) => line.includes("no page"));
    expect(shadowed.length).toBe(1);
    expect(shadowed[0]).toContain("shadowed by another pack");
    expect(shadowed[0]).toContain("served as verified:ssh-deploy");
    // The shadowed line names which of the two same-named results it is about.
    expect(shadowed[0]).toMatch(/(acme|t3demo)\/ssh-deploy@/);
    // And the one that is linked is the one that opens.
    const linked = lines.find((line) => line.startsWith("ssh-deploy: http"));
    const opened = await withRegistry(root, () => getVerifiedPack(packIdInLink(linked ?? "") ?? ""));
    expect(opened?.manifest.identity.name).toBe("ssh-deploy");
  });

  /**
   * `--registry` points the CLI at packs this workspace does not serve. There
   * is no address for those, and inventing one that 404s is exactly the
   * failure this file is here to prevent.
   */
  it("prints no links at all for a registry this workspace does not serve", async () => {
    const root = buildRegistry();
    const packs = await searchedPacks(root);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "t3-other-registry-"));

    const lines = await withRegistry(elsewhere, () =>
      packPageLinks({ packs, registryRoot: root, workspace }),
    );
    expect(lines.join("\n")).not.toContain("http");
    expect(lines.join("\n")).toContain(root);
    expect(lines.join("\n")).toContain(elsewhere);
  });

  it("says nothing about pages when the search found nothing", async () => {
    const root = buildRegistry();
    expect(
      await withRegistry(root, () => packPageLinks({ packs: [], registryRoot: root, workspace })),
    ).toEqual([]);
  });
});
