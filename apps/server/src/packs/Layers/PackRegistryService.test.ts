import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  PACK_FORMAT_VERSION,
  PackId,
  PackManifest,
  TenantId,
  UserId,
  WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { PackRegistryServiceLive } from "./PackRegistryService.ts";
import { PackRepositoryLive } from "./PackRepository.ts";
import { PackRegistryService } from "../Services/PackRegistryService.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { CollaborationServiceLive } from "../../collaboration/Layers/CollaborationService.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";

const tenantId = TenantId.make("tenant-packs");
const workspaceId = WorkspaceId.make("workspace-packs");
const scope = { tenantId, workspaceId };

const otherTenantId = TenantId.make("tenant-packs-other");
const otherWorkspaceId = WorkspaceId.make("workspace-packs-other");
const otherScope = { tenantId: otherTenantId, workspaceId: otherWorkspaceId };

const lead = { userId: UserId.make("user-lead"), displayName: "Lead" };
const watcher = { userId: UserId.make("user-watcher"), displayName: "Watcher" };

const packId = PackId.make("pack_01J9Z0C4Q3");

const decodeManifest = Schema.decodeUnknownSync(PackManifest);

/**
 * A publishable manifest. It claims `unlisted` on purpose: what a manifest says
 * about its own visibility is not what the registry publishes it as.
 */
function makeManifest(input: {
  readonly version: string;
  readonly does?: string;
  readonly tags?: ReadonlyArray<string>;
}) {
  return decodeManifest({
    formatVersion: PACK_FORMAT_VERSION,
    identity: {
      id: packId,
      name: "stripe-checkout",
      version: input.version,
      displayName: "Stripe Checkout",
      summary: "Hosted Stripe checkout with webhook reconciliation.",
      publisher: {
        type: "user",
        handle: "waleed",
        displayName: "Waleed Ajmal",
      },
      license: "MIT",
      ...(input.tags === undefined ? {} : { tags: input.tags }),
    },
    provenance: {
      workspace: { workspaceKeyId: "wsk_7f3a91" },
      extractedAt: "2026-08-07T09:12:00.000Z",
      extractedBy: { type: "agent", provider: "claudeAgent" },
      handover: {
        path: "handover.md",
        summary: "Lifted the checkout flow out of the storefront workspace.",
      },
    },
    capability: {
      does: input.does ?? "Turns a cart total into a paid Stripe order.",
    },
    knowledge: {},
    requirements: {},
    interfaces: [
      {
        kind: "library",
        id: "checkout",
        title: "Checkout helpers",
        language: "typescript",
        exports: [
          {
            name: "createCheckoutSession",
            kind: "function",
            summary: "Creates a Stripe checkout session for a cart.",
          },
        ],
      },
    ],
    runtime: { target: "node", commands: {} },
    permissions: {},
    verification: {
      record: {
        measuredAt: "2026-08-07T09:12:00.000Z",
        installsAttempted: 0,
        installsSucceeded: 0,
        deploymentsAttempted: 0,
        deploymentsSurviving: 0,
        cumulativeServiceDays: 0,
        breakagesCaught: 0,
        breakagesFixed: 0,
      },
    },
    visibility: { scope: "unlisted" },
    integration: {
      prompt:
        "Install the stripe-checkout pack and call createCheckoutSession from your cart page.",
    },
  });
}

/**
 * A fresh database per test. No membership is recorded until a test asks for
 * one, which is the state a workspace is in before anybody is invited: everyone
 * present may publish.
 */
function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-pack-registry-"));
  return PackRegistryServiceLive.pipe(
    Layer.provide(PackRepositoryLive),
    Layer.provideMerge(CollaborationServiceLive),
    Layer.provide(TenancyRepositoryLive),
    Layer.provide(makeSqlitePersistenceLive(path.join(tempDir, "packs.sqlite"))),
    Layer.provideMerge(NodeServices.layer),
  );
}

