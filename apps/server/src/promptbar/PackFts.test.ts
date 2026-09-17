import { it as vitestIt, describe, expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { buildFtsRows, rebuildFtsIndex, searchFtsPhrasings } from "./PackFts.ts";
import type { PromptbarPackDefinition } from "./PackSource.ts";

const sshDeploy: PromptbarPackDefinition = {
  id: "ssh_deploy",
  name: "Deploy over SSH",
  description: "Ship a project to a host over SSH and keep it running",
  phrasings: ["deploy this to the server", "ship it over ssh", "bhej do server pe"],
  params: [{ name: "project", type: "string", required: true, desc: "which project to deploy" }],
};

const analyticsCore: PromptbarPackDefinition = {
  id: "analytics_core",
  name: "Report deployment analytics",
  description: "Record product events from a deployment and ask questions of them",
  phrasings: ["add analytics to this", "track events on this deployment", "analytics lagao"],
  params: [],
};

describe("buildFtsRows", () => {
  vitestIt("emits one row per phrasing plus one row for the pack name", () => {
    const rows = buildFtsRows(sshDeploy);
    expect(rows).toHaveLength(sshDeploy.phrasings.length + 1);
    expect(rows[0]).toEqual({
      packId: "ssh_deploy",
      name: "Deploy over SSH",
      description: sshDeploy.description,
      phrasing: "Deploy over SSH",
    });
    expect(rows.slice(1).map((r) => r.phrasing)).toEqual(sshDeploy.phrasings);
  });

  vitestIt("carries pack_id/name/description unchanged onto every row", () => {
    const rows = buildFtsRows(analyticsCore);
    for (const row of rows) {
      expect(row.packId).toBe("analytics_core");
      expect(row.name).toBe(analyticsCore.name);
      expect(row.description).toBe(analyticsCore.description);
    }
  });
});

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("PackFts (real SQLite FTS5)", (it) => {
  it.effect("indexes packs and finds them by BM25 phrasing match", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);

      const hits = yield* searchFtsPhrasings("deploy this to the server", 10);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0]!.packId).toBe("ssh_deploy");
    }),
  );

  it.effect("matches on description text as well as phrasings", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);

      const hits = yield* searchFtsPhrasings("record product events", 10);
      expect(hits.some((h) => h.packId === "analytics_core")).toBe(true);
    }),
  );

  it.effect("matches Roman Urdu / code-switched phrasings verbatim", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);

      const hits = yield* searchFtsPhrasings("analytics lagao", 10);
      expect(hits.some((h) => h.packId === "analytics_core")).toBe(true);
    }),
  );

  it.effect("a full rebuild replaces the previous pack set rather than accumulating", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);
      yield* rebuildFtsIndex([analyticsCore]);

      const hits = yield* searchFtsPhrasings("deploy this to the server", 10);
      expect(hits.some((h) => h.packId === "ssh_deploy")).toBe(false);
    }),
  );

  it.effect("returns no hits (not a SQL error) for text with no indexable tokens", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);

      const hits = yield* searchFtsPhrasings("???", 10);
      expect(hits).toEqual([]);
    }),
  );

  it.effect("does not choke on FTS5 operator characters in free-text input", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      yield* rebuildFtsIndex([sshDeploy, analyticsCore]);

      // A raw `-ssh` or unbalanced `"` would be a MATCH *syntax* error if
      // passed straight through; buildFtsMatchQuery (exercised indirectly
      // here) must have already neutralised it.
      const hits = yield* searchFtsPhrasings('deploy -this "server" now*', 10);
      expect(hits.some((h) => h.packId === "ssh_deploy")).toBe(true);
    }),
  );
});
