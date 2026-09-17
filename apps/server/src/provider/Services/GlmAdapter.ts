/**
 * GlmAdapter - GLM-5.3 (LogicPacks) implementation of the generic provider
 * adapter contract.
 *
 * Unlike Claude/Codex, this provider's "runtime" is `opencode acp` (a real
 * Agent Client Protocol server) rather than a vendor SDK/CLI with its own
 * bespoke JSON-RPC dialect, and its credential is the calling user's own
 * LogicPacks gateway API key (Phase A), not an OAuth account.
 *
 * @module GlmAdapter
 */
import { Context } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface GlmAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "glm";
}

export class GlmAdapter extends Context.Service<GlmAdapter, GlmAdapterShape>()(
  "t3/provider/Services/GlmAdapter",
) {}
