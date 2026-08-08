/**
 * What has already happened: shared prompts, workspace activity, and the diffs
 * a thread produced.
 *
 * @module api/history
 */
import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3HistoryApi {
  /** Prompts and joins other members of the workspace can see. */
  readonly listActivity: (
    input: RpcInput<typeof WS_METHODS.collaborationActivityList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationActivityList>>;
  /** Activity narrowed to the prompts people have run. */
  readonly listPrompts: (
    input: RpcInput<typeof WS_METHODS.collaborationActivityList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationActivityList>["activities"]>;
  readonly recordPrompt: (
    input: RpcInput<typeof WS_METHODS.collaborationSharedPromptRecord>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationSharedPromptRecord>>;
  /** Take an entry out of the shared history, or put it back. */
  readonly setActivityVisibility: (
    input: RpcInput<typeof WS_METHODS.collaborationActivityVisibility>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.collaborationActivityVisibility>>;

  /** The diff a range of turns produced. */
  readonly getTurnDiff: (
    input: RpcInput<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>,
  ) => Promise<RpcSuccess<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>>;
  /** The diff a thread has produced from its first turn up to `toTurnCount`. */
  readonly getThreadDiff: (
    input: RpcInput<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>,
  ) => Promise<RpcSuccess<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>>;
  /** Every orchestration event after a sequence number, oldest first. */
  readonly replayEvents: (
    input: RpcInput<typeof ORCHESTRATION_WS_METHODS.replayEvents>,
  ) => Promise<RpcSuccess<typeof ORCHESTRATION_WS_METHODS.replayEvents>>;
}

export function makeHistoryApi(transport: T3Transport): T3HistoryApi {
  const listActivity = (
    input: RpcInput<typeof WS_METHODS.collaborationActivityList>,
  ): Promise<RpcSuccess<typeof WS_METHODS.collaborationActivityList>> =>
    transport.request((client) => client[WS_METHODS.collaborationActivityList](input));

  return {
    listActivity,
    listPrompts: async (input) => {
      const result = await listActivity(input);
      return result.activities.filter((activity) => activity.kind === "prompted");
    },
    recordPrompt: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationSharedPromptRecord](input)),
    setActivityVisibility: (input) =>
      transport.request((client) => client[WS_METHODS.collaborationActivityVisibility](input)),

    getTurnDiff: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
    getThreadDiff: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
    replayEvents: (input) =>
      transport.request((client) => client[ORCHESTRATION_WS_METHODS.replayEvents](input)),
  };
}
