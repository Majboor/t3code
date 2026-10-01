import { ProjectId, resolveProjectKind } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const projectionSnapshotLayer = it.layer(
  OrchestrationProjectionSnapshotQueryLive.pipe(
    Layer.provideMerge(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

projectionSnapshotLayer("ProjectionSnapshotQuery project kind", (it) => {
  it.effect("carries a stored kind to the client and resolves an absent one to local", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;

      // Named columns, never positional: migration 074 appended `project_kind`
      // at the end of the row, which is exactly the situation a positional
      // insert gets wrong.
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          ownership_json,
          default_model_selection_json,
          scripts_json,
          project_kind,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES
          (
            'project-hosted', 'Hosted', '/tmp/project-hosted',
            NULL, NULL, '[]', 'hosted',
            '2026-09-30T00:00:00.000Z', '2026-09-30T00:00:00.000Z', NULL
          ),
          (
            'project-legacy', 'Legacy', '/tmp/project-legacy',
            NULL, NULL, '[]', NULL,
            '2026-09-30T00:00:01.000Z', '2026-09-30T00:00:01.000Z', NULL
          )
      `;

      const shell = yield* snapshotQuery.getShellSnapshot();
      const hostedShell = shell.projects.find(
        (project) => project.id === asProjectId("project-hosted"),
      );
      const legacyShell = shell.projects.find(
        (project) => project.id === asProjectId("project-legacy"),
      );

      assert.equal(hostedShell?.kind, "hosted");

      // The whole point of the nullable column: a project created before anyone
      // was asked still says "I was never asked", and the one resolver decides
      // what that means. It must not arrive already claiming to be hosted.
      assert.equal(legacyShell?.kind, null);
      assert.equal(resolveProjectKind(legacyShell), "local");
      assert.equal(resolveProjectKind(hostedShell), "hosted");

      const snapshot = yield* snapshotQuery.getSnapshot();
      assert.equal(
        snapshot.projects.find((project) => project.id === asProjectId("project-hosted"))?.kind,
        "hosted",
      );

      const byRoot = yield* snapshotQuery.getActiveProjectByWorkspaceRoot("/tmp/project-hosted");
      assert.equal(byRoot._tag, "Some");
      if (byRoot._tag === "Some") {
        assert.equal(byRoot.value.kind, "hosted");
      }

      const byId = yield* snapshotQuery.getProjectShellById(asProjectId("project-hosted"));
      assert.equal(byId._tag, "Some");
      if (byId._tag === "Some") {
        assert.equal(byId.value.kind, "hosted");
      }
    }),
  );

  it.effect("narrows an unrecognised stored kind instead of failing the whole snapshot", () =>
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      const sql = yield* SqlClient.SqlClient;

      yield* sql`DELETE FROM projection_projects`;

      // What a newer binary that learned a fifth kind would leave behind. The
      // column has no CHECK constraint on purpose, so this row is legal SQL and
      // an older server has to survive reading it — this payload paints the
      // project list, and one unreadable kind must never cost somebody every
      // project on the page.
      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          ownership_json,
          default_model_selection_json,
          scripts_json,
          project_kind,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          'project-future', 'From the future', '/tmp/project-future',
          NULL, NULL, '[]', 'federated',
          '2026-09-30T00:00:02.000Z', '2026-09-30T00:00:02.000Z', NULL
        )
      `;

      const shell = yield* snapshotQuery.getShellSnapshot();
      const project = shell.projects.find(
        (candidate) => candidate.id === asProjectId("project-future"),
      );

      assert.equal(shell.projects.length, 1);
      assert.equal(project?.kind, null);
      assert.equal(resolveProjectKind(project), "local");
    }),
  );
});