it.effect("publishes private to the workspace, whatever the manifest claims", () =>
  Effect.gen(function* () {
    const registry = yield* PackRegistryService;

    const published = yield* registry.publish(lead, {
      ...scope,
      manifest: makeManifest({ version: "0.1.0" }),
    });

    assert.strictEqual(published.pack.visibility.scope, "workspace");
    assert.strictEqual(
      published.pack.visibility.scope === "workspace"
        ? published.pack.visibility.workspaceId
        : null,
      workspaceId,
    );
    assert.strictEqual(published.pack.latestVersion, "0.1.0");
    assert.strictEqual(published.version.publishedByUserId, lead.userId);

    // The publishing workspace sees its own pack straight away.
    const mine = yield* registry.search(scope, {});
    assert.strictEqual(mine.packs.length, 1);
    assert.strictEqual(mine.packs[0]?.packId, packId);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("keeps a private pack out of another workspace entirely", () =>
  Effect.gen(function* () {
    const registry = yield* PackRegistryService;
    yield* registry.publish(lead, { ...scope, manifest: makeManifest({ version: "0.1.0" }) });

    const theirs = yield* registry.search(otherScope, {});
    assert.strictEqual(theirs.packs.length, 0);

    // Not "forbidden" — a stranger is not told which packs a workspace holds.
    const refused = yield* registry.get(otherScope, { packId }).pipe(Effect.flip);
    assert.strictEqual(refused.code, "pack-not-found");

    // Listing it is the deliberate second act.
    yield* registry.setVisibility(lead, { ...scope, packId, visibility: { scope: "public" } });

    const listed = yield* registry.search(otherScope, {});
    assert.strictEqual(listed.packs.length, 1);
    const found = yield* registry.get(otherScope, { packId });
    assert.strictEqual(found.pack.visibility.scope, "public");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("leaves a published version alone when the next one lands", () =>
  Effect.gen(function* () {
    const registry = yield* PackRegistryService;
    yield* registry.publish(lead, {
      ...scope,
      manifest: makeManifest({ version: "0.1.0", does: "Turns a cart total into a paid order." }),
    });

    const second = yield* registry.recordVersion(lead, {
      ...scope,
      packId,
      manifest: makeManifest({
        version: "0.2.0",
        does: "Turns a cart total into a paid order, and reconciles the webhook.",
      }),
    });
    assert.strictEqual(second.pack.latestVersion, "0.2.0");

    // The first release still says exactly what it said when it was published.
    const first = yield* registry.get(scope, { packId, version: "0.2.0" });
    assert.strictEqual(first.version.version, "0.2.0");
    const pinned = yield* registry.get(scope, { packId, version: "0.1.0" });
    assert.strictEqual(pinned.manifest.capability.does, "Turns a cart total into a paid order.");
    assert.strictEqual(pinned.version.capabilitySummary, "Turns a cart total into a paid order.");

    const history = yield* registry.listVersions(scope, { packId });
    assert.strictEqual(history.versions.length, 2);

    // A version number is spent once. A change is a new version, never a rewrite.
    const replayed = yield* registry
      .recordVersion(lead, {
        ...scope,
        packId,
        manifest: makeManifest({ version: "0.2.0", does: "Something else entirely." }),
      })
      .pipe(Effect.flip);
    assert.strictEqual(replayed.code, "version-exists");

    const unchanged = yield* registry.get(scope, { packId, version: "0.2.0" });
    assert.strictEqual(
      unchanged.manifest.capability.does,
      "Turns a cart total into a paid order, and reconciles the webhook.",
    );
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses a visibility change from someone who may only watch", () =>
  Effect.gen(function* () {
    const registry = yield* PackRegistryService;
    const collaboration = yield* CollaborationService;
    yield* registry.publish(lead, { ...scope, manifest: makeManifest({ version: "0.1.0" }) });

    const watchOnly = yield* collaboration.createInvite(lead, {
      ...scope,
      email: "watcher@example.com",
      scope: "workspace",
      roles: ["viewer"],
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    yield* collaboration.acceptInvite(watcher, { inviteId: watchOnly.invite.id });

    const refused = yield* registry
      .setVisibility(watcher, { ...scope, packId, visibility: { scope: "public" } })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "visibility-forbidden");

    const publishRefused = yield* registry
      .publish(watcher, { ...scope, manifest: makeManifest({ version: "0.3.0" }) })
      .pipe(Effect.flip);
    assert.strictEqual(publishRefused.code, "visibility-forbidden");

    // Still private, and still on the version the lead published.
    const unchanged = yield* registry.get(scope, { packId });
    assert.strictEqual(unchanged.pack.visibility.scope, "workspace");
    assert.strictEqual(unchanged.pack.latestVersion, "0.1.0");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("finds a pack by what it does and by its tags", () =>
  Effect.gen(function* () {
    const registry = yield* PackRegistryService;
    yield* registry.publish(lead, {
      ...scope,
      manifest: makeManifest({
        version: "0.1.0",
        does: "Reconciles Stripe webhooks idempotently.",
        tags: ["payments", "webhooks"],
      }),
    });

    const byCapability = yield* registry.search(scope, { query: "idempotently" });
    assert.strictEqual(byCapability.packs.length, 1);

    const byTag = yield* registry.search(scope, { query: "webhooks" });
    assert.strictEqual(byTag.packs.length, 1);

    const byNothing = yield* registry.search(scope, { query: "kubernetes" });
    assert.strictEqual(byNothing.packs.length, 0);

    // Wildcards in a query are terms, not syntax.
    const literal = yield* registry.search(scope, { query: "%" });
    assert.strictEqual(literal.packs.length, 0);
  }).pipe(Effect.provide(makeLayer())),
);
