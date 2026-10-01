import { assert, describe, it } from "@effect/vitest";
import { MODEL_SLUG_ALIASES_BY_PROVIDER } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import { getClaudeModelCapabilities } from "./ClaudeProvider.ts";

// `getClaudeModelCapabilities` reads the same BUILT_IN_MODELS array that
// `checkClaudeProviderStatus` hands to `providerModelsFromSettings`, so a model
// that answers with real capabilities here is a model the picker lists and the
// adapter can configure. A slug that never made it into that array falls
// through to DEFAULT_CLAUDE_MODEL_CAPABILITIES — empty effort levels, no
// context window choices — which is what these assertions rule out.
describe("Claude built-in models", () => {
  it("offers Claude Sonnet 5.5", () => {
    const caps = getClaudeModelCapabilities("claude-sonnet-5-5");
    assert.notStrictEqual(caps.reasoningEffortLevels.length, 0);
    assert.deepStrictEqual(
      caps.reasoningEffortLevels.map((level) => level.value),
      ["low", "medium", "high", "xhigh", "max", "ultrathink"],
    );
    assert.strictEqual(caps.reasoningEffortLevels.find((level) => level.isDefault)?.value, "high");
    assert.deepStrictEqual(
      caps.contextWindowOptions.map((option) => option.value),
      ["200k", "1m"],
    );
    // Fast mode is an Opus-only premium tier; offering the toggle on Sonnet
    // would send the CLI a flag it rejects.
    assert.isFalse(caps.supportsFastMode);
  });

  it("resolves the Sonnet 5.5 aliases without moving bare `sonnet`", () => {
    assert.strictEqual(normalizeModelSlug("sonnet-5.5", "claudeAgent"), "claude-sonnet-5-5");
    assert.strictEqual(normalizeModelSlug("claude-sonnet-5.5", "claudeAgent"), "claude-sonnet-5-5");
    // The bare family alias stays on 4.6 so it keeps agreeing with
    // DEFAULT_MODEL_BY_PROVIDER.claudeAgent.
    assert.strictEqual(MODEL_SLUG_ALIASES_BY_PROVIDER.claudeAgent["sonnet"], "claude-sonnet-4-6");
  });
});
