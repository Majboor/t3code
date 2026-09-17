import { Context } from "effect";

import type { ServerProviderShape } from "./ServerProvider.ts";

export interface GlmProviderShape extends ServerProviderShape {}

export class GlmProvider extends Context.Service<GlmProvider, GlmProviderShape>()(
  "t3/provider/Services/GlmProvider",
) {}
