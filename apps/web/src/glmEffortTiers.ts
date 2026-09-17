/**
 * The composer's High/Medium/Low effort tiers for the GLM provider — a
 * simple picker in place of raw model names, backed by real, different
 * models. Kept in sync by hand with the LogicPacks gateway's own
 * `logicpacks/high|medium|low` tier aliases (`src/lib/tiers.ts` in the
 * gateway repo); the two are independent (T3 resolves its own tiers to a
 * real model id here and sends that directly, it never touches the
 * gateway's alias endpoint), but should always point at the same models.
 */
export type GlmEffortTier = "high" | "medium" | "low";

export const GLM_EFFORT_TIER_MODEL: Readonly<Record<GlmEffortTier, string>> = {
  high: "z-ai/glm-5.3-flash-uncensored",
  medium: "deepseek/deepseek-v4.1-flash-thinking",
  // Standing in for `openai/gpt-oss-20b` (the original "even lower" choice),
  // which is a genuine Kitani-side outage as of 2026-09-17, not a bug here —
  // swap this one line once it recovers.
  low: "deepseek/deepseek-v4.1-flash",
};

export const GLM_EFFORT_TIER_LABEL: Readonly<Record<GlmEffortTier, string>> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Short, real model names for the slider's live drag label. */
export const GLM_EFFORT_TIER_MODEL_LABEL: Readonly<Record<GlmEffortTier, string>> = {
  high: "GLM-5.3 Flash (LogicPacks)",
  medium: "DeepSeek Thinking",
  low: "DeepSeek Flash",
};

/** Slider order: low effort on the left, high effort on the right. */
export const GLM_EFFORT_TIERS: ReadonlyArray<GlmEffortTier> = ["low", "medium", "high"];

/** Reverse lookup: which tier (if any) a given real model id currently backs. */
export function tierForGlmModel(model: string | null | undefined): GlmEffortTier | null {
  if (!model) return null;
  for (const tier of GLM_EFFORT_TIERS) {
    if (GLM_EFFORT_TIER_MODEL[tier] === model) return tier;
  }
  return null;
}
