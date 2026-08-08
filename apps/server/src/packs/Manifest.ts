import {
  PackError,
  PackManifest,
  type PackHandle,
  type PackId,
  type PackName,
  type PackTag,
  type PackVersion,
} from "@t3tools/contracts";
import { Effect, Schema } from "effect";

/**
 * The registry's only contact with the inside of a manifest.
 *
 * Everywhere else a manifest is an opaque blob the registry stores whole and
 * hands back whole, so the format can keep moving underneath: when a field is
 * renamed or relocated, this file is the one that has to change.
 */
export interface PackManifestIndex {
  readonly packId: PackId;
  readonly name: PackName;
  readonly version: PackVersion;
  readonly publisherHandle: PackHandle;
  readonly displayName: string;
  readonly summary: string;
  /** One imperative sentence about what the pack does. */
  readonly capabilitySummary: string;
  readonly tags: ReadonlyArray<PackTag>;
}

/** Everything the registry indexes, pulled out of the manifest in one place. */
export function indexManifest(manifest: PackManifest): PackManifestIndex {
  const { identity } = manifest;
  return {
    packId: identity.id,
    name: identity.name,
    version: identity.version,
    publisherHandle: identity.publisher.handle,
    displayName: identity.displayName,
    summary: identity.summary,
    capabilitySummary: manifest.capability.does,
    tags: identity.tags ?? [],
  };
}

const encodeManifestJson = Schema.encodeEffect(Schema.fromJsonString(PackManifest));
const decodeManifestJson = Schema.decodeUnknownEffect(Schema.fromJsonString(PackManifest));

/** Serialises a manifest for storage. The stored bytes are what gets handed back. */
export const toManifestJson = Effect.fn("toManifestJson")(function* (manifest: PackManifest) {
  return yield* encodeManifestJson(manifest).pipe(
    Effect.mapError(
      (cause) =>
        new PackError({
          code: "manifest-invalid",
          message: "Pack manifest could not be stored.",
          cause,
        }),
    ),
  );
});

/**
 * Reads a stored manifest back. This can fail for a row that was written
 * against an older shape of the format, which is why it is an Effect rather
 * than a cast: a version that no longer decodes is reported, not guessed at.
 */
export const fromManifestJson = Effect.fn("fromManifestJson")(function* (json: string) {
  return yield* decodeManifestJson(json).pipe(
    Effect.mapError(
      (cause) =>
        new PackError({
          code: "manifest-invalid",
          message: "Stored pack manifest could not be read.",
          cause,
        }),
    ),
  );
});
