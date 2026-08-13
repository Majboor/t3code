/**
 * Signing and verifying a pack manifest.
 *
 * "Verified" has to mean something a reader can check for themselves, not a
 * badge somebody set. A signature over the manifest is that: it says this
 * release is byte-for-byte what the holder of a named key published, and any
 * edit afterwards — by a registry, a mirror, or whoever is serving it — breaks
 * it. It does not say the pack is good, and nothing here should be read as
 * saying so.
 *
 * Two details do all the work and both are easy to get wrong:
 *
 * - **The signature cannot cover itself.** The manifest holds the signature, so
 *   the hash is taken over the manifest with that field removed. Signing the
 *   whole thing produces something that can never be verified again.
 * - **Key order has to be fixed.** Two manifests with the same content and
 *   different key order hash differently, so a re-serialised manifest would
 *   stop verifying for no reason a person could see.
 *
 * `visibility` is excluded for a third reason, and it is a judgement rather
 * than a mechanic. Who may see a pack is the registry's business and changes
 * after publication by design — publishing forces it private, and opening it up
 * later is a separate deliberate act. Signing it would mean every such act
 * broke the signature, which trains people to ignore a broken one. What the
 * publisher is attesting to is the pack: what it does, what it has learned,
 * what it needs. Not who is allowed to look.
 */
import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";

/** The algorithm the format names. Not configurable, so nothing can downgrade it. */
const ALGORITHM = "ed25519" as const;

/**
 * Serialises with keys in a fixed order at every depth, so the same manifest
 * always produces the same bytes. Arrays keep their order, which is content.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
}

/**
 * The hash a signature is taken over: the manifest without the two fields that
 * legitimately change after signing. Exported because signing and verifying
 * have to agree on it exactly.
 */
export function manifestDigest(manifest: Record<string, unknown>): string {
  const { signature: _signature, visibility: _visibility, ...rest } = manifest;
  return createHash("sha256").update(canonicalJson(rest), "utf8").digest("hex");
}

export interface PackSigningKeyPair {
  readonly keyId: string;
  /** PEM, private. Never leaves the machine that signed. */
  readonly privateKeyPem: string;
  /** Base64 DER, travels in the manifest so a reader can check the signature. */
  readonly publicKey: string;
}

/** A fresh signing identity. The key id is derived from the public key, so it cannot disagree with it. */
export function generateSigningKey(): PackSigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync(ALGORITHM);
  const publicDer = publicKey.export({ type: "spki", format: "der" });
  return {
    keyId: createHash("sha256").update(publicDer).digest("hex").slice(0, 32),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: publicDer.toString("base64"),
  };
}

export interface SignedManifestResult {
  readonly keyId: string;
  readonly algorithm: typeof ALGORITHM;
  readonly publicKey: string;
  readonly manifestSha256: string;
  readonly signature: string;
  readonly signedAt: string;
}

/**
 * Signs the manifest. `signedAt` is passed in rather than read from the clock
 * so that signing is reproducible and testable.
 */
export function signManifest(
  manifest: Record<string, unknown>,
  key: PackSigningKeyPair,
  signedAt: string,
): SignedManifestResult {
  const manifestSha256 = manifestDigest(manifest);
  // ed25519 signs the message itself; passing a digest algorithm here is an error.
  const signature = sign(null, Buffer.from(manifestSha256, "hex"), key.privateKeyPem);
  return {
    keyId: key.keyId,
    algorithm: ALGORITHM,
    publicKey: key.publicKey,
    manifestSha256,
    signature: signature.toString("base64"),
    signedAt,
  };
}

export type PackVerification =
  | { readonly state: "unsigned" }
  | { readonly state: "valid"; readonly keyId: string; readonly signedAt: string }
  | { readonly state: "invalid"; readonly why: string };

/**
 * Checks a manifest against its own signature.
 *
 * A verified signature proves the release is unmodified since the holder of
 * that key signed it. Whether that key belongs to anyone worth trusting is a
 * separate question this function cannot answer, and callers must not present
 * the two as one thing.
 */
export function verifyManifest(manifest: Record<string, unknown>): PackVerification {
  const signature = manifest["signature"];
  if (signature === undefined || signature === null) {
    return { state: "unsigned" };
  }
  if (typeof signature !== "object") {
    return { state: "invalid", why: "the signature is not an object" };
  }

  const entry = signature as Record<string, unknown>;
  const { algorithm, publicKey, manifestSha256, signature: signatureValue, keyId, signedAt } = entry;

  if (algorithm !== ALGORITHM) {
    return { state: "invalid", why: `signed with ${String(algorithm)}, which this does not accept` };
  }
  if (
    typeof publicKey !== "string" ||
    typeof manifestSha256 !== "string" ||
    typeof signatureValue !== "string" ||
    typeof keyId !== "string"
  ) {
    return { state: "invalid", why: "the signature is missing fields" };
  }

  // Check the digest first. A signature that verifies against a hash of
  // something else would otherwise pass while describing a different manifest.
  const actual = manifestDigest(manifest);
  if (actual !== manifestSha256) {
    return { state: "invalid", why: "the manifest has changed since it was signed" };
  }

  const publicKeyObject = {
    key: Buffer.from(publicKey, "base64"),
    format: "der" as const,
    type: "spki" as const,
  };

  let ok = false;
  try {
    ok = verify(
      null,
      Buffer.from(manifestSha256, "hex"),
      publicKeyObject,
      Buffer.from(signatureValue, "base64"),
    );
  } catch {
    return { state: "invalid", why: "the signature could not be read" };
  }

  if (!ok) {
    return { state: "invalid", why: "the signature does not match the key it names" };
  }
  return { state: "valid", keyId, signedAt: typeof signedAt === "string" ? signedAt : "" };
}
