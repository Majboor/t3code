import { randomBytes } from "node:crypto";

import { Effect, Layer, Option } from "effect";

import {
  PackEnablementError,
  PackEnablementId,
  type PackEnablementSetting,
  type PackManifest,
} from "@t3tools/contracts";

import {
  PackEnablementService,
  type PackEnablementServiceShape,
} from "../Services/PackEnablementService.ts";
import { PackEnablementRepository } from "../../persistence/Services/PackEnablement.ts";
import { PackRegistryService } from "../../packs/Services/PackRegistryService.ts";

/**
 * What the pack asked the project to supply, and whether it has it.
 *
 * Nothing here can satisfy a requirement: a secret lives in the server secret
 * store and an account exists at somebody else's company. So every setting
 * starts unprovided, and saying so is the point — a list that claimed otherwise
 * would describe a project as ready and be wrong on first use.
 */
export function settingsFor(manifest: PackManifest): ReadonlyArray<PackEnablementSetting> {
  const settings: PackEnablementSetting[] = [];
  for (const entry of manifest.requirements.environment ?? []) {
    if (!entry.required) continue;
    settings.push(
      entry.secret
        ? { name: entry.name, provided: false, secretName: entry.name }
        : { name: entry.name, provided: false },
    );
  }
  return settings;
}

const makeService = Effect.gen(function* () {
  const repository = yield* PackEnablementRepository;
  const registry = yield* PackRegistryService;

  const storageFailed = (message: string) => (cause: unknown) =>
    new PackEnablementError({ code: "storage-failed", message, cause });

  const enable: PackEnablementServiceShape["enable"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .find({ projectId: input.projectId, packId: input.packId })
        .pipe(Effect.mapError(storageFailed("Failed to read pack enablements.")));

      if (Option.isSome(existing) && existing.value.disabledAt === null) {
        return yield* new PackEnablementError({
          code: "already-enabled",
          message: "That pack is already on for this project.",
        });
      }

      const found = yield* registry
        .get(
          { tenantId: input.tenantId, workspaceId: input.workspaceId },
          { packId: input.packId, ...(input.version ? { version: input.version } : {}) },
        )
        .pipe(
          Effect.mapError(
            (error) => new PackEnablementError({ code: "pack-not-found", message: error.message }),
          ),
        );

      const timestamp = new Date().toISOString();
      const enablement = {
        // Reusing the row's id keeps whatever was configured before it was
        // turned off, so re-enabling is not a fresh start.
        id: Option.isSome(existing)
          ? existing.value.id
          : PackEnablementId.make(`packen_${randomBytes(12).toString("hex")}`),
        projectId: input.projectId,
        packId: input.packId,
        version: found.manifest.identity.version,
        packName: found.manifest.identity.name,
        packSummary: found.manifest.identity.summary,
        settings: Option.isSome(existing) ? existing.value.settings : settingsFor(found.manifest),
        enabledAt: timestamp,
        disabledAt: null,
      };

      yield* repository
        .upsert(enablement)
        .pipe(Effect.mapError(storageFailed("Failed to store the pack enablement.")));

      return { enablement };
    });

  const disable: PackEnablementServiceShape["disable"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* repository
        .find({ projectId: input.projectId, packId: input.packId })
        .pipe(Effect.mapError(storageFailed("Failed to read pack enablements.")));
      if (Option.isNone(existing) || existing.value.disabledAt !== null) {
        return yield* new PackEnablementError({
          code: "not-enabled",
          message: "That pack is not on for this project.",
        });
      }

      yield* repository
        .upsert({ ...existing.value, disabledAt: new Date().toISOString() })
        .pipe(Effect.mapError(storageFailed("Failed to store the pack enablement.")));
    });

  const list: PackEnablementServiceShape["list"] = (input) =>
    repository.list({ projectId: input.projectId }).pipe(
      Effect.mapError(storageFailed("Failed to list pack enablements.")),
      Effect.map((enablements) => ({ enablements })),
    );

  return { enable, disable, list } satisfies PackEnablementServiceShape;
});

export const PackEnablementServiceLive = Layer.effect(PackEnablementService, makeService);
