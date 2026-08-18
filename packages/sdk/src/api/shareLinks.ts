/**
 * Public share links: minting a URL that works without an account here, listing
 * what a workspace has handed out, and switching one off.
 *
 * @module api/shareLinks
 */
import { WS_METHODS } from "@t3tools/contracts";

import type { RpcInput, RpcSuccess, T3Transport } from "../transport.ts";

export interface T3ShareLinksApi {
  /**
   * Mints a link and returns its token. This is the only call that ever does:
   * `list` reports every other field but never the token again, so a caller
   * that wants the URL has to build and keep it here.
   */
  readonly create: (
    input: RpcInput<typeof WS_METHODS.shareLinksCreate>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.shareLinksCreate>>;
  /** Omit `projectId` for the whole workspace, including workspace-scoped links. */
  readonly list: (
    input: RpcInput<typeof WS_METHODS.shareLinksList>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.shareLinksList>>;
  /** By id, not by token — the caller is reading its own list, where ids are what it has. */
  readonly revoke: (
    input: RpcInput<typeof WS_METHODS.shareLinksRevoke>,
  ) => Promise<RpcSuccess<typeof WS_METHODS.shareLinksRevoke>>;
}

export function makeShareLinksApi(transport: T3Transport): T3ShareLinksApi {
  return {
    create: (input) => transport.request((client) => client[WS_METHODS.shareLinksCreate](input)),
    list: (input) => transport.request((client) => client[WS_METHODS.shareLinksList](input)),
    revoke: (input) => transport.request((client) => client[WS_METHODS.shareLinksRevoke](input)),
  };
}
