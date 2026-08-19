import { createHash } from "node:crypto";

import {
  PackError,
  PackWorkspaceKeyId,
  UserId,
  type PackManifest,
  type PackVisibility,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Stream } from "effect";

import { getVerifiedPack, isVerifiedPackId, listVerifiedPacks } from "../verifiedPacks.ts";

import {
  fromManifestJson,
  indexManifest,
  toManifestJson,
  type PackManifestIndex,
} from "../Manifest.ts";
import {
  PackRegistryService,
  type PackActor,
  type PackRegistryServiceShape,
  type PackRegistryStreamEvent,
  type PackViewerScope,
  type PackWorkspaceScope,
} from "../Services/PackRegistryService.ts";
import {
  PackRepository,
  type PackRegistryEntry,
  type PackRegistryVersion,
} from "../Services/PackRepository.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { TenancyRepository } from "../../persistence/Services/Tenancy.ts";

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A workspace's stable handle. Derived rather than stored so two releases from
 * the same workspace prove a shared origin, while the hash keeps the tenancy
 * ids out of anything that travels with the pack.
 */
function workspaceKeyId(scope: PackWorkspaceScope) {
  return PackWorkspaceKeyId.make(
    createHash("sha256").update(`${scope.tenantId}:${scope.workspaceId}`).digest("hex"),
  );
}

/**
 * What a pack gets when it is first published. Private to the workspace that
 * cut it: a deploy always produces a pack, and a scar record means nothing if
 * every abandoned first attempt is sitting next to it.
 */
function workspacePrivateVisibility(scope: PackWorkspaceScope): PackVisibility {
  return {
    scope: "workspace",
    workspaceKeyId: workspaceKeyId(scope),
    workspaceId: scope.workspaceId,
  };
}

/** Whether this caller may open the pack at all, by id. */
function canRead(entry: PackRegistryEntry, viewer: PackViewerScope): boolean {
  switch (entry.visibility.scope) {
    case "public":
      return true;
    // Link-only. Whoever holds the id may open it; no listing ever offers it.
    case "unlisted":
      return true;
    case "workspace":
      return entry.tenantId === viewer.tenantId && entry.workspaceId === viewer.workspaceId;
    case "tenant":
      return entry.tenantId === viewer.tenantId;
    case "organization":
      return (viewer.organizationIds ?? []).includes(entry.visibility.organizationId);
  }
}

/** Whether the pack belongs in this caller's listings, which unlisted never does. */
function isListedTo(entry: PackRegistryEntry, viewer: PackViewerScope): boolean {
  return entry.visibility.scope !== "unlisted" && canRead(entry, viewer);
}

/**
 * A visibility a workspace is allowed to hand its own pack. The scoped variants
 * carry the boundary they name, so a workspace cannot list its pack inside
 * somebody else's tenant by writing their id into the request.
 */
function ownsVisibility(entry: PackRegistryEntry, visibility: PackVisibility): boolean {
  switch (visibility.scope) {
    case "workspace":
      return visibility.workspaceId === undefined || visibility.workspaceId === entry.workspaceId;
    case "tenant":
      return visibility.tenantId === entry.tenantId;
    // Checked against the actor's own memberships instead; there is no id on the
    // entry that could confirm an organization.
    case "organization":
    case "unlisted":
    case "public":
      return true;
  }
}

function toEntry(input: {
  readonly scope: PackWorkspaceScope;
  readonly index: PackManifestIndex;
  readonly visibility: PackVisibility;
  readonly createdAt: string;
}): PackRegistryEntry {
  return {
    packId: input.index.packId,
    tenantId: input.scope.tenantId,
    workspaceId: input.scope.workspaceId,
    name: input.index.name,
    publisherHandle: input.index.publisherHandle,
    displayName: input.index.displayName,
    summary: input.index.summary,
    capabilitySummary: input.index.capabilitySummary,
    tags: input.index.tags,
    visibility: input.visibility,
    latestVersion: input.index.version,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  };
}

