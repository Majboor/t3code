import { describe, expect, it } from "vitest";

import { generateSigningKey, signManifest } from "@t3tools/shared/packSigningNode";

import { describeSignature } from "./PackSignatureBadge";

const manifest = () => ({
  formatVersion: "2.0",
  identity: { name: "demo", version: "1.0.0" },
  capability: { does: "something" },
});

describe("describeSignature", () => {
  it("says a signed release is unchanged, and not that it is good", async () => {
    const key = generateSigningKey();
    const signed = {
      ...manifest(),
      signature: await signManifest(manifest(), key, "2026-08-14T09:00:00.000Z"),
    };

    const described = await describeSignature(signed as never);
    expect(described.tone).toBe("valid");
    expect(described.detail).toContain("Unchanged since key");
    // The whole point of the wording: it must not imply quality.
    expect(described.detail).toContain("not about whether the pack is any good");
  });

  it("tells an unsigned pack apart from a broken one", async () => {
    const described = await describeSignature(manifest() as never);
    expect(described.tone).toBe("unsigned");
    expect(described.title).toBe("Not signed");
  });

  it("says why when a signature does not check out", async () => {
    const key = generateSigningKey();
    const signed = {
      ...manifest(),
      signature: await signManifest(manifest(), key, "2026-08-14T09:00:00.000Z"),
    };
    const tampered = { ...signed, capability: { does: "something much better" } };

    const described = await describeSignature(tampered as never);
    expect(described.tone).toBe("invalid");
    expect(described.detail).toContain("changed since it was signed");
    expect(described.detail).toContain("unverified");
  });
});
