/**
 * LogicPacksGatewayLive - talks to the standalone LogicPacks API gateway
 * (the GLM-5.3 reseller, a separate app) to give every LogicPacks user a
 * gateway account, Free plan by default, visible from Settings.
 *
 * Config-gated: absent `T3CODE_GATEWAY_URL` / `T3CODE_GATEWAY_PROVISION_TOKEN`
 * means every method below is a fast no-op / typed "not configured" error.
 * This is deliberate — it is what lets the exact same build run everywhere
 * (test, prod, client clones) with the integration off everywhere except the
 * one instance that sets both env vars.
 *
 * @module LogicPacksGatewayLive
 */

import { Config, DateTime, Effect, Layer, Option } from "effect";

import type { UserId } from "@t3tools/contracts";

import { GatewayAccountRepository } from "../../persistence/Services/GatewayAccounts.ts";
import { LocalAuthAccountRepository } from "../../persistence/Services/LocalAuthAccounts.ts";
import {
  GatewayError,
  LogicPacksGateway,
  type GatewayInstance,
  type GatewayPlanOffer,
  type GatewayRedeemResult,
  type GatewayUsageResult,
  type LogicPacksGatewayShape,
} from "../Services/LogicPacksGateway.ts";

/**
 * The catalogue is a property of the instance, not of the user, and it changes
 * about as often as pricing does — so re-fetching it on every Settings visit
 * would be one wasted round trip per page load for a value that is identical
 * for everybody. A failed fetch is cached too, deliberately: a gateway build
 * that has no `/v1/plans` yet must not be hammered once per request forever.
 */
const PLAN_CATALOGUE_TTL_MS = 5 * 60_000;

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Reads a plan catalogue out of whatever the gateway sent.
 *
 * Deliberately structural rather than schema-strict: this is the one place
 * where a *separate* app's response shape crosses into ours, and a field it
 * renames or an extra key it adds must cost us a missing dash on one tile, not
 * an empty Billing page. Anything unrecognisable collapses to `[]`, which the
 * UI already has to handle for the no-catalogue case.
 *
 * Accepts either a bare array or `{ plans: [...] }`, and tolerates the two
 * spellings of a monthly price the gateway has used.
 */
export function parseGatewayPlanCatalogue(input: unknown): ReadonlyArray<GatewayPlanOffer> {
  const rows = Array.isArray(input)
    ? input
    : input && typeof input === "object" && Array.isArray((input as { plans?: unknown }).plans)
      ? ((input as { plans: ReadonlyArray<unknown> }).plans as ReadonlyArray<unknown>)
      : null;
  if (!rows) return [];

  const offers: GatewayPlanOffer[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as Record<string, unknown>;
    const code = asNonEmptyString(record.code);
    if (!code) continue;
    offers.push({
      code,
      name: asNonEmptyString(record.name) ?? code,
      priceUsdMonthly:
        asFiniteNumber(record.price_usd_monthly) ??
        asFiniteNumber(record.price_usd) ??
        asFiniteNumber(record.priceUsdMonthly),
      includedTokens:
        asNonEmptyString(record.included_tokens) ?? asNonEmptyString(record.includedTokens),
      description: asNonEmptyString(record.description),
    });
  }
  return offers;
}

const GatewayEnvConfig = Config.all({
  gatewayUrl: Config.url("T3CODE_GATEWAY_URL").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
  provisionToken: Config.string("T3CODE_GATEWAY_PROVISION_TOKEN").pipe(
    Config.option,
    Config.map(Option.getOrUndefined),
  ),
});

interface ProvisionResponse {
  readonly created?: boolean;
  readonly user_id?: string;
  readonly api_key?: string;
}

