/**
 * Generating a signing key and signing a manifest. Node only, deliberately:
 * signing happens in a CLI on somebody's machine, never in a browser, and
 * keeping it in its own module is what stops a page importing `node:crypto`
 * and failing to boot.
 *
 * Verification lives in `packSigning.ts` and runs anywhere.
 */
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { ALGORITHM, manifestDigest } from "./packSigning.ts";

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
export async function signManifest(
  manifest: Record<string, unknown>,
  key: PackSigningKeyPair,
  signedAt: string,
): Promise<SignedManifestResult> {
  const manifestSha256 = await manifestDigest(manifest);
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
