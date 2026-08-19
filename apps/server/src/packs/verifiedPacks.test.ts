import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TenantId, WorkspaceId } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  getVerifiedPack,
  isVerifiedPackId,
  listVerifiedPacks,
  resetVerifiedPackCache,
} from "./verifiedPacks.ts";

const tenantId = TenantId.make("tenant-verified");
const workspaceId = WorkspaceId.make("workspace-verified");

/**
 * The registry the rest of the server suite runs with is deliberately off, so
 * these tests point at a real one they build themselves. Pointing at the
 * machine's own would make the result depend on what is installed here.
 */
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
 * A registry with one pack in it, built here rather than pointed at.
 *
 * The repo's own `packs/` directory is source layout — `ssh-deploy/pack.json`
 * — and a registry expects `<publisher>-<name>.pack/` with a `versions/`
 * directory beside the manifest. They are not the same shape, so this copies
 * an installed pack rather than reading the repo, and fails loudly if there is
 * none to copy rather than passing on an empty result.
 */
function buildRegistry(): string {
  const installed = path.join(os.homedir(), ".t3code", "packs");
  const source = fs
    .readdirSync(installed, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith("ssh-deploy.pack"));
  if (source === undefined) {
    throw new Error(
      `No ssh-deploy pack under ${installed}; this test would otherwise assert nothing.`,
    );
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-verified-"));
  fs.cpSync(path.join(installed, source.name), path.join(root, source.name), { recursive: true });
  return root;
}

describe("listVerifiedPacks", () => {
  it("reads the packs that ship with the product", async () => {
    // If this stops returning them, the UI has gone blind to the packs the
    // agent is about to use.
    const packs = await withRegistry(buildRegistry(), () =>
      listVerifiedPacks(tenantId, workspaceId),
    );
    expect(packs.length).toBeGreaterThan(0);
    expect(packs.map((pack) => pack.name)).toContain("ssh-deploy");
  });

  it("stamps them with the workspace that asked, not the one that published", async () => {
    const packs = await withRegistry(buildRegistry(), () =>
      listVerifiedPacks(tenantId, workspaceId),
    );
    expect(packs.every((pack) => pack.tenantId === tenantId)).toBe(true);
    expect(packs.every((pack) => pack.workspaceId === workspaceId)).toBe(true);
  });

  it("marks them as shipped rather than published by a tenant", async () => {
    const packs = await withRegistry(buildRegistry(), () =>
      listVerifiedPacks(tenantId, workspaceId),
    );
    expect(packs.every((pack) => isVerifiedPackId(pack.packId))).toBe(true);
  });

  it("returns nothing, rather than failing, when the registry is not there", async () => {
    const missing = path.join(os.tmpdir(), `t3-no-registry-${Date.now()}`);
    expect(await withRegistry(missing, () => listVerifiedPacks(tenantId, workspaceId))).toEqual([]);
  });

  it("can be turned off entirely", async () => {
    expect(await withRegistry("none", () => listVerifiedPacks(tenantId, workspaceId))).toEqual([]);
  });

  /**
   * A shipped pack is addressed by its name, and names are only unique per
   * publisher. Two publishers shipping an `ssh-deploy` therefore land on one
   * `verified:ssh-deploy`, and a listing that offered both would have one of
   * them open as the other.
   *
   * Widening the id to carry the publisher would fix that and orphan every
   * enablement already keyed on the narrow one, so the id stays as it is and
   * only one of the two is offered — the same one `getVerifiedPack` opens.
   */
  it("offers one pack per id when two publishers ship the same name", async () => {
    const root = buildRegistry();
    const original = fs
      .readdirSync(root, { withFileTypes: true })
      .find((entry) => entry.isDirectory());
    if (original === undefined) {
      throw new Error("The registry this test built has nothing in it.");
    }
    const copy = path.join(root, `acme-${original.name.split("-").slice(1).join("-")}`);
    fs.cpSync(path.join(root, original.name), copy, { recursive: true });
    const manifestPath = path.join(copy, "pack.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.identity.publisher = { ...manifest.identity.publisher, handle: "acme" };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const packs = await withRegistry(root, () => listVerifiedPacks(tenantId, workspaceId));
    const deploys = packs.filter((pack) => pack.name === "ssh-deploy");
    expect(deploys.length).toBe(1);

    // Whichever one is listed is the one that opens: a page showing the pack
    // next door is worse than a pack that was never offered.
    const listed = deploys[0];
    const opened = await withRegistry(root, () => getVerifiedPack(listed?.packId ?? ""));
    expect(opened?.manifest.identity.publisher.handle).toBe(listed?.publisherHandle);
  });
});
