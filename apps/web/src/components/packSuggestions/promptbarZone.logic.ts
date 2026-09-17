/**
 * Pure zone/intent rules for the promptbar's live, backend-driven
 * suggestions — kept separate from `PackSuggestionBar` so the spec's tables
 * are unit-testable without mounting React.
 *
 * Verbatim rules this encodes:
 *
 *   zone     | confidence | behaviour
 *   attach   | >= 0.60    | shown automatically
 *   suggest  | 0.35-0.60  | dismissible, Tab accepts
 *   silent   | < 0.35     | nothing
 *
 *   intent       | action
 *   ACTION       | show pack candidates from the resolve call
 *   QUESTION     | suppressed (documentation search is a separate, later surface)
 *   STATEMENT    | suppressed
 *   CONTINUATION | suppressed (the resolve call never returns candidates for it anyway)
 *
 * The confidence -> zone mapping itself is decided by the backend
 * (`PromptbarResolution.zone`); this module only decides what the bar does
 * with an already-classified resolution, and does not recompute thresholds.
 */
import type { PromptbarCandidate, PromptbarResolution } from "../../environments/primary/promptbar";
import type { SuggestablePack } from "./matchPrompt.logic";

export interface PromptbarZoneDecision {
  readonly zone: "attach" | "suggest";
  readonly candidates: ReadonlyArray<PromptbarCandidate>;
}

/**
 * What, if anything, the bar should show for the main prompt.
 *
 * Only ACTION intent, a non-silent zone, and at least one candidate produce a
 * decision. Everything else — QUESTION/STATEMENT/CONTINUATION, a silent
 * zone, an empty candidate list, or no resolution at all yet (still loading,
 * or the endpoint is down) — means "show nothing".
 */
export function deriveZoneDecision(
  resolution: PromptbarResolution | null,
): PromptbarZoneDecision | null {
  if (!resolution) return null;
  if (resolution.intent !== "ACTION") return null;
  if (resolution.zone === "silent") return null;
  if (resolution.candidates.length === 0) return null;
  return { zone: resolution.zone, candidates: resolution.candidates };
}

/**
 * True when the resolve call said ACTION but nothing good enough survived to
 * show — the "abstained" telemetry event the eval harness watches for.
 */
export function isAbstained(resolution: PromptbarResolution | null): boolean {
  if (!resolution) return false;
  return (
    resolution.intent === "ACTION" &&
    (resolution.zone === "silent" || resolution.candidates.length === 0)
  );
}

/**
 * The candidate Tab should accept, or `null` if Tab has nothing to do here.
 *
 * Only a "suggest"-zone candidate is Tab-accepted — "attach" is already shown
 * and clicking already works for it, and a dismissed bar or an open
 * hand-search box means Tab should fall through to its normal behaviour
 * (indent / menu-accept / whatever else the composer does with it).
 */
export function resolveTabAcceptCandidate(input: {
  readonly resolution: PromptbarResolution | null;
  readonly searching: boolean;
  readonly dismissed: boolean;
}): PromptbarCandidate | null {
  if (input.searching || input.dismissed) return null;
  const decision = deriveZoneDecision(input.resolution);
  if (!decision || decision.zone !== "suggest") return null;
  return decision.candidates[0] ?? null;
}

/**
 * Adapts a resolve-call candidate into the shape the bar already renders.
 *
 * Prefers the workspace's own registry entry when the candidate is a pack
 * already known locally (real publisher/version, for a correct `qualified`
 * mention) and falls back to what the candidate itself carries otherwise.
 */
export function candidateToSuggestablePack(
  candidate: PromptbarCandidate,
  knownPacks: ReadonlyArray<SuggestablePack>,
): SuggestablePack {
  const known = knownPacks.find((pack) => pack.id === candidate.packId);
  if (known) return known;
  return {
    id: candidate.packId,
    name: candidate.name,
    qualified: candidate.name,
    summary: candidate.description,
    capabilities: [],
  };
}
