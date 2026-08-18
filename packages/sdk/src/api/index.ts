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
import { makePacksApi, type T3PacksApi } from "./packs.ts";
import { makeProviderSharingApi, type T3ProviderSharingApi } from "./providerSharing.ts";
import { makeProviderUsageApi, type T3ProviderUsageApi } from "./providerUsage.ts";
import {
  makeProvidersApi,
  makeServerApi,
  type T3ProvidersApi,
  type T3ServerApi,
} from "./server.ts";
import { makeShareLinksApi, type T3ShareLinksApi } from "./shareLinks.ts";
import { makeTerminalsApi, type T3TerminalsApi } from "./terminals.ts";
import { makeThreadsApi, type T3ThreadsApi } from "./threads.ts";
import { makeWorkspaceApi, type T3WorkspaceApi } from "./workspace.ts";
import type { T3Transport } from "../transport.ts";

export * from "./changes.ts";
export * from "./collaboration.ts";
export * from "./deploys.ts";
export * from "./history.ts";
export * from "./organizations.ts";
export * from "./packs.ts";
export * from "./providerSharing.ts";
export * from "./providerUsage.ts";
export * from "./server.ts";
export * from "./shareLinks.ts";
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
  /** The pack registry: publishing, versions, search, and who may see them. */
  readonly packs: T3PacksApi;
  readonly organizations: T3OrganizationsApi;
  readonly deploys: T3DeploysApi;
  readonly terminals: T3TerminalsApi;
  readonly providers: T3ProvidersApi;
  /** Which provider account a workspace's turns run on, and who contributed it. */
  readonly providerSharing: T3ProviderSharingApi;
  /** Members asking the workspace for usage, and contributors answering. */
  readonly providerUsage: T3ProviderUsageApi;
  /** Public links: a file, a project, or an invitation into a workspace. */
  readonly shareLinks: T3ShareLinksApi;
  readonly server: T3ServerApi;
}

export function createT3Api(transport: T3Transport): T3Api {
  return {
    workspace: makeWorkspaceApi(transport),
    threads: makeThreadsApi(transport),
    history: makeHistoryApi(transport),
    changes: makeChangesApi(transport),
    collaboration: makeCollaborationApi(transport),
    packs: makePacksApi(transport),
    organizations: makeOrganizationsApi(transport),
    deploys: makeDeploysApi(transport),
    terminals: makeTerminalsApi(transport),
    providers: makeProvidersApi(transport),
    providerSharing: makeProviderSharingApi(transport),
    providerUsage: makeProviderUsageApi(transport),
    shareLinks: makeShareLinksApi(transport),
    server: makeServerApi(transport),
  };
}