const makePackRegistryService = Effect.gen(function* () {
  const repository = yield* PackRepository;
  const collaboration = yield* CollaborationService;
  const tenancy = yield* TenancyRepository;
  const events = yield* PubSub.unbounded<PackRegistryStreamEvent>();

  /**
   * Every code the pack format defines describes something about a pack, so a
   * store that cannot be reached is a defect rather than a claim that the pack
   * is missing or malformed.
   */
  const stored = <A, E>(effect: Effect.Effect<A, E>) => effect.pipe(Effect.orDie);

  const requireEditRights = Effect.fn("requireEditRights")(function* (
    actor: PackActor,
    scope: PackWorkspaceScope,
  ) {
    const { mayRun } = yield* stored(collaboration.checkWriteAccessForTurn(actor, scope));
    if (!mayRun) {
      return yield* new PackError({
        code: "visibility-forbidden",
        message: "Publishing to the registry needs edit rights in the workspace.",
      });
    }
  });

  const loadEntry = Effect.fn("loadEntry")(function* (packId: PackRegistryEntry["packId"]) {
    const found = yield* stored(repository.findEntry({ packId }));
    if (Option.isNone(found)) {
      return yield* new PackError({
        code: "pack-not-found",
        message: "Pack was not found in the registry.",
      });
    }
    return found.value;
  });

  /** Reads a pack the caller is allowed to see, or refuses without confirming it exists. */
  const loadVisibleEntry = Effect.fn("loadVisibleEntry")(function* (
    viewer: PackViewerScope,
    packId: PackRegistryEntry["packId"],
  ) {
    const entry = yield* loadEntry(packId);
    if (!canRead(entry, viewer)) {
      // A private pack is not "forbidden", it is nothing: saying otherwise
      // tells a stranger which packs a workspace holds.
      return yield* new PackError({
        code: "pack-not-found",
        message: "Pack was not found in the registry.",
      });
    }
    return entry;
  });

  /**
   * The one path that adds a release. It writes a version row and moves the
   * entry's projection onto it; it never rewrites a version that already exists.
   */
  const appendVersion = Effect.fn("appendVersion")(function* (input: {
    readonly actor: PackActor;
    readonly entry: PackRegistryEntry;
    readonly manifest: PackManifest;
    readonly index: PackManifestIndex;
  }) {
    const existing = yield* stored(
      repository.findVersion({ packId: input.entry.packId, version: input.index.version }),
    );
    if (Option.isSome(existing)) {
      return yield* new PackError({
        code: "version-exists",
        message: `Pack version ${input.index.version} is already published. Publish a new version instead.`,
      });
    }

    const publishedAt = nowIso();
    const manifestJson = yield* toManifestJson(input.manifest);
    const version: PackRegistryVersion = {
      packId: input.entry.packId,
      version: input.index.version,
      capabilitySummary: input.index.capabilitySummary,
      publishedByUserId: input.actor.userId,
      publishedAt,
    };

    yield* stored(repository.insertVersion({ ...version, manifestJson }));
    yield* stored(
      repository.updateEntryIndex({
        packId: input.entry.packId,
        name: input.index.name,
        displayName: input.index.displayName,
        summary: input.index.summary,
        capabilitySummary: input.index.capabilitySummary,
        tags: input.index.tags,
        latestVersion: input.index.version,
        updatedAt: publishedAt,
      }),
    );

    const pack: PackRegistryEntry = {
      ...input.entry,
      name: input.index.name,
      displayName: input.index.displayName,
      summary: input.index.summary,
      capabilitySummary: input.index.capabilitySummary,
      tags: input.index.tags,
      latestVersion: input.index.version,
      updatedAt: publishedAt,
    };
    return { pack, version };
  });

  const publish: PackRegistryServiceShape["publish"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireEditRights(actor, input);
      const index = indexManifest(input.manifest);

      const found = yield* stored(repository.findEntry({ packId: index.packId }));
      if (Option.isSome(found)) {
        const entry = found.value;
        if (entry.tenantId !== input.tenantId || entry.workspaceId !== input.workspaceId) {
          return yield* new PackError({
            code: "visibility-forbidden",
            message: "This pack id was published from another workspace.",
          });
        }
        // Re-publishing a pack that is already registered is how the next
        // version arrives; the entry keeps the visibility it was given.
        const appended = yield* appendVersion({ actor, entry, manifest: input.manifest, index });
        yield* PubSub.publish(events, {
          type: "pack-version-recorded",
          pack: appended.pack,
          version: appended.version,
        });
        return appended;
      }

      const createdAt = nowIso();
      const manifestJson = yield* toManifestJson(input.manifest);
      const pack = toEntry({
        scope: input,
        index,
        visibility: workspacePrivateVisibility(input),
        createdAt,
      });
      const version: PackRegistryVersion = {
        packId: pack.packId,
        version: index.version,
        capabilitySummary: index.capabilitySummary,
        publishedByUserId: actor.userId,
        publishedAt: createdAt,
      };

      yield* stored(repository.insertEntry(pack));
      yield* stored(repository.insertVersion({ ...version, manifestJson }));
      yield* PubSub.publish(events, { type: "pack-published", pack });

      return { pack, version };
    });

  const recordVersion: PackRegistryServiceShape["recordVersion"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireEditRights(actor, input);
      const entry = yield* loadEntry(input.packId);
      if (entry.tenantId !== input.tenantId || entry.workspaceId !== input.workspaceId) {
        return yield* new PackError({
          code: "visibility-forbidden",
          message: "Only the workspace a pack was published from can add versions to it.",
        });
      }

      const index = indexManifest(input.manifest);
      if (index.packId !== entry.packId) {
        return yield* new PackError({
          code: "manifest-invalid",
          message: "Manifest identity does not match the pack it is being published under.",
        });
      }

      const appended = yield* appendVersion({ actor, entry, manifest: input.manifest, index });
      yield* PubSub.publish(events, {
        type: "pack-version-recorded",
        pack: appended.pack,
        version: appended.version,
      });
      return appended;
    });

  const search: PackRegistryServiceShape["search"] = (viewer, input) =>
    Effect.gen(function* () {
      const published = yield* stored(
        repository.searchEntries({
          tenantId: viewer.tenantId,
          workspaceId: viewer.workspaceId,
          organizationIds: viewer.organizationIds ?? [],
          ...(input.query === undefined ? {} : { query: input.query }),
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      );

      // The packs that ship with the product live in the file registry, which
      // is what the CLI and the agent read. Without this the UI would show a
      // workspace none of the packs the agent is about to use.
      const verified = yield* Effect.promise(() =>
        listVerifiedPacks(viewer.tenantId, viewer.workspaceId),
      );

      const own = new Set(published.map((entry) => entry.name));
      const matching = verified.filter(
        (entry) =>
          // A workspace's own pack of the same name wins: publishing your own
          // ssh-deploy is a deliberate act, and it should not be shadowed.
          !own.has(entry.name) && matchesQuery(entry, input.query),
      );

      const packs = [...published, ...matching];
      return { packs: input.limit === undefined ? packs : packs.slice(0, input.limit) };
    });

  /**
   * Whether a shipped pack answers the query.
   *
   * Deliberately the same shape as the repository's own matching — name, tags
   * and capability summary — so a caller cannot tell which store an entry came
   * from by how it responds to a search.
   */
  function matchesQuery(entry: PackRegistryEntry, query: string | undefined): boolean {
    if (query === undefined || query.trim().length === 0) {
      return true;
    }
    const haystack =
      `${entry.name} ${entry.displayName} ${entry.summary} ${entry.capabilitySummary} ${entry.tags.join(" ")}`.toLowerCase();
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 0)
      .some((term) => haystack.includes(term));
  }

  /**
   * A pack that shipped with the product, as a registry entry, a release and a
   * manifest — or nothing, when this id does not name one.
   *
   * Shared because every read has to agree about what exists. `search` offered
   * these packs and `get` served them, but `listVersions` went straight to the
   * published entries and failed with pack-not-found for a `verified:` id. The
   * pack page asks for both at once, so every pack that ships with the product
   * listed itself in search, offered a button to open it, and then rendered
   * "No pack here" — the deploy pack and the analytics pack included, which is
   * every pack a new workspace has. Offering a pack and then failing to open it
   * is worse than never offering it.
   *
   * The version comes from the release just read rather than from the cached
   * listing, so a page cannot show one version's manifest under another's
   * number after an upgrade the cache has not seen.
   */
  const shippedPack = (viewer: PackViewerScope, packId: string) =>
    Effect.gen(function* () {
      if (!isVerifiedPackId(packId)) {
        return undefined;
      }
      const release = yield* Effect.promise(() => getVerifiedPack(packId));
      if (release === undefined) {
        return undefined;
      }
      const entries = yield* Effect.promise(() =>
        listVerifiedPacks(viewer.tenantId, viewer.workspaceId),
      );
      const entry = entries.find((candidate) => candidate.packId === packId);
      if (entry === undefined) {
        return undefined;
      }
      const pack: PackRegistryEntry = { ...entry, latestVersion: release.version };
      return {
        pack,
        version: {
          packId: pack.packId,
          version: release.version,
          capabilitySummary: pack.capabilitySummary,
          // Nobody in this workspace published it — it came with the product.
          // Naming the publisher handle is truthful and keeps the field
          // meaning "who put this here".
          publishedByUserId: UserId.make(`pack-publisher:${pack.publisherHandle}`),
          publishedAt: pack.createdAt,
        } satisfies PackRegistryVersion,
        manifest: release.manifest,
      };
    });

  const get: PackRegistryServiceShape["get"] = (viewer, input) =>
    Effect.gen(function* () {
      // Search offers shipped packs, so read has to serve them too.
      const shipped = yield* shippedPack(viewer, input.packId);
      if (shipped !== undefined) {
        return shipped;
      }

      const pack = yield* loadVisibleEntry(viewer, input.packId);
      const wanted = input.version ?? pack.latestVersion;
      const found = yield* stored(repository.findVersion({ packId: pack.packId, version: wanted }));
      if (Option.isNone(found)) {
        return yield* new PackError({
          code: "pack-not-found",
          message: `Pack version ${wanted} was not found.`,
        });
      }

      const { manifestJson, ...version } = found.value;
      const manifest = yield* fromManifestJson(manifestJson);
      return { pack, version, manifest };
    });

  const listVersions: PackRegistryServiceShape["listVersions"] = (viewer, input) =>
    Effect.gen(function* () {
      // A shipped pack has exactly the release that is installed. The registry
      // on disk keeps older manifests beside it, but nothing here can say when
      // any of them was published — a shipped pack has no publish event — so
      // one honest release beats a history with invented dates.
      const shipped = yield* shippedPack(viewer, input.packId);
      if (shipped !== undefined) {
        return { pack: shipped.pack, versions: [shipped.version] };
      }

      const pack = yield* loadVisibleEntry(viewer, input.packId);
      const versions = yield* stored(repository.listVersions({ packId: pack.packId }));
      return { pack, versions };
    });

  /**
   * Listing into an organization is the one visibility whose boundary is not on
   * the entry, so it is checked against the actor's own memberships. The load is
   * affordable here because visibility changes are rare; a search never does it.
   */
  const requireOrganizationMembership = Effect.fn("requireOrganizationMembership")(function* (
    actor: PackActor,
    organizationId: string,
  ) {
    const snapshot = yield* stored(tenancy.loadCollaboration());
    const belongs = snapshot.memberships.some(
      (membership) =>
        membership.userId === actor.userId &&
        membership.organizationId === organizationId &&
        membership.disabledAt === null,
    );
    if (!belongs) {
      return yield* new PackError({
        code: "visibility-forbidden",
        message: "Only a member of the organization can list a pack to it.",
      });
    }
  });

  const setVisibility: PackRegistryServiceShape["setVisibility"] = (actor, input) =>
    Effect.gen(function* () {
      yield* requireEditRights(actor, input);
      const entry = yield* loadEntry(input.packId);
      if (entry.tenantId !== input.tenantId || entry.workspaceId !== input.workspaceId) {
        return yield* new PackError({
          code: "visibility-forbidden",
          message: "Only the workspace a pack was published from can change who sees it.",
        });
      }
      if (!ownsVisibility(entry, input.visibility)) {
        return yield* new PackError({
          code: "visibility-forbidden",
          message: "A pack can only be listed inside the boundary it was published in.",
        });
      }
      if (input.visibility.scope === "organization") {
        yield* requireOrganizationMembership(actor, input.visibility.organizationId);
      }

      const updatedAt = nowIso();
      yield* stored(
        repository.updateEntryVisibility({
          packId: entry.packId,
          visibility: input.visibility,
          updatedAt,
        }),
      );

      const pack: PackRegistryEntry = { ...entry, visibility: input.visibility, updatedAt };
      yield* PubSub.publish(events, { type: "pack-visibility-changed", pack });
      return { pack };
    });

  const stream: PackRegistryServiceShape["stream"] = (viewer) =>
    Stream.fromPubSub(events).pipe(Stream.filter((event) => isListedTo(event.pack, viewer)));

  return {
    publish,
    recordVersion,
    search,
    get,
    listVersions,
    setVisibility,
    stream,
  } satisfies PackRegistryServiceShape;
});

export const PackRegistryServiceLive = Layer.effect(PackRegistryService, makePackRegistryService);
