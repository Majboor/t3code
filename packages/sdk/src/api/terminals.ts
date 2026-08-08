/**
 * Shell sessions running on the server.
 *
 * @module api/terminals
 */
import { type TerminalEvent, WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3TerminalsApi {
  readonly open: (
    input: RpcInput<typeof WS_METHODS.terminalOpen>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.terminalOpen>>;
  readonly write: (input: RpcInput<typeof WS_METHODS.terminalWrite>) => Promise<void>;
  readonly resize: (input: RpcInput<typeof WS_METHODS.terminalResize>) => Promise<void>;
  readonly clear: (input: RpcInput<typeof WS_METHODS.terminalClear>) => Promise<void>;
  readonly restart: (
    input: RpcInput<typeof WS_METHODS.terminalRestart>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.terminalRestart>>;
  readonly close: (input: RpcInput<typeof WS_METHODS.terminalClose>) => Promise<void>;
  /** Output from every terminal on this connection, not just one session. */
  readonly watch: (
    onEvent: (event: TerminalEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
}

export function makeTerminalsApi(transport: T3Transport): T3TerminalsApi {
  return {
    open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
    write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
    resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
    clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
    restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
    close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
    watch: (onEvent, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
        onEvent,
        options,
      ),
  };
}
