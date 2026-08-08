/**
 * The grouped surface a connected client exposes.
 *
 * @module api
 */
import { makeChangesApi, type T3ChangesApi } from "./changes.ts";
import { makeCollaborationApi, type T3CollaborationApi } from "./collaboration.ts";
import { makeDeploysApi, type T3DeploysApi } from "./deploys.ts";
import { makeHistoryApi, type T3HistoryApi } from "./history.ts";
import { makeOrganizationsApi, type T3OrganizationsApi } from "./organizations.ts";
import {
  makeProvidersApi,
  makeServerApi,
  type T3ProvidersApi,
  type T3ServerApi,
} from "./server.ts";
import { makeTerminalsApi, type T3TerminalsApi } from "./terminals.ts";
import { makeThreadsApi, type T3ThreadsApi } from "./threads.ts";
import { makeWorkspaceApi, type T3WorkspaceApi } from "./workspace.ts";
import type { T3Transport } from "../transport.ts";

export * from "./changes.ts";
export * from "./collaboration.ts";
export * from "./deploys.ts";
export * from "./history.ts";
export * from "./organizations.ts";
export * from "./server.ts";
export * from "./terminals.ts";
export * from "./threads.ts";
export * from "./workspace.ts";

export interface T3Api {
  /** Workspaces, the projects in them, and project files. */
  readonly workspace: T3WorkspaceApi;
  /** Agent threads: reading them, and driving them. */
  readonly threads: T3ThreadsApi;
  /** Prompts, activity, and diffs already recorded. */
  readonly history: T3HistoryApi;
  /** Git: working tree, branches, worktrees, merges. */
  readonly changes: T3ChangesApi;
  /** Presence, invites, members, approvals, claims. */
  readonly collaboration: T3CollaborationApi;
  readonly organizations: T3OrganizationsApi;
  readonly deploys: T3DeploysApi;
  readonly terminals: T3TerminalsApi;
  readonly providers: T3ProvidersApi;
  readonly server: T3ServerApi;
}

export function createT3Api(transport: T3Transport): T3Api {
  return {
    workspace: makeWorkspaceApi(transport),
    threads: makeThreadsApi(transport),
    history: makeHistoryApi(transport),
    changes: makeChangesApi(transport),
    collaboration: makeCollaborationApi(transport),
    organizations: makeOrganizationsApi(transport),
    deploys: makeDeploysApi(transport),
    terminals: makeTerminalsApi(transport),
    providers: makeProvidersApi(transport),
    server: makeServerApi(transport),
  };
}
