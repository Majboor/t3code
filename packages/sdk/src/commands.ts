/**
 * Orchestration writes all travel through one RPC, so every group that changes
 * a project or a thread funnels through here.
 *
 * @module commands
 */
import { type ClientOrchestrationCommand, ORCHESTRATION_WS_METHODS } from "@t3tools/contracts";

import type { RpcSuccess, T3Transport } from "./transport.ts";

/** What the server returns once it has accepted a command. */
export type T3DispatchAck = RpcSuccess<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;

export function dispatch(
  transport: T3Transport,
  command: ClientOrchestrationCommand,
): Promise<T3DispatchAck> {
  return transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](command));
}
