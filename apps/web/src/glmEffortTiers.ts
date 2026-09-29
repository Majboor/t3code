/**
 * The composer's High/Medium/Low effort tiers for the GLM provider — a
 * simple picker in place of raw model names, backed by real, different
 * models. Kept in sync by hand with the LogicPacks gateway's own
 * `logicpacks/high|medium|low` tier aliases (`src/lib/tiers.ts` in the
 * gateway repo); the two are independent (T3 resolves its own tiers to a
 * real model id here and sends that directly, it never touches the
 * gateway's alias endpoint), but should always point at the same models.
 */
export type GlmEffortTier = "high" | "low";

export const GLM_EFFORT_TIER_MODEL: Readonly<Record<GlmEffortTier, string>> = {
  // One family (GLM-5.3), served via Fireworks rather than Kitani — see the
  // gateway's UPSTREAM_MODEL_ALIAS (proxy/upstream.ts) for the native model
  // id mapping. Only two real sizes exist for this family, so the slider is
  // two positions, not three — no "medium" model to invent a middle out of.
  high: "z-ai/glm-5.3",
  low: "z-ai/glm-5.3-flash",
};

export const GLM_EFFORT_TIER_LABEL: Readonly<Record<GlmEffortTier, string>> = {
  high: "High",
  low: "Low",
};

/** Short, real model names for the slider's live drag label. */
export const GLM_EFFORT_TIER_MODEL_LABEL: Readonly<Record<GlmEffortTier, string>> = {
  high: "GLM-5.3",
  low: "GLM-5.3 Flash",
};

/** Slider order: low effort on the left, high effort on the right. */
export const GLM_EFFORT_TIERS: ReadonlyArray<GlmEffortTier> = ["low", "high"];

/** Reverse lookup: which tier (if any) a given real model id currently backs. */
export function tierForGlmModel(model: string | null | undefined): GlmEffortTier | null {
  if (!model) return null;
  for (const tier of GLM_EFFORT_TIERS) {
    if (GLM_EFFORT_TIER_MODEL[tier] === model) return tier;
  }
  return null;
}
