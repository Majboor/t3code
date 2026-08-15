import { describe, expect, it } from "vitest";
import {
  MessageId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  parseWorkspaceRootAlreadyClaimedProjectId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";

import {
  findActiveProjectByWorkspaceRoot,
  findThreadById,
  listThreadsByProjectId,
  requireNonNegativeInteger,
  requireThread,
  requireThreadAbsent,
  requireWorkspaceRootUnclaimed,
} from "./commandInvariants.ts";

const now = new Date().toISOString();

const readModel: OrchestrationReadModel = {
  snapshotSequence: 2,
  updatedAt: now,
  projects: [
    {
      id: ProjectId.make("project-a"),
      title: "Project A",
      workspaceRoot: "/tmp/project-a",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
    {
      id: ProjectId.make("project-b"),
      title: "Project B",
      workspaceRoot: "/tmp/project-b",
      defaultModelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      scripts: [],
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    },
  ],
  threads: [
    {
      id: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-a"),
      title: "Thread A",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
    {
      id: ThreadId.make("thread-2"),
      projectId: ProjectId.make("project-b"),
      title: "Thread B",
      modelSelection: {
        provider: "codex",
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      latestTurn: null,
      messages: [],
      session: null,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    },
  ],
};

const messageSendCommand: OrchestrationCommand = {
  type: "thread.turn.start",
  commandId: CommandId.make("cmd-1"),
  threadId: ThreadId.make("thread-1"),
  message: {
    messageId: MessageId.make("msg-1"),
    role: "user",
    authorUserId: null,
    text: "hello",
    attachments: [],
  },
  interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
  runtimeMode: "approval-required",
  createdAt: now,
};

const makeProjectCreateCommand = (workspaceRoot: string): OrchestrationCommand => ({
  type: "project.create",
  commandId: CommandId.make("cmd-project-create"),
  projectId: ProjectId.make("project-new"),
  title: "New Project",
  workspaceRoot,
  createdAt: now,
});

describe("commandInvariants", () => {
  it("finds threads by id and project", () => {
    expect(findThreadById(readModel, ThreadId.make("thread-1"))?.projectId).toBe("project-a");
    expect(findThreadById(readModel, ThreadId.make("missing"))).toBeUndefined();
    expect(
      listThreadsByProjectId(readModel, ProjectId.make("project-b")).map((thread) => thread.id),
    ).toEqual([ThreadId.make("thread-2")]);
  });

  it("requires existing thread", async () => {
    const thread = await Effect.runPromise(
      requireThread({
        readModel,
        command: messageSendCommand,
        threadId: ThreadId.make("thread-1"),
      }),
    );
    expect(thread.id).toBe(ThreadId.make("thread-1"));

    await expect(
      Effect.runPromise(
        requireThread({
          readModel,
          command: messageSendCommand,
          threadId: ThreadId.make("missing"),
        }),
      ),
    ).rejects.toThrow("does not exist");
  });

  it("requires missing thread for create flows", async () => {
    await Effect.runPromise(
      requireThreadAbsent({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-2"),
          threadId: ThreadId.make("thread-3"),
          projectId: ProjectId.make("project-a"),
          title: "new",
          modelSelection: {
            provider: "codex",
            model: "gpt-5-codex",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
        threadId: ThreadId.make("thread-3"),
      }),
    );

    await expect(
      Effect.runPromise(
        requireThreadAbsent({
          readModel,
          command: {
            type: "thread.create",
            commandId: CommandId.make("cmd-3"),
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-a"),
            title: "dup",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt: now,
          },
          threadId: ThreadId.make("thread-1"),
        }),
      ),
    ).rejects.toThrow("already exists");
  });

  it("finds the active project that owns a workspace root", () => {
    expect(findActiveProjectByWorkspaceRoot(readModel, "/tmp/project-a")?.id).toBe("project-a");
    expect(findActiveProjectByWorkspaceRoot(readModel, "  /tmp/project-a  ")?.id).toBe("project-a");
    expect(findActiveProjectByWorkspaceRoot(readModel, "/tmp/unknown")).toBeUndefined();
    expect(findActiveProjectByWorkspaceRoot(readModel, "")).toBeUndefined();
  });

  it("ignores deleted projects when checking whether a workspace root is claimed", async () => {
    const readModelWithDeletedProject: OrchestrationReadModel = {
      ...readModel,
      projects: [
        {
          ...readModel.projects[0]!,
          id: ProjectId.make("project-deleted"),
          workspaceRoot: "/tmp/project-deleted",
          deletedAt: now,
        },
      ],
    };

    await Effect.runPromise(
      requireWorkspaceRootUnclaimed({
        readModel: readModelWithDeletedProject,
        command: makeProjectCreateCommand("/tmp/project-deleted"),
        workspaceRoot: "/tmp/project-deleted",
      }),
    );
  });

  it("refuses a workspace root an active project already owns, naming that project", async () => {
    await Effect.runPromise(
      requireWorkspaceRootUnclaimed({
        readModel,
        command: makeProjectCreateCommand("/tmp/project-c"),
        workspaceRoot: "/tmp/project-c",
      }),
    );

    const error = await Effect.runPromise(
      Effect.flip(
        requireWorkspaceRootUnclaimed({
          readModel,
          command: makeProjectCreateCommand("/tmp/project-a"),
          workspaceRoot: "/tmp/project-a",
        }),
      ),
    );

    expect(error.detail).toContain("already registered as project 'project-a'");
    expect(parseWorkspaceRootAlreadyClaimedProjectId(error)).toBe("project-a");
  });

  it("requires non-negative integers", async () => {
    await Effect.runPromise(
      requireNonNegativeInteger({
        commandType: "thread.checkpoint.revert",
        field: "turnCount",
        value: 0,
      }),
    );

    await expect(
      Effect.runPromise(
        requireNonNegativeInteger({
          commandType: "thread.checkpoint.revert",
          field: "turnCount",
          value: -1,
        }),
      ),
    ).rejects.toThrow("greater than or equal to 0");
  });
});
