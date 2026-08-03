import { TenantId, ThreadId, UserId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadPreferenceRepositoryLive } from "./ProjectionThreadPreferences.ts";
import { ProjectionThreadPreferenceRepository } from "../Services/ProjectionThreadPreferences.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadPreferenceRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProjectionThreadPreferenceRepository", (it) => {
  it.effect("stores independent favorite preferences per tenant user and thread", () =>
    Effect.gen(function* () {
      const preferences = yield* ProjectionThreadPreferenceRepository;
      const tenantId = TenantId.make("tenant-preferences");
      const threadId = ThreadId.make("thread-preferences");
      const ada = UserId.make("user-ada");
      const grace = UserId.make("user-grace");

      yield* preferences.upsert({
        tenantId,
        userId: ada,
        threadId,
        favorite: 1,
        updatedAt: "2026-05-09T00:00:00.000Z",
      });
      yield* preferences.upsert({
        tenantId,
        userId: grace,
        threadId,
        favorite: 0,
        updatedAt: "2026-05-09T00:00:01.000Z",
      });

      const adaPreferences = yield* preferences.listByUser({ tenantId, userId: ada });
      const gracePreferences = yield* preferences.listByUser({ tenantId, userId: grace });

      assert.equal(adaPreferences[0]?.favorite, 1);
      assert.equal(gracePreferences[0]?.favorite, 0);
      assert.equal(adaPreferences[0]?.threadId, threadId);
      assert.equal(gracePreferences[0]?.threadId, threadId);
    }),
  );
});