interface MeResponse {
  readonly balance: { readonly nanos: string; readonly usd: number };
  readonly plan: {
    readonly code: string;
    readonly name: string;
    readonly included_tokens: string;
    readonly tokens_used: string;
    readonly period_end: string;
  } | null;
  readonly session_window: {
    readonly tokens_used: number;
    readonly tokens_limit: number;
    readonly resets_at: string | null;
  } | null;
  readonly usage_30d: {
    readonly requests: number;
    readonly processed_tokens: number;
    readonly cache_hit_rate: number;
    readonly billed_usd: number;
  };
  readonly usage_by_source_30d: {
    readonly internal: { readonly requests: number; readonly processed_tokens: number };
    readonly external: { readonly requests: number; readonly processed_tokens: number };
  };
  readonly daily_activity: ReadonlyArray<{
    readonly day: string;
    readonly requests: number;
    readonly processed_tokens: number;
  }>;
  readonly lifetime: {
    readonly requests: number;
    readonly processed_tokens: number;
    readonly longest_streak_days: number;
  };
  /**
   * Optional: newer gateway builds inline the catalogue here so a Settings
   * visit costs one round trip instead of two. Older ones omit it and we fall
   * back to `/v1/plans`.
   */
  readonly plans?: unknown;
}

type RedeemResponse =
  | { readonly ok: true; readonly kind: "plan"; readonly plan_name: string }
  | { readonly ok: true; readonly kind: "credit"; readonly credit_usd: number };

