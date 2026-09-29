/**
 * GlmProvider - status/snapshot Layer for the GLM-5.3 (LogicPacks) provider.
 *
 * Much simpler than Codex/Claude's: there is no CLI to spawn/probe (OpenCode
 * is a pre-installed binary on the box, not a per-user install), and no OAuth
 * account to check — the credential is the calling user's own LogicPacks
 * gateway API key, resolved per-session by `GlmAdapter`, not here. This
 * snapshot only answers "is the gateway integration configured on this
 * instance at all" (`T3CODE_GATEWAY_URL` present) — the precise per-user
 * "does this account have a key" check happens where it actually matters,
 * at session start.
 *
 * @module GlmProvider
 */
import type { ModelCapabilities, ServerProvider, ServerProviderModel } from "@t3tools/contracts";
import { Config, Effect, Equal, Layer, Option, Stream } from "effect";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { GlmProvider } from "../Services/GlmProvider.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const PROVIDER = "glm" as const;

const DEFAULT_GLM_MODEL_CAPABILITIES: ModelCapabilities = {
  reasoningEffortLevels: [],
  supportsFastMode: false,
  supportsThinkingToggle: false,
  contextWindowOptions: [],
  promptInjectedEffortLevels: [],
};

/**
 * The two models backing the composer's High/Medium/Low effort tiers
 * (`glmEffortTiers.ts` on the web side — medium and low both currently point
 * at the flash variant). Previously this was three models split across two
 * families (GLM + DeepSeek), with the GLM flagship and plain-flash variants
 * excluded for returning genuine `502`s directly from Kitani. As of the
 * Fireworks upstream switch, all tiers are served from Fireworks and stay
 * within the GLM-5.3 family; re-verify live before reintroducing Kitani or a
 * mixed-family lineup.
 */
const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "z-ai/glm-5.3",
    name: "GLM-5.3",
    isCustom: false,
    capabilities: DEFAULT_GLM_MODEL_CAPABILITIES,
  },
  {
    slug: "z-ai/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    isCustom: false,
    capabilities: DEFAULT_GLM_MODEL_CAPABILITIES,
  },
];

const GatewayConfiguredCheck = Config.string("T3CODE_GATEWAY_URL").pipe(Config.option);

export const GlmProviderLive = Layer.effect(
  GlmProvider,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;

    const checkProvider = Effect.gen(function* () {
      const gatewayUrl = yield* GatewayConfiguredCheck.asEffect();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.map((value) => value.providers.glm),
        Effect.orDie,
      );
      const models = providerModelsFromSettings(
        BUILT_IN_MODELS,
        PROVIDER,
        settings.customModels ?? [],
        DEFAULT_GLM_MODEL_CAPABILITIES,
      );
      if (Option.isNone(gatewayUrl)) {
        return buildServerProvider({
          provider: PROVIDER,
          enabled: settings.enabled,
          checkedAt: new Date().toISOString(),
          models,
          probe: {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unauthenticated" },
            message: "The LogicPacks gateway integration is not configured on this instance.",
          },
        });
      }
      return buildServerProvider({
        provider: PROVIDER,
        enabled: settings.enabled,
        checkedAt: new Date().toISOString(),
        models,
        probe: {
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated", type: "api_key", label: "LogicPacks API" },
        },
      });
    }).pipe(Effect.orDie);

    return yield* makeManagedServerProvider({
      getSettings: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.providers.glm),
        Effect.orDie,
      ),
      streamSettings: serverSettings.streamChanges.pipe(
        Stream.map((settings) => settings.providers.glm),
      ),
      haveSettingsChanged: (previous, next) => !Equal.equals(previous, next),
      initialSnapshot: (settings) =>
        buildServerProvider({
          provider: PROVIDER,
          enabled: settings.enabled,
          checkedAt: new Date().toISOString(),
          models: BUILT_IN_MODELS,
          probe: {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "GLM provider status has not been checked in this session yet.",
          },
        }),
      checkProvider,
    });
  }),
);
