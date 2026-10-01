import { CommandId, ProjectId, resolveProjectKind } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { JOINED_PROJECT_CREATE_REFUSAL } from "./projectKindRules.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = new Date().toISOString();

const decideProjectCreate = (input: {
  readonly projectId: string;
  readonly kind?: "local" | "hosted" | "self-hosted" | "joined" | null;
}) =>
  decideOrchestrationCommand({
    command: {
      type: "project.create",
      commandId: CommandId.make(`cmd-${input.projectId}`),
      projectId: ProjectId.make(input.projectId),
      title: "Aero Build",
      workspaceRoot: `/Users/hico/${input.projectId}`,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      createdAt: now,
    },
    readModel: createEmptyReadModel(now),
  });

const readModelAfterCreate = (input: {
  readonly projectId: string;
  readonly kind?: "local" | "hosted" | "self-hosted" | "joined" | null;
}) =>
  Effect.gen(function* () {
    const emptyReadModel = createEmptyReadModel(now);
    const decided = yield* decideProjectCreate(input);
    const event = Array.isArray(decided) ? decided[0]! : decided;
    return yield* projectEvent(emptyReadModel, { ...event, sequence: 1 });
  });

describe("decider project.create kind", () => {
  it("refuses a joined project, because a share link is what produces one", async () => {
    const error = await Effect.runPromise(
      decideProjectCreate({ projectId: "project-joined", kind: "joined" }).pipe(Effect.flip),
    );

    // Checked ahead of the read-model invariants on purpose: the caller gets the
    // reason that actually applies rather than a folder-taken complaint.
    expect(error.detail).toBe(JOINED_PROJECT_CREATE_REFUSAL);
  });

  it("records a stated kind on the event, not only in a projection", async () => {
    const decided = await Effect.runPromise(
      decideProjectCreate({ projectId: "project-hosted", kind: "hosted" }).pipe(
        Effect.map((result) => (Array.isArray(result) ? result[0]! : result)),
      ),
    );

    expect(decided.type).toBe("project.created");
    // The event log is what the projection is rebuilt from, so this is the copy
    // that has to survive a replay.
    expect(decided.payload).toMatchObject({ kind: "hosted" });
  });

  it("carries the kind into the read model every in-process caller reads", async () => {
    const readModel = await Effect.runPromise(
      readModelAfterCreate({ projectId: "project-selfhosted", kind: "self-hosted" }),
    );

    const project = readModel.projects.find((entry) => entry.id === "project-selfhosted");
    expect(project?.kind).toBe("self-hosted");
    expect(resolveProjectKind(project)).toBe("self-hosted");
  });

  it("leaves a project created without a kind exactly as it was before kinds existed", async () => {
    const readModel = await Effect.runPromise(
      readModelAfterCreate({ projectId: "project-unstated" }),
    );

    const project = readModel.projects.find((entry) => entry.id === "project-unstated");
    // Not `kind: null` and not `kind: "local"` — the key is simply absent, which
    // is the only shape that keeps "nobody chose" distinguishable from a choice.
    expect(project).toBeDefined();
    expect("kind" in (project as object)).toBe(false);
    // And absence still answers, in the one place absence is answered.
    expect(resolveProjectKind(project)).toBe("local");
  });
});