const makeLogicPacksGateway = Effect.gen(function* () {
  const config = yield* GatewayEnvConfig.asEffect();
  const accounts = yield* GatewayAccountRepository;
  const localAccounts = yield* LocalAuthAccountRepository;

  const configured = config.gatewayUrl !== undefined && config.provisionToken !== undefined;

  const provisionForUser: LogicPacksGatewayShape["provisionForUser"] = ({ userId, email }) =>
    Effect.gen(function* () {
      if (!configured) return;

      const existing = yield* accounts
        .getByUserId({ userId })
        .pipe(Effect.catch(() => Effect.succeed(Option.none())));
      if (Option.isSome(existing)) return;

      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(new URL("/provision/users", config.gatewayUrl), {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.provisionToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              source: "logicpacks",
              external_id: userId,
              email,
              credit_usd: 0,
              key_name: "logicpacks",
            }),
          }),
        catch: (cause) =>
          new GatewayError({
            message: "The LogicPacks API gateway did not respond.",
            status: 502,
            cause,
          }),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (!response) return;

      if (!response.ok) {
        yield* Effect.logError("gateway.provision.failed", { status: response.status });
        return;
      }

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<ProvisionResponse>,
        catch: (cause) =>
          new GatewayError({
            message: "The gateway returned an unreadable response.",
            status: 502,
            cause,
          }),
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));

      // The idempotent-retry branch (account already existed on the gateway)
      // returns 200 with no `api_key` -- the secret is only ever returned
      // once, on first creation. If our own row is missing at this point we
      // have nothing to persist; this is a known, accepted edge case (see the
      // approved plan) rather than something this method can fix.
      if (!body?.api_key) {
        if (body && body.created === false) {
          yield* Effect.logError("gateway.provision.no_key_on_retry", { userId });
        }
        return;
      }

      const now = yield* DateTime.now;
      yield* accounts
        .upsert({
          userId,
          externalId: userId,
          gatewayUserId: body.user_id ?? null,
          apiKey: body.api_key,
          status: "active",
          createdAt: DateTime.toUtc(now),
          updatedAt: DateTime.toUtc(now),
        })
        .pipe(Effect.catch(() => Effect.void));
    }).pipe(Effect.catch(() => Effect.void));

  /**
   * The self-heal path: looks up the user's real email (provisioning refuses
   * an empty one) and provisions them if they don't have a gateway account
   * yet -- covers Supabase-authenticated signups and anyone who signed up
   * before this feature existed. A session with no local account (e.g. a
   * machine-owner desktop session) has nothing to provision against; that is
   * not an error, `requireApiKey` below reports the resulting "no account"
   * state on its own.
   */
  const selfHeal = (userId: UserId) =>
    localAccounts.getByUserId({ userId }).pipe(
      Effect.catch(() => Effect.succeed(Option.none())),
      Effect.flatMap((account) =>
        Option.isSome(account)
          ? provisionForUser({ userId, email: account.value.email })
          : Effect.void,
      ),
    );

  /** Assumes the caller already called `selfHeal` first. */
  const requireApiKey = (userId: UserId) =>
    Effect.gen(function* () {
      const row = yield* accounts
        .getByUserId({ userId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GatewayError({ message: "Failed to load gateway account.", status: 502, cause }),
          ),
        );
      if (Option.isNone(row)) {
        return yield* new GatewayError({
          message: "No LogicPacks API account is set up for this user yet.",
          status: 404,
        });
      }
      return row.value.apiKey;
    });

  const gatewayFetch = (path: string, apiKey: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: () =>
        fetch(new URL(path, config.gatewayUrl), {
          ...init,
          headers: { ...init?.headers, authorization: `Bearer ${apiKey}` },
        }),
      catch: (cause) =>
        new GatewayError({
          message: "The LogicPacks API gateway did not respond.",
          status: 502,
          cause,
        }),
    });

  // Instance-wide, so a single slot is enough; see PLAN_CATALOGUE_TTL_MS.
  let cachedCatalogue: { value: ReadonlyArray<GatewayPlanOffer>; expiresAt: number } | null = null;

  const rememberCatalogue = (value: ReadonlyArray<GatewayPlanOffer>) => {
    cachedCatalogue = { value, expiresAt: Date.now() + PLAN_CATALOGUE_TTL_MS };
    return value;
  };

  /**
   * `apiKey` is the user's key when we have one; the provision token stands in
   * for the instance itself when we don't, because the catalogue is public
   * pricing rather than anybody's account data.
   */
  const loadPlanCatalogue = (
    apiKey: string | null,
  ): Effect.Effect<ReadonlyArray<GatewayPlanOffer>> =>
    Effect.gen(function* () {
      if (!configured) return [];
      if (cachedCatalogue && cachedCatalogue.expiresAt > Date.now()) return cachedCatalogue.value;

      const response = yield* gatewayFetch("/v1/plans", apiKey ?? config.provisionToken ?? "").pipe(
        Effect.catch(() => Effect.succeed(null)),
      );
      if (!response?.ok) return rememberCatalogue([]);

      const body = yield* Effect.tryPromise({
        try: () => response.json() as Promise<unknown>,
        catch: (cause) =>
          new GatewayError({
            message: "The gateway returned an unreadable response.",
            status: 502,
            cause,
          }),
      }).pipe(Effect.catch(() => Effect.succeed(null)));

      return rememberCatalogue(parseGatewayPlanCatalogue(body));
    });

  const fetchInstance: LogicPacksGatewayShape["fetchInstance"] = () =>
    Effect.gen(function* () {
      // No gateway means no catalogue and no fetch: an instance without the
      // integration must never pay a network timeout to be told so.
      if (!configured) return { configured: false, planCatalogue: [] } satisfies GatewayInstance;
      const planCatalogue = yield* loadPlanCatalogue(null);
      return { configured: true, planCatalogue } satisfies GatewayInstance;
    });

  const fetchUsage: LogicPacksGatewayShape["fetchUsage"] = (userId) =>
    Effect.gen(function* () {
      if (!configured) {
        return yield* new GatewayError({
          message: "The LogicPacks API integration is not configured.",
          status: 404,
        });
      }
      yield* selfHeal(userId);
      const apiKey = yield* requireApiKey(userId);
      const response = yield* gatewayFetch("/v1/me", apiKey);
      if (!response.ok) {
        return yield* new GatewayError({
          message: "Could not load usage from the gateway.",
          status: 502,
        });
      }
      const body = (yield* Effect.tryPromise({
        try: () => response.json() as Promise<MeResponse>,
        catch: (cause) =>
          new GatewayError({
            message: "The gateway returned an unreadable response.",
            status: 502,
            cause,
          }),
      })) satisfies MeResponse;

      // An inlined catalogue is authoritative and free; it also refreshes the
      // cache that `fetchInstance` reads, so the two never disagree.
      const inlineCatalogue = parseGatewayPlanCatalogue(body.plans);
      const planCatalogue =
        inlineCatalogue.length > 0
          ? rememberCatalogue(inlineCatalogue)
          : yield* loadPlanCatalogue(apiKey);

      return {
        configured: true,
        planCatalogue,
        balance: body.balance,
        plan: body.plan
          ? {
              code: body.plan.code,
              name: body.plan.name,
              includedTokens: body.plan.included_tokens,
              tokensUsed: body.plan.tokens_used,
              periodEnd: body.plan.period_end,
            }
          : null,
        sessionWindow: body.session_window
          ? {
              tokensUsed: body.session_window.tokens_used,
              tokensLimit: body.session_window.tokens_limit,
              resetsAt: body.session_window.resets_at,
            }
          : null,
        usage30d: {
          requests: body.usage_30d.requests,
          processedTokens: body.usage_30d.processed_tokens,
          cacheHitRate: body.usage_30d.cache_hit_rate,
          billedUsd: body.usage_30d.billed_usd,
        },
        usageBySource30d: {
          internal: {
            requests: body.usage_by_source_30d.internal.requests,
            processedTokens: body.usage_by_source_30d.internal.processed_tokens,
          },
          external: {
            requests: body.usage_by_source_30d.external.requests,
            processedTokens: body.usage_by_source_30d.external.processed_tokens,
          },
        },
        dailyActivity: body.daily_activity.map((d) => ({
          day: d.day,
          requests: d.requests,
          processedTokens: d.processed_tokens,
        })),
        lifetime: {
          requests: body.lifetime.requests,
          processedTokens: body.lifetime.processed_tokens,
          longestStreakDays: body.lifetime.longest_streak_days,
        },
      } satisfies GatewayUsageResult;
    });

  const redeemCode: LogicPacksGatewayShape["redeemCode"] = (userId, code) =>
    Effect.gen(function* () {
      if (!configured) {
        return yield* new GatewayError({
          message: "The LogicPacks API integration is not configured.",
          status: 404,
        });
      }
      yield* selfHeal(userId);
      const apiKey = yield* requireApiKey(userId);
      const response = yield* gatewayFetch("/v1/redeem", apiKey, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        return yield* new GatewayError({
          message:
            response.status === 400
              ? "That code is invalid or already used."
              : "Could not redeem the code.",
          status: response.status === 400 ? 400 : 502,
        });
      }
      const body = (yield* Effect.tryPromise({
        try: () => response.json() as Promise<RedeemResponse>,
        catch: (cause) =>
          new GatewayError({
            message: "The gateway returned an unreadable response.",
            status: 502,
            cause,
          }),
      })) satisfies RedeemResponse;

      return (
        body.kind === "plan"
          ? { ok: true, kind: "plan", planName: body.plan_name }
          : { ok: true, kind: "credit", creditUsd: body.credit_usd }
      ) satisfies GatewayRedeemResult;
    });

  const getApiKey: LogicPacksGatewayShape["getApiKey"] = (userId) =>
    Effect.gen(function* () {
      if (!configured) return Option.none();
      yield* selfHeal(userId);
      const row = yield* accounts
        .getByUserId({ userId })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GatewayError({ message: "Failed to load gateway account.", status: 502, cause }),
          ),
        );
      return Option.isSome(row) ? Option.some(row.value.apiKey) : Option.none();
    });

  return {
    provisionForUser,
    fetchUsage,
    fetchInstance,
    redeemCode,
    getApiKey,
  } satisfies LogicPacksGatewayShape;
});

export const LogicPacksGatewayLive = Layer.effect(LogicPacksGateway, makeLogicPacksGateway);
