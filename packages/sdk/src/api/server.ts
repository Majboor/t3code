/**
 * Server configuration, settings, and the agent provider accounts it holds.
 *
 * @module api/server
 */
import {
  type AuthAccessStreamEvent,
  type ServerConfigStreamEvent,
  type ServerLifecycleStreamEvent,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3ServerApi {
  readonly getConfig: () => Promise<RpcSuccess<typeof WS_METHODS.serverGetConfig>>;
  readonly refreshProviders: () => Promise<RpcSuccess<typeof WS_METHODS.serverRefreshProviders>>;
  readonly getSettings: () => Promise<RpcSuccess<typeof WS_METHODS.serverGetSettings>>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Promise<RpcSuccess<typeof WS_METHODS.serverUpdateSettings>>;
  readonly upsertKeybinding: (
    input: RpcInput<typeof WS_METHODS.serverUpsertKeybinding>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.serverUpsertKeybinding>>;
  readonly watchConfig: (
    onEvent: (event: ServerConfigStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
  readonly watchLifecycle: (
    onEvent: (event: ServerLifecycleStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
  /** Fires when the session's tenant access changes underneath it. */
  readonly watchAccess: (
    onEvent: (event: AuthAccessStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
}

export function makeServerApi(transport: T3Transport): T3ServerApi {
  return {
    getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
    refreshProviders: () =>
      transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
    getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
    updateSettings: (patch) =>
      transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
    upsertKeybinding: (input) =>
      transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
    watchConfig: (onEvent, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeServerConfig]({}),
        onEvent,
        options,
      ),
    watchLifecycle: (onEvent, options) =>
      transport.subscribe(
        (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
        onEvent,
        options,
      ),
    watchAccess: (onEvent, options) =>
      transport.subscribe((client) => client[WS_METHODS.subscribeAuthAccess]({}), onEvent, options),
  };
}

export interface T3ProvidersApi {
  readonly list: () => Promise<RpcSuccess<typeof WS_METHODS.providerAccountsList>>;
  readonly connect: (
    input: RpcInput<typeof WS_METHODS.providerAccountsConnect>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerAccountsConnect>>;
  /** Opens the provider's own CLI login in a server-side terminal. */
  readonly openAuthTerminal: (
    input: RpcInput<typeof WS_METHODS.providerAccountsOpenAuthTerminal>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerAccountsOpenAuthTerminal>>;
  readonly confirm: (
    input: RpcInput<typeof WS_METHODS.providerAccountsConfirm>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerAccountsConfirm>>;
  readonly disconnect: (
    input: RpcInput<typeof WS_METHODS.providerAccountsDisconnect>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.providerAccountsDisconnect>>;
}

export function makeProvidersApi(transport: T3Transport): T3ProvidersApi {
  return {
    list: () => transport.request((client) => client[WS_METHODS.providerAccountsList]({})),
    connect: (input) =>
      transport.request((client) => client[WS_METHODS.providerAccountsConnect](input)),
    openAuthTerminal: (input) =>
      transport.request((client) => client[WS_METHODS.providerAccountsOpenAuthTerminal](input)),
    confirm: (input) =>
      transport.request((client) => client[WS_METHODS.providerAccountsConfirm](input)),
    disconnect: (input) =>
      transport.request((client) => client[WS_METHODS.providerAccountsDisconnect](input)),
  };
}
