/**
 * Workspaces, the projects registered in them, and the files inside a project.
 *
 * @module api/workspace
 */
import {
  type ModelSelection,
  ORCHESTRATION_WS_METHODS,
  type OrchestrationProjectOwnership,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationShellStreamItem,
  type ProjectId,
  type ProjectScript,
  WS_METHODS,
} from "@t3tools/contracts";

import { dispatch, type T3DispatchAck } from "../commands.ts";
import { newCommandId, newProjectId } from "../ids.ts";
import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3RegisterProjectInput {
  readonly workspaceRoot: string;
  readonly title: string;
  /** Which tenant and workspace the project belongs to. */
  readonly ownership?: OrchestrationProjectOwnership;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly createWorkspaceRootIfMissing?: boolean;
  /** Defaults to a freshly minted identifier. */
  readonly projectId?: ProjectId;
}

export interface T3UpdateProjectInput {
  readonly projectId: ProjectId;
  readonly title?: string;
  readonly workspaceRoot?: string;
  readonly ownership?: OrchestrationProjectOwnership;
  readonly defaultModelSelection?: ModelSelection | null;
  readonly scripts?: ReadonlyArray<ProjectScript>;
}

export interface T3WorkspaceApi {
  readonly listOrganizations: () => Promise<RpcSuccess<typeof WS_METHODS.organizationsList>>;
  readonly listWorkspaces: () => Promise<
    RpcSuccess<typeof WS_METHODS.organizationsList>["workspaces"]
  >;
  readonly createWorkspace: (
    input: RpcInput<typeof WS_METHODS.workspacesCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.workspacesCreate>>;

  /** Everything the shell shows: projects plus a summary of every thread. */
  readonly getSnapshot: () => Promise<OrchestrationShellSnapshot>;
  readonly listProjects: () => Promise<ReadonlyArray<OrchestrationProjectShell>>;
  readonly watch: (
    onEvent: (event: OrchestrationShellStreamItem) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
  readonly registerProject: (input: T3RegisterProjectInput) => Promise<ProjectId>;
  readonly updateProject: (input: T3UpdateProjectInput) => Promise<T3DispatchAck>;
  readonly removeProject: (projectId: ProjectId) => Promise<T3DispatchAck>;

  readonly listDirectory: (
    input: RpcInput<typeof WS_METHODS.projectsListDirectory>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.projectsListDirectory>>;
  readonly readFile: (
    input: RpcInput<typeof WS_METHODS.projectsReadFile>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.projectsReadFile>>;
  readonly writeFile: (
    input: RpcInput<typeof WS_METHODS.projectsWriteFile>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.projectsWriteFile>>;
  readonly createEntry: (
    input: RpcInput<typeof WS_METHODS.projectsCreateEntry>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.projectsCreateEntry>>;
  readonly searchEntries: (
    input: RpcInput<typeof WS_METHODS.projectsSearchEntries>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.projectsSearchEntries>>;
  /** Walk the host filesystem, for picking a folder to register. */
  readonly browse: (
    input: RpcInput<typeof WS_METHODS.filesystemBrowse>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.filesystemBrowse>>;
  readonly openInEditor: (input: RpcInput<typeof WS_METHODS.shellOpenInEditor>) => Promise<void>;
}

export function makeWorkspaceApi(transport: T3Transport): T3WorkspaceApi {
  // The shell subscription is a stream whose first item is the snapshot;
  // take that one item and let the stream close.
  const getSnapshot = async (): Promise<OrchestrationShellSnapshot> => {
    const head = await transport.first((client) =>
      client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
    );
    if (head.kind !== "snapshot") {
      throw new Error("Server sent a shell event before the snapshot.");
    }
    return head.snapshot;
  };

  return {
    listOrganizations: () =>
      transport.request((client) => client[WS_METHODS.organizationsList]({})),
    listWorkspaces: async () => {
      const snapshot = await transport.request((client) =>
        client[WS_METHODS.organizationsList]({}),
      );
      return snapshot.workspaces ?? [];
    },
    createWorkspace: (input) =>
      transport.request((client) => client[WS_METHODS.workspacesCreate](input)),

    getSnapshot,
    listProjects: async () => (await getSnapshot()).projects,
    watch: (onEvent, options) =>
      transport.subscribe(
        (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
        onEvent,
        options,
      ),
    registerProject: async (input) => {
      const projectId = input.projectId ?? newProjectId();
      await dispatch(transport, {
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        ownership: input.ownership,
        createWorkspaceRootIfMissing: input.createWorkspaceRootIfMissing,
        defaultModelSelection: input.defaultModelSelection,
        createdAt: new Date().toISOString(),
      });
      return projectId;
    },
    updateProject: (input) =>
      dispatch(transport, {
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: input.projectId,
        title: input.title,
        workspaceRoot: input.workspaceRoot,
        ownership: input.ownership,
        defaultModelSelection: input.defaultModelSelection,
        scripts: input.scripts,
      }),
    removeProject: (projectId) =>
      dispatch(transport, {
        type: "project.delete",
        commandId: newCommandId(),
        projectId,
      }),

    listDirectory: (input) =>
      transport.request((client) => client[WS_METHODS.projectsListDirectory](input)),
    readFile: (input) => transport.request((client) => client[WS_METHODS.projectsReadFile](input)),
    writeFile: (input) =>
      transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
    createEntry: (input) =>
      transport.request((client) => client[WS_METHODS.projectsCreateEntry](input)),
    searchEntries: (input) =>
      transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
    browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    openInEditor: (input) =>
      transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
  };
}
