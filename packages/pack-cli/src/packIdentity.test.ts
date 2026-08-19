import { describe, expect, it } from "vitest";

import { conflictFor, derivePackId, resolvePackIds, type PackIdClaim } from "./packIdentity.ts";

const sshDeploy: PackIdClaim = {
  publisher: "t3demo",
  name: "ssh-deploy",
  id: "pack_c7f9cb58f6a544e7b16c",
};
/** The pack `ssh-deploy` was renamed from, still installed beside it. */
const sshFlaskDeploy: PackIdClaim = {
  publisher: "t3demo",
  name: "ssh-flask-deploy",
  id: "pack_c7f9cb58f6a544e7b16c",
};

describe("derivePackId", () => {
  /**
   * The bug this file exists for: two packs that share everything a person
   * would think of as identity — the same publisher, the same lineage, the
   * same first release, near enough the same title and the same capability —
   * and differ only in the one thing a registry keys on.
   */
  it("separates packs that share everything except their name", () => {
    const shared = { publisher: "t3demo", id: "pack_c7f9cb58f6a544e7b16c" } as const;
    const left = derivePackId({ ...shared, name: "ssh-deploy" });
    const right = derivePackId({ ...shared, name: "ssh-flask-deploy" });
    expect(left).not.toBe(right);
  });

  it("separates the same name published by two people", () => {
    expect(derivePackId({ publisher: "acme", name: "stripe-checkout" })).not.toBe(
      derivePackId({ publisher: "waleed", name: "stripe-checkout" }),
    );
  });

  it("is stable across releases, because a version is not an identity", () => {
    expect(derivePackId({ publisher: "t3demo", name: "ssh-deploy" })).toBe(
      derivePackId({ publisher: "t3demo", name: "ssh-deploy" }),
    );
  });
});

describe("resolvePackIds", () => {
  it("leaves an id alone when one pack claims it", () => {
    const resolved = resolvePackIds([sshDeploy]);
    expect(resolved.served.get(derivePackId(sshDeploy))).toBe("pack_c7f9cb58f6a544e7b16c");
    expect(resolved.conflicts).toEqual([]);
  });

  /**
   * Neither, on purpose. Whichever one kept it, the other's page would be one
   * click away from serving it — and there is no fact in the registry that says
   * which of the two the id was minted for.
   */
  it("serves a contested id to neither pack", () => {
    const resolved = resolvePackIds([sshDeploy, sshFlaskDeploy]);
    expect(resolved.served.get(derivePackId(sshDeploy))).toBe("pack:t3demo/ssh-deploy");
    expect(resolved.served.get(derivePackId(sshFlaskDeploy))).toBe("pack:t3demo/ssh-flask-deploy");
  });

  it("names both claimants rather than healing quietly", () => {
    const resolved = resolvePackIds([sshFlaskDeploy, sshDeploy]);
    expect(resolved.conflicts).toEqual([
      {
        id: "pack_c7f9cb58f6a544e7b16c",
        claimedBy: ["t3demo/ssh-deploy", "t3demo/ssh-flask-deploy"],
      },
    ]);
    expect(conflictFor(resolved, sshDeploy)?.id).toBe("pack_c7f9cb58f6a544e7b16c");
    expect(
      conflictFor(resolved, { publisher: "t3demo", name: "pdf-delivery", id: "pack_pdf" }),
    ).toBe(undefined);
  });

  it("gives a pack with no id at all an address of its own", () => {
    const resolved = resolvePackIds([{ publisher: "t3demo", name: "pdf-delivery", id: undefined }]);
    expect(resolved.served.get("pack:t3demo/pdf-delivery")).toBe("pack:t3demo/pdf-delivery");
  });

  /**
   * A manifest cannot take the address another pack would fall back to. Without
   * this the fix would move the collision rather than remove it.
   */
  it("refuses an id that is another pack's derived address", () => {
    const resolved = resolvePackIds([
      { publisher: "t3demo", name: "impostor", id: "pack:t3demo/ssh-deploy" },
      { publisher: "t3demo", name: "ssh-deploy", id: undefined },
    ]);
    expect(resolved.served.get("pack:t3demo/impostor")).toBe("pack:t3demo/impostor");
    expect(resolved.served.get("pack:t3demo/ssh-deploy")).toBe("pack:t3demo/ssh-deploy");
  });

  it("never serves one id twice, whatever the manifests claim", () => {
    const claims: ReadonlyArray<PackIdClaim> = [
      sshDeploy,
      sshFlaskDeploy,
      { publisher: "t3demo", name: "impostor", id: "pack:t3demo/ssh-deploy" },
      { publisher: "acme", name: "ssh-deploy", id: "pack_c7f9cb58f6a544e7b16c" },
      { publisher: "acme", name: "pdf-delivery", id: undefined },
    ];
    const served = [...resolvePackIds(claims).served.values()];
    expect(new Set(served).size).toBe(claims.length);
  });
});
