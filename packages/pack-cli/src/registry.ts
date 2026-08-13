/**
 * The set of packs a caller can reach, laid out as directories under one root.
 *
 * Search matches the scar record as well as the description, because an agent
 * looking for "webhook idempotency" is describing the failure it is about to
 * cause, not the product category it wants — and the pack that already paid for
 * that failure is the one worth returning.
 *
 * @module registry
 */
import { PackCliError } from "./errors.ts";
import {
  DIRECTORY_SUFFIX,
  MANIFEST_FILENAME,
  parseManifestJson,
  readCard,
  readRef,
  type PackCardView,
  type PackManifest,
  type PackRefView,
} from "./manifest.ts";
import { manifestDigest, type SignedManifestResult } from "@t3tools/shared/packSigning";
import type { PackStore } from "./store.ts";

const VERSIONS_DIRECTORY = "versions";
const DEFAULT_SEARCH_LIMIT = 10;

export interface PackRecord {
  readonly ref: PackRefView;
  readonly card: PackCardView;
  readonly manifest: PackManifest;
  readonly directory: string;
}

export interface PackSearchHit {
  readonly record: PackRecord;
  readonly score: number;
  /** Which query terms landed, and where. Lets a caller judge a weak match. */
  readonly matched: ReadonlyArray<string>;
}

export interface PackSearchOutcome {
  readonly hits: ReadonlyArray<PackSearchHit>;
  readonly scanned: number;
  /** Packs in the registry this CLI could not read, named rather than hidden. */
  readonly unreadable: ReadonlyArray<{ readonly directory: string; readonly reason: string }>;
}

export interface PackRegistry {
  readonly root: string;
  readonly search: (input: {
    readonly query: string;
    readonly limit?: number;
    readonly category?: string;
    readonly tag?: string;
  }) => Promise<PackSearchOutcome>;
  readonly get: (input: {
    readonly name: string;
    readonly version?: string;
  }) => Promise<PackRecord | undefined>;
  /**
   * Writes one immutable release. Releases already in the registry are never
   * rewritten: a change is always a new version.
   */
  readonly attachSignature: (input: {
    readonly name: string;
    readonly publisher: string;
    readonly version: string;
    readonly signature: SignedManifestResult;
  }) => Promise<{ readonly attached: boolean; readonly why?: string }>;
  readonly record: (input: {
    readonly name: string;
    readonly publisher: string | undefined;
    readonly version: string;
    readonly manifestJson: string;
  }) => Promise<{ readonly directory: string; readonly versionPath: string }>;
}

function packDirectoryName(name: string, publisher: string | undefined): string {
  return `${publisher !== undefined ? `${publisher}-` : ""}${name}${DIRECTORY_SUFFIX}`;
}

function tokenise(query: string): ReadonlyArray<string> {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1);
}

/**
 * Weighted so a pack whose recorded failures match the query outranks one that
 * merely mentions the word in a tag.
 */
const FIELD_WEIGHTS = {
  name: 5,
  summary: 3,
  does: 3,
  failureMode: 4,
  integration: 2,
  tag: 2,
} as const;

function haystacks(card: PackCardView): ReadonlyArray<{ weight: number; text: string }> {
  const entries: Array<{ weight: number; text: string }> = [
    { weight: FIELD_WEIGHTS.name, text: `${card.ref.name} ${card.displayName ?? ""}` },
    { weight: FIELD_WEIGHTS.summary, text: card.summary ?? "" },
    { weight: FIELD_WEIGHTS.does, text: card.does ?? "" },
    {
      weight: FIELD_WEIGHTS.tag,
      text: [...(card.tags ?? []), ...(card.categories ?? [])].join(" "),
    },
  ];
  for (const failureMode of [...card.handles, ...card.openFailureModes]) {
    entries.push({
      weight: FIELD_WEIGHTS.failureMode,
      text: [failureMode.symptom, failureMode.trigger, ...(failureMode.triggerKinds ?? [])]
        .filter((part): part is string => part !== undefined)
        .join(" "),
    });
  }
  return entries;
}

function scoreCard(
  card: PackCardView,
  tokens: ReadonlyArray<string>,
): { score: number; matched: ReadonlyArray<string> } {
  if (tokens.length === 0) {
    return { score: 1, matched: [] };
  }
  const fields = haystacks(card).map((field) => ({
    weight: field.weight,
    text: field.text.toLowerCase(),
  }));
  const matched: Array<string> = [];
  let score = 0;
  for (const token of tokens) {
    let best = 0;
    for (const field of fields) {
      if (field.text.includes(token)) {
        best = Math.max(best, field.weight);
      }
    }
    if (best > 0) {
      matched.push(token);
      score += best;
    }
  }
  return { score, matched };
}

/** Ties break on what has survived, which is the number nobody can inflate. */
function compareHits(left: PackSearchHit, right: PackSearchHit): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }
  const surviving =
    (right.record.card.signals.deploymentsSurviving ?? 0) -
    (left.record.card.signals.deploymentsSurviving ?? 0);
  return surviving !== 0 ? surviving : left.record.ref.name.localeCompare(right.record.ref.name);
}

