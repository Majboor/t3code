import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  generateSigningKey,
  manifestDigest,
  signManifest,
  verifyManifest,
} from "./packSigning.ts";

const SIGNED_AT = "2026-08-14T09:00:00.000Z";

const manifest = () => ({
  formatVersion: "2.0",
  identity: { name: "demo", version: "1.0.0", publisher: { handle: "t3demo" } },
  capability: { does: "something" },
  knowledge: { failureModes: [{ id: "one" }, { id: "two" }] },
});

describe("canonicalJson", () => {
  it("gives the same bytes whatever order the keys arrived in", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("keeps array order, because that is content and not formatting", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("sorts keys at every depth, not only the top", () => {
    expect(canonicalJson({ x: { b: 1, a: 2 } })).toBe('{"x":{"a":2,"b":1}}');
  });
});

describe("manifestDigest", () => {
  it("ignores the signature, since a signature cannot cover itself", () => {
    const unsigned = manifest();
    const withSignature = { ...unsigned, signature: { anything: "here" } };
    expect(manifestDigest(withSignature)).toBe(manifestDigest(unsigned));
  });

  it("ignores visibility, which the registry changes after signing by design", () => {
    // Publishing forces a pack private and opening it up later is a separate
    // act. If either broke the signature, a broken one would stop meaning
    // anything.
    const unsigned = manifest();
    const reopened = { ...unsigned, visibility: { scope: "public" } };
    const closed = { ...unsigned, visibility: { scope: "workspace" } };
    expect(manifestDigest(reopened)).toBe(manifestDigest(closed));
  });

  it("changes when any content changes", () => {
    const edited = { ...manifest(), capability: { does: "something else" } };
    expect(manifestDigest(edited)).not.toBe(manifestDigest(manifest()));
  });
});

describe("signing and verifying", () => {
  it("verifies a manifest it just signed", () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };

    const result = verifyManifest(signed);
    expect(result.state).toBe("valid");
    expect(result.state === "valid" && result.keyId).toBe(key.keyId);
  });

  it("still verifies after the manifest is re-serialised with different key order", () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };
    // What a registry round-trip does: same content, keys rebuilt in another
    // order. A replacer array would not do this — it filters keys at every
    // depth and quietly produces a different manifest.
    const reordered = Object.fromEntries(
      Object.entries(signed).toSorted(([left], [right]) => (left < right ? 1 : -1)),
    );

    expect(verifyManifest(reordered).state).toBe("valid");
  });

  it("says a manifest is unsigned rather than pretending it failed", () => {
    expect(verifyManifest(manifest()).state).toBe("unsigned");
  });

  it("still catches a claim edited under cover of a visibility change", () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };
    const sneaky = {
      ...signed,
      visibility: { scope: "public" },
      capability: { does: "something much better" },
    };
    expect(verifyManifest(sneaky).state).toBe("invalid");
  });

  it("catches an edit made after signing", () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };
    // Exactly the attack this exists for: someone improves the claims afterwards.
    const tampered = { ...signed, capability: { does: "something much better" } };

    const result = verifyManifest(tampered);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("changed since it was signed");
  });

  it("catches a signature from a different key, even with the digest fixed up", () => {
    const key = generateSigningKey();
    const other = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };
    // The public key is swapped so the signature no longer matches it.
    const swapped = {
      ...signed,
      signature: { ...signed.signature, publicKey: other.publicKey, keyId: other.keyId },
    };

    const result = verifyManifest(swapped);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("does not match");
  });

  it("refuses an algorithm nobody agreed to, rather than trying it", () => {
    const key = generateSigningKey();
    const signed = { ...manifest(), signature: signManifest(manifest(), key, SIGNED_AT) };
    const downgraded = { ...signed, signature: { ...signed.signature, algorithm: "none" } };

    expect(verifyManifest(downgraded).state).toBe("invalid");
  });

  it("does not fall over on a signature that is missing its fields", () => {
    const broken = { ...manifest(), signature: { algorithm: "ed25519" } };
    const result = verifyManifest(broken);
    expect(result.state).toBe("invalid");
    expect(result.state === "invalid" && result.why).toContain("missing fields");
  });

  it("produces the same signature twice for the same input", () => {
    const key = generateSigningKey();
    const first = signManifest(manifest(), key, SIGNED_AT);
    const second = signManifest(manifest(), key, SIGNED_AT);
    expect(first.signature).toBe(second.signature);
  });
});
