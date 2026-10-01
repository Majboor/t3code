import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ProviderKind } from "./orchestration.ts";

export const CodexReasoningEffort = Schema.Literals(["xhigh", "high", "medium", "low"]);
export type CodexReasoningEffort = typeof CodexReasoningEffort.Type;
export const ClaudeAgentEffort = Schema.Literals([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultrathink",
]);
export type ClaudeAgentEffort = typeof ClaudeAgentEffort.Type;
export type ProviderReasoningEffort = CodexReasoningEffort | ClaudeAgentEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(CodexReasoningEffort),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(ClaudeAgentEffort),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  glm: Schema.optional(Schema.Struct({})),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-6-astra",
  claudeAgent: "claude-sonnet-4-6",
  // Not "-uncensored": that id was retired (see GlmProvider.ts's
  // BUILT_IN_MODELS) and isn't offered in the model picker — a thread left
  // on this default could only reach it through the gateway's stale-id
  // fallback alias instead of a real, listed model.
  glm: "z-ai/glm-5.3-flash",
};

/**
 * The provider a fresh thread runs on when nobody has chosen one. Claude is the
 * default on shared servers: it is the account the operator connects first and
 * the one whose credential survives per-user copies.
 */
export const DEFAULT_PROVIDER: ProviderKind = "claudeAgent";

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER[DEFAULT_PROVIDER];

export const DEFAULT_MODEL_SELECTION: { provider: ProviderKind; model: string } = {
  provider: DEFAULT_PROVIDER,
  model: DEFAULT_MODEL,
};

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-6-astra",
  claudeAgent: "claude-haiku-4-5",
  // GLM never actually generates a commit message — `RoutingTextGeneration.ts`
  // routes anything that isn't claudeAgent to Codex's implementation, an
  // accepted, documented gap (see the plan's "accepted gap" list) — this entry
  // only exists to satisfy the exhaustive Record.
  glm: "z-ai/glm-5.3-flash-uncensored",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  glm: {},
  codex: {
    // Every prior slug now maps to the one model the ChatGPT-account Codex CLI
    // accepts, so a thread that saved an old model recovers instead of failing
    // with "model not supported".
    "gpt-6": "gpt-6-astra",
    astra: "gpt-6-astra",
    "gpt-5-codex": "gpt-6-astra",
    "gpt-5": "gpt-6-astra",
    "5.4": "gpt-6-astra",
    "gpt-5.4": "gpt-6-astra",
    "gpt-5.4-mini": "gpt-6-astra",
    "5.3": "gpt-6-astra",
    "gpt-5.3": "gpt-6-astra",
    "gpt-5.3-codex": "gpt-6-astra",
    "5.3-spark": "gpt-6-astra",
    "gpt-5.3-spark": "gpt-6-astra",
    "gpt-5.3-codex-spark": "gpt-6-astra",
    "gpt-5.2": "gpt-6-astra",
    "gpt-5.2-codex": "gpt-6-astra",
  },
  claudeAgent: {
    opus: "claude-opus-4-7",
    "opus-4.7": "claude-opus-4-7",
    "claude-opus-4.7": "claude-opus-4-7",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    // Bare `sonnet` still lands on 4.6 on purpose: it is what
    // DEFAULT_MODEL_BY_PROVIDER.claudeAgent points at, so repointing the bare
    // alias alone would make `--model sonnet` and a brand-new thread disagree
    // about which Sonnet they mean. 5.5 is reachable by its own aliases below.
    sonnet: "claude-sonnet-4-6",
    "sonnet-5.5": "claude-sonnet-5-5",
    "claude-sonnet-5.5": "claude-sonnet-5-5",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
};

// ── Provider display names ────────────────────────────────────────────

export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  // Product branding, not the underlying tech (GLM-5.3/DeepSeek via the
  // LogicPacks gateway) — the composer shows this, not the real model names.
  glm: "LogicPacks",
};