export function makeDirectoryRegistry(store: PackStore, root: string): PackRegistry {
  const readPackDirectory = async (
    directoryName: string,
  ): Promise<
    | { readonly ok: true; readonly record: PackRecord }
    | { readonly ok: false; readonly reason: string }
  > => {
    const directory = store.resolve(root, directoryName);
    const source = await store.read(store.resolve(directory, MANIFEST_FILENAME));
    if (source === undefined) {
      return { ok: false, reason: `No ${MANIFEST_FILENAME} in ${directoryName}.` };
    }
    const read = parseManifestJson(source);
    if (!read.ok) {
      return { ok: false, reason: read.message };
    }
    return {
      ok: true,
      record: {
        ref: readRef(read.manifest),
        card: readCard(read.manifest),
        manifest: read.manifest,
        directory,
      },
    };
  };

  const listPackDirectories = async (): Promise<ReadonlyArray<string>> => {
    const entries = await store.list(root);
    return entries
      .filter((entry) => entry.kind === "directory" && entry.name.endsWith(DIRECTORY_SUFFIX))
      .map((entry) => entry.name);
  };

  return {
    root,

    search: async (input) => {
      const tokens = tokenise(input.query);
      const directories = await listPackDirectories();
      const hits: Array<PackSearchHit> = [];
      const unreadable: Array<{ directory: string; reason: string }> = [];

      for (const directoryName of directories) {
        const read = await readPackDirectory(directoryName);
        if (!read.ok) {
          unreadable.push({ directory: directoryName, reason: read.reason });
          continue;
        }
        const { card } = read.record;
        if (input.category !== undefined && !(card.categories ?? []).includes(input.category)) {
          continue;
        }
        if (input.tag !== undefined && !(card.tags ?? []).includes(input.tag)) {
          continue;
        }
        const scored = scoreCard(card, tokens);
        if (scored.score > 0) {
          hits.push({ record: read.record, score: scored.score, matched: scored.matched });
        }
      }

      return {
        hits: hits.toSorted(compareHits).slice(0, input.limit ?? DEFAULT_SEARCH_LIMIT),
        scanned: directories.length,
        unreadable,
      };
    },

    get: async (input) => {
      const requested = input.name.includes("/")
        ? input.name.slice(input.name.indexOf("/") + 1)
        : input.name;
      const publisher = input.name.includes("/")
        ? input.name.slice(0, input.name.indexOf("/"))
        : undefined;

      for (const directoryName of await listPackDirectories()) {
        const read = await readPackDirectory(directoryName);
        if (!read.ok) {
          continue;
        }
        const { ref } = read.record;
        if (ref.name !== requested) {
          continue;
        }
        if (publisher !== undefined && ref.publisher !== publisher) {
          continue;
        }
        if (input.version === undefined || ref.version === input.version) {
          return read.record;
        }
        // An older release is kept beside the latest rather than in place of it.
        const pinned = await store.read(
          store.resolve(read.record.directory, VERSIONS_DIRECTORY, `${input.version}.json`),
        );
        if (pinned === undefined) {
          return undefined;
        }
        const parsed = parseManifestJson(pinned);
        if (!parsed.ok) {
          throw new PackCliError("manifest-invalid", parsed.message, {
            pack: ref.qualified,
            version: input.version,
          });
        }
        return {
          ref: readRef(parsed.manifest),
          card: readCard(parsed.manifest),
          manifest: parsed.manifest,
          directory: read.record.directory,
        };
      }
      return undefined;
    },

    /**
     * Attaches a signature to a release already in the registry.
     *
     * Adding one is not "a change" in the sense the version guard protects: it
     * asserts nothing new about the pack, it only lets a reader check what is
     * already there. The digest is compared against the stored bytes first, so
     * a signature describing some other manifest cannot be smuggled in.
     */
    attachSignature: async (input) => {
      const directory = store.resolve(root, packDirectoryName(input.name, input.publisher));
      const versionPath = store.resolve(directory, VERSIONS_DIRECTORY, `${input.version}.json`);
      const stored = await store.read(versionPath);
      if (stored === undefined) {
        return { attached: false, why: "that version is not in this registry" };
      }

      const manifest = JSON.parse(stored) as Record<string, unknown>;
      if (manifestDigest(manifest) !== input.signature.manifestSha256) {
        return {
          attached: false,
          why: "the signature describes a different manifest than the one published",
        };
      }

      const signed = `${JSON.stringify({ ...manifest, signature: input.signature }, null, 2)}\n`;
      await store.write(versionPath, signed);
      await store.write(store.resolve(directory, MANIFEST_FILENAME), signed);
      return { attached: true };
    },

    record: async (input) => {
      const directory = store.resolve(root, packDirectoryName(input.name, input.publisher));
      const versionPath = store.resolve(directory, VERSIONS_DIRECTORY, `${input.version}.json`);
      if ((await store.read(versionPath)) !== undefined) {
        throw new PackCliError(
          "version-exists",
          `${input.name}@${input.version} is already in this registry. A change is always a new version.`,
          { pack: input.name, version: input.version, registry: root },
        );
      }
      await store.makeDirectory(directory);
      await store.makeDirectory(store.resolve(directory, VERSIONS_DIRECTORY));
      await store.write(versionPath, input.manifestJson);
      await store.write(store.resolve(directory, MANIFEST_FILENAME), input.manifestJson);
      return { directory, versionPath };
    },
  };
}
