/**
 * The pack registry a workspace publishes into and searches.
 *
 * @module api/packs
 */
import { type PackRegistryStreamEvent, WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3SubscribeOptions, T3Transport } from "../transport.ts";

export interface T3PacksApi {
  /**
   * Puts a workspace's pack in the registry. Always private to that workspace:
   * listing it anywhere else is {@link T3PacksApi.setVisibility}.
   */
  readonly publish: (
    input: RpcInput<typeof WS_METHODS.packsPublish>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsPublish>>;
  readonly recordVersion: (
    input: RpcInput<typeof WS_METHODS.packsRecordVersion>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsRecordVersion>>;

  /** Everything the caller may see: their own workspace's packs, plus what is listed. */
  readonly search: (
    input: RpcInput<typeof WS_METHODS.packsSearch>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsSearch>>;
  readonly get: (
    input: RpcInput<typeof WS_METHODS.packsGet>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsGet>>;
  readonly listVersions: (
    input: RpcInput<typeof WS_METHODS.packsListVersions>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsListVersions>>;
  readonly setVisibility: (
    input: RpcInput<typeof WS_METHODS.packsSetVisibility>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.packsSetVisibility>>;

  readonly watch: (
    input: RpcInput<typeof WS_METHODS.subscribePacks>,
    onEvent: (event: PackRegistryStreamEvent) => void,
    options?: T3SubscribeOptions,
  ) => () => void;
}

export function makePacksApi(transport: T3Transport): T3PacksApi {
  return {
    publish: (input) => transport.request((client) => client[WS_METHODS.packsPublish](input)),
    recordVersion: (input) =>
      transport.request((client) => client[WS_METHODS.packsRecordVersion](input)),

    search: (input) => transport.request((client) => client[WS_METHODS.packsSearch](input)),
    get: (input) => transport.request((client) => client[WS_METHODS.packsGet](input)),
    listVersions: (input) =>
      transport.request((client) => client[WS_METHODS.packsListVersions](input)),
    setVisibility: (input) =>
      transport.request((client) => client[WS_METHODS.packsSetVisibility](input)),

    watch: (input, onEvent, options) =>
      transport.subscribe((client) => client[WS_METHODS.subscribePacks](input), onEvent, options),
  };
}
