/**
 * PromptbarClient - resolves free-text composer input against the intent
 * classifier + pack-retrieval service (external, on the homelab ML box).
 *
 * Config-gated on `T3CODE_PROMPTBAR_URL`: absent means every call is a
 * typed "not configured" error, same convention as LogicPacksGateway.
 *
 * @module PromptbarClient
 */
import { Context, Data, Effect } from "effect";

export class PromptbarError extends Data.TaggedError("PromptbarError")<{
  readonly message: string;
  readonly status?: number;
}> {}

export type PromptbarIntent = "ACTION" | "QUESTION" | "STATEMENT" | "CONTINUATION";
export type PromptbarZone = "attach" | "suggest" | "silent";

export interface PromptbarCandidate {
  readonly pack_id: string;
  readonly name: string;
  readonly description: string;
  readonly matched_phrasing: string;
  readonly score: number;
}

export interface PromptbarResolution {
  readonly intent: PromptbarIntent;
  readonly confidence: number;
  readonly zone: PromptbarZone;
  readonly packs: readonly PromptbarCandidate[];
  readonly note: string | null;
}

export interface PromptbarClientShape {
  /**
   * The first message in a session can never be a CONTINUATION - that
   * constraint belongs to the caller (it knows session state), not here.
   */
  readonly resolve: (text: string, k?: number) => Effect.Effect<PromptbarResolution, PromptbarError>;
}

export class PromptbarClient extends Context.Service<PromptbarClient, PromptbarClientShape>()(
  "t3/promptbar/Services/PromptbarClient",
) {}
