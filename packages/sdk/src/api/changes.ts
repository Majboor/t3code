/**
 * Uncommitted work, branches, worktrees, and merges.
 *
 * @module api/changes
 */
import {
  type GitActionProgressEvent,
  type GitRunStackedActionResult,
  type GitStatusStreamEvent,
  WS_METHODS,
} from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3RunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface T3ChangesApi {
  readonly status: (
    input: RpcInput<typeof WS_METHODS.gitRefreshStatus>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitRefreshStatus>>;
  /**
   * Status arrives in pieces: a local snapshot first, then the slower remote
   * half. Events are delivered raw so callers can render the local half early.
   */
  readonly watchStatus: (
    input: RpcInput<typeof WS_METHODS.subscribeGitStatus>,
    onEvent: (event: GitStatusStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
  readonly getWorkingTreeDiff: (
    input: RpcInput<typeof WS_METHODS.gitGetWorkingTreeDiff>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitGetWorkingTreeDiff>>;

  readonly listBranches: (
    input: RpcInput<typeof WS_METHODS.gitListBranches>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitListBranches>>;
  readonly createBranch: (
    input: RpcInput<typeof WS_METHODS.gitCreateBranch>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitCreateBranch>>;
  readonly checkout: (
    input: RpcInput<typeof WS_METHODS.gitCheckout>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitCheckout>>;
  readonly compareBranches: (
    input: RpcInput<typeof WS_METHODS.gitCompareBranches>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitCompareBranches>>;
  readonly init: (input: RpcInput<typeof WS_METHODS.gitInit>) => Promise<void>;
  readonly pull: (
    input: RpcInput<typeof WS_METHODS.gitPull>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitPull>>;

  readonly createWorktree: (
    input: RpcInput<typeof WS_METHODS.gitCreateWorktree>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitCreateWorktree>>;
  readonly removeWorktree: (input: RpcInput<typeof WS_METHODS.gitRemoveWorktree>) => Promise<void>;

  readonly mergeBranch: (
    input: RpcInput<typeof WS_METHODS.gitMergeBranch>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitMergeBranch>>;
  readonly getMergeState: (
    input: RpcInput<typeof WS_METHODS.gitGetMergeState>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitGetMergeState>>;
  readonly abortMerge: (
    input: RpcInput<typeof WS_METHODS.gitAbortMerge>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitAbortMerge>>;

  /** Commit, push, and open a pull request, reporting hook output as it runs. */
  readonly runStackedAction: (
    input: RpcInput<typeof WS_METHODS.gitRunStackedAction>,
    options?: T3RunStackedActionOptions,
  ) => Promise<GitRunStackedActionResult>;
  readonly resolvePullRequest: (
    input: RpcInput<typeof WS_METHODS.gitResolvePullRequest>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitResolvePullRequest>>;
  readonly preparePullRequestThread: (
    input: RpcInput<typeof WS_METHODS.gitPreparePullRequestThread>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.gitPreparePullRequestThread>>;
}

export function makeChangesApi(transport: T3Transport): T3ChangesApi {
  return {
    status: (input) => transport.request((client) => client[WS_METHODS.gitRefreshStatus](input)),
    watchStatus: (input, onEvent, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeGitStatus](input),
        onEvent,
        options,
      ),
    getWorkingTreeDiff: (input) =>
      transport.request((client) => client[WS_METHODS.gitGetWorkingTreeDiff](input)),

    listBranches: (input) =>
      transport.request((client) => client[WS_METHODS.gitListBranches](input)),
    createBranch: (input) =>
      transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
    checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
    compareBranches: (input) =>
      transport.request((client) => client[WS_METHODS.gitCompareBranches](input)),
    init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
    pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),

    createWorktree: (input) =>
      transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
    removeWorktree: (input) =>
      transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),

    mergeBranch: (input) => transport.request((client) => client[WS_METHODS.gitMergeBranch](input)),
    getMergeState: (input) =>
      transport.request((client) => client[WS_METHODS.gitGetMergeState](input)),
    abortMerge: (input) => transport.request((client) => client[WS_METHODS.gitAbortMerge](input)),

    runStackedAction: async (input, options) => {
      let result: GitRunStackedActionResult | null = null;

      await transport.drain(
        (client) => client[WS_METHODS.gitRunStackedAction](input),
        (event) => {
          options?.onProgress?.(event);
          if (event.kind === "action_finished") {
            result = event.result;
          }
        },
      );

      if (result) {
        return result;
      }

      throw new Error("Git action stream completed without a final result.");
    },
    resolvePullRequest: (input) =>
      transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
    preparePullRequestThread: (input) =>
      transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
  };
}
