/**
 * The promptbar's hybrid retrieval endpoints, over plain session-cookie fetch
 * — same conventions as `integrations.ts`/`gateway.ts`: `credentials:
 * "include"`, a small JSON error shape, throw on `!response.ok`.
 *
 * `resolvePromptbar` may be called against a backend that has not shipped
 * this route yet (it is built in parallel). A 404/500/network failure here
 * is not this module's problem to soften — `usePromptbarResolution` is the
 * layer that turns a rejected promise into "show nothing", the same
 * "courtesy, not a gate" pattern `OnboardingModal.tsx`'s `finish` uses.
 *
 * The shapes below mirror `apps/server/src/promptbar/Services/PromptbarClient.ts`
 * exactly (frozen interface — do not change either side without the other).
 */
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export type PromptbarIntent = "ACTION" | "QUESTION" | "STATEMENT" | "CONTINUATION";
export type PromptbarZone = "attach" | "suggest" | "silent";

export interface PromptbarCandidateParam {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly desc: string;
}

export interface PromptbarCandidate {
  readonly packId: string;
  readonly name: string;
  readonly description: string;
  /** Fused BM25+dense rank score (Reciprocal Rank Fusion), not a probability. */
  readonly retrievalScore: number;
  /**
   * A calibrated relevance probability (0..1) from the stage-3 decision
   * model, present only when retrieval's top candidates were too close to
   * call and the decision model actually ran; `candidates` is already
   * re-sorted by this when present. Null otherwise.
   */
  readonly decisionRelevance: number | null;
  readonly params: ReadonlyArray<PromptbarCandidateParam>;
}

export type PromptbarRecentContextRole = "user" | "assistant" | "tool";

export interface PromptbarRecentContextEntry {
  readonly role: PromptbarRecentContextRole;
  readonly text: string;
}

export interface PromptbarResolution {
  readonly intent: PromptbarIntent;
  readonly confidence: number;
  readonly zone: PromptbarZone;
  readonly candidates: ReadonlyArray<PromptbarCandidate>;
  readonly skipAgent: boolean;
  readonly note: string | null;
}

export interface PromptbarResolveInput {
  readonly text: string;
  /** The caller (composer/session state) must set this accurately every call — the classifier has no session memory of its own. */
  readonly isFirstMessageInSession: boolean;
  readonly k?: number;
  /**
   * A handful of recent turns (oldest first) fed to the stage-3 decision
   * model as context — entirely optional, retrieval and the intent
   * classifier never see or need it.
   */
  readonly recentContext?: ReadonlyArray<PromptbarRecentContextEntry>;
}

export type PromptbarTelemetryEventKind = "accepted" | "dismissed" | "abstained";

export interface PromptbarTelemetryInput {
  readonly event: PromptbarTelemetryEventKind;
  readonly packId?: string;
  readonly query: string;
}

function parsePromptbarErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string"
    ) {
      return parsed.error;
    }
  } catch {
    return trimmed;
  }
  return null;
}

async function readPromptbarErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  return parsePromptbarErrorMessage(text) ?? fallbackMessage;
}

export async function resolvePromptbar(input: PromptbarResolveInput): Promise<PromptbarResolution> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/promptbar/resolve"), {
    body: JSON.stringify(input),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      await readPromptbarErrorMessage(response, `Failed to resolve prompt (${response.status}).`),
    );
  }
  return (await response.json()) as PromptbarResolution;
}

/**
 * Fire-and-forget by design: a dropped telemetry event must never surface to
 * whoever just clicked "Use" or hit Tab, so this never throws.
 */
export async function sendPromptbarTelemetry(input: PromptbarTelemetryInput): Promise<void> {
  try {
    await fetch(resolvePrimaryEnvironmentHttpUrl("/api/promptbar/telemetry"), {
      body: JSON.stringify(input),
      credentials: "include",
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  } catch {
    // The eval harness losing one data point is not worth bothering the
    // person who was just trying to use a pack.
  }
}
