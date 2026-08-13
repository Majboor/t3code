import { describe, expect, it } from "vitest";

import { canonicalJson, manifestDigest, verifyManifest } from "./packSigning.ts";
import { generateSigningKey, signManifest } from "./packSigningNode.ts";

const SIGNED_AT = "2026-08-14T09:00:00.000Z";

const manifest = () => ({
  formatVersion: "2.0",
  identity: { name: "demo", version: "1.0.0", publisher: { handle: "t3demo" } },
  capability: { does: "something" },
  knowledge: { failureModes: [{ id: "one" }, { id: "two" }] },
});

describe("canonicalJson", () => {
  it("gives the same bytes whatever order the keys arrived in", async () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("keeps array order, because that is content and not formatting", async () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("sorts keys at every depth, not only the top", async () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });
});

describe("manifestDigest", () => {
  it("ignores the signature, since a signature cannot cover itself", async () => {
    const unsigned = manifest();
    const withSignature = { ...unsigned, signature: { anything: "here" } };
    expect(await manifestDigest(withSignature)).toBe(await manifestDigest(unsigned));
  });

  it("ignores visibility, which the registry changes after signing by design", async () => {
    // Publishing forces a pack private and opening it up later is a separate
    // act. If either broke the signature, a broken one would stop meaning
    // anything.
    const unsigned = manifest();
    const reopened = { ...unsigned, visibility: { scope: "public" } };
    const closed = { ...unsigned, visibility: { scope: "workspace" } };
    expect(await manifestDigest(reopened)).toBe(await manifestDigest(closed));
  });

  it("changes when any content changes", async () => {
    const edited = { ...manifest(), capability: { does: "something else" } };
    expect(await manifestDigest(edited)).not.toBe(await manifestDigest(manifest()));
  });
});

describe("signing and verifying", () => {
  it("verifies a manifest it just signed", async () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };

    const result = await verifyManifest(signed);
    expect(result.state).toBe("valid");
    expect(result.state === "valid" && result.keyId).toBe(key.keyId);
  });

  it("still verifies after the manifest is re-serialised with different key order", async () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };
    // What a registry round-trip does: same content, keys rebuilt in another
    // order. A replacer array would not do this — it filters keys at every
    // depth and quietly produces a different manifest.
    const reordered = Object.fromEntries(
      Object.entries(signed).toSorted(([left], [right]) => (left < right ? 1 : -1)),
    );

    expect((await verifyManifest(reordered)).state).toBe("valid");
  });

  it("says a manifest is unsigned rather than pretending it failed", async () => {
    expect((await verifyManifest(manifest())).state).toBe("unsigned");
  });

  it("still catches a claim edited under cover of a visibility change", async () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };
    const sneaky = {
      ...signed,
      visibility: { scope: "public" },
      capability: { does: "something much better" },
    };
    expect((await verifyManifest(sneaky)).state).toBe("invalid");
  });

  it("catches an edit made after signing", async () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };
    // Exactly the attack this exists for: someone improves the claims afterwards.
    const tampered = { ...signed, capability: { does: "something much better" } };

    const result = await verifyManifest(tampered);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("changed since it was signed");
  });

  it("catches a signature from a different key, even with the digest fixed up", async () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };
    // The public key is swapped so the signature no longer matches it.
    const swapped = {
      ...signed,
      signature: { ...signed.signature, publicKey: other.publicKey, keyId: other.keyId },
    };

    const result = await verifyManifest(swapped);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("does not match");
  });

  it("refuses an algorithm nobody agreed to, rather than trying it", async () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: await signManifest(manifest(), key, SIGNED_AT) };
    const downgraded = { ...signed, signature: { ...signed.signature, algorithm: "none" } };

    expect((await verifyManifest(downgraded)).state).toBe("invalid");
  });

  it("does not fall over on a signature that is missing its fields", async () => {
    const broken = { ...manifest(), signature: { algorithm: "ed25519" } };
    const result = await verifyManifest(broken);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("missing fields");
  });

  it("produces the same signature twice for the same input", async () => {
    const key = generateSigningKey();
    const first = await signManifest(manifest(), key, SIGNED_AT);
    const second = await signManifest(manifest(), key, SIGNED_AT);
    expect(first.signature).toBe(second.signature);
  });
});
