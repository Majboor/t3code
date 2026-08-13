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
/**
 * WebCrypto, which node and every browser both have. Using it rather than
 * `node:crypto` is what lets a page verify a pack at all: importing the node
 * module in the browser does not fail at build time, it fails when the page
 * runs, and the page simply does not appear.
 */
const subtle = globalThis.crypto.subtle;

/** The algorithm the format names. Not configurable, so nothing can downgrade it. */
export const ALGORITHM = "ed25519" as const;

/** WebCrypto spells it differently from node. */
const WEB_ALGORITHM = "Ed25519" as const;

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes.buffer;
}

function fromBase64(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

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
export async function manifestDigest(manifest: Record<string, unknown>): Promise<string> {
  const { signature: _signature, visibility: _visibility, ...rest } = manifest;
  const bytes = new TextEncoder().encode(canonicalJson(rest));
  return toHex(await subtle.digest("SHA-256", bytes.buffer as ArrayBuffer));
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
export async function verifyManifest(
  manifest: Record<string, unknown>,
): Promise<PackVerification> {
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
  const actual = await manifestDigest(manifest);
  if (actual !== manifestSha256) {
    return { state: "invalid", why: "the manifest has changed since it was signed" };
  }

  try {
    const key = await subtle.importKey("spki", fromBase64(publicKey), WEB_ALGORITHM, false, [
      "verify",
    ]);
    const ok = await subtle.verify(
      WEB_ALGORITHM,
      key,
      fromBase64(signatureValue),
      fromHex(manifestSha256),
    );
    if (!ok) {
      return { state: "invalid", why: "the signature does not match the key it names" };
    }
  } catch {
    return { state: "invalid", why: "the signature could not be read" };
  }

  return { state: "valid", keyId, signedAt: typeof signedAt === "string" ? signedAt : "" };
}
