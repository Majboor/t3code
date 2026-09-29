/**
 * PromptbarClient - resolves free-text composer input against:
 *   [1] intent classification via a typed-decision model (`T3CODE_OPENROUTER_API_KEY`,
 *       OpenRouter's `typesafe/jev-1.13` by default — replaced the old bespoke
 *       classifier service, whose classification quality was the reason for
 *       the switch)
 *   [2] a hybrid pack-retrieval index owned by THIS service (SQLite FTS5 BM25
 *       + dense embeddings via `T3CODE_EMBEDDING_URL`/Qdrant `T3CODE_QDRANT_URL`,
 *       fused with Reciprocal Rank Fusion)
 *   [3] the same typed-decision model again, disambiguating retrieval's top
 *       candidates when they're too close to call on their own
 *
 * This is the frozen interface both the retrieval backend (PromptbarClientLive)
 * and every consumer (composer UI, agent handoff, eval harness) build against.
 * Do not change these shapes without updating all three.
 *
 * Absent decision-model config means every call is a typed "not configured"
 * error, same convention as LogicPacksGateway.
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
  readonly packId: string;
  readonly name: string;
  readonly description: string;
  /** Fused BM25+dense rank score (Reciprocal Rank Fusion), not a probability. */
  readonly retrievalScore: number;
  /**
   * A calibrated relevance probability (0..1) from the stage-3 decision
   * model, present only when retrieval's own top candidates were too close
   * to call (`computeSkipAgent` was false) and the decision model actually
   * ran. `candidates` is already re-sorted by this when present — callers
   * that only ever read `candidates[0]` need no changes. Null when the
   * decision model wasn't invoked (retrieval alone was confident) or its
   * call failed (retrieval's own ranking is the fallback either way).
   */
  readonly decisionRelevance: number | null;
  readonly params: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly required: boolean;
    readonly desc: string;
  }>;
}

export interface PromptbarResolution {
  readonly intent: PromptbarIntent;
  readonly confidence: number;
  readonly zone: PromptbarZone;
  /**
   * ACTION -> up to 5 pack candidates, highest retrievalScore first.
   * QUESTION -> empty; caller routes to documentation search instead (out of
   *   scope for this service).
   * STATEMENT -> always empty, zone is always "silent".
   * CONTINUATION -> always empty; caller must resolve against the previous
   *   turn's action itself (this service never touches the index for it).
   */
  readonly candidates: ReadonlyArray<PromptbarCandidate>;
  /**
   * True when candidates[0].retrievalScore > 0.85 AND the gap to
   * candidates[1] is > 0.25 - confident enough to skip the stage-3 agent
   * call and use candidates[0] directly. Always false when candidates.length
   * is 0 or 1 is ambiguous on its own, so callers must still check length.
   */
  readonly skipAgent: boolean;
  readonly note: string | null;
}

export interface PromptbarResolveInput {
  readonly text: string;
  /**
   * Hard rule from the spec: the first message in a session can never be a
   * CONTINUATION - free precision. The caller (composer/session state) must
   * set this; the classifier has no session memory.
   */
  readonly isFirstMessageInSession: boolean;
  readonly k?: number;
  /**
   * Recent turn history (a handful of prior user/assistant messages and tool
   * calls) fed to the stage-3 decision model as context, oldest first — it
   * has no session memory of its own the way `isFirstMessageInSession` also
   * compensates for. Purely optional context: retrieval and the intent
   * classifier never see or need it, only the decision model's `state`
   * string does, and only when it actually runs.
   */
  readonly recentContext?: ReadonlyArray<{
    readonly role: "user" | "assistant" | "tool";
    readonly text: string;
  }>;
}

export interface PromptbarClientShape {
  readonly resolve: (
    input: PromptbarResolveInput,
  ) => Effect.Effect<PromptbarResolution, PromptbarError>;
}

export class PromptbarClient extends Context.Service<PromptbarClient, PromptbarClientShape>()(
  "t3/promptbar/Services/PromptbarClient",
) {}
