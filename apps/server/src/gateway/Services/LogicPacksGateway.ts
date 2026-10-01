import { Context, Data, Option } from "effect";
import type { Effect } from "effect";

import type { UserId } from "@t3tools/contracts";

export class GatewayError extends Data.TaggedError("GatewayError")<{
  readonly message: string;
  readonly status?: 400 | 404 | 502;
  readonly cause?: unknown;
}> {}

export interface GatewayUsagePlan {
  readonly code: string;
  readonly name: string;
  readonly includedTokens: string;
  readonly tokensUsed: string;
  readonly periodEnd: string;
}

/** Additive rolling 5h burst budget, on top of the plan's monthly allowance. */
export interface GatewaySessionWindow {
  readonly tokensUsed: number;
  readonly tokensLimit: number;
  /** Null when the window hasn't started yet (no request in the current period). */
  readonly resetsAt: string | null;
}

export interface GatewayUsageBySource {
  readonly requests: number;
  readonly processedTokens: number;
}

export interface GatewayDailyActivity {
  readonly day: string;
  readonly requests: number;
  readonly processedTokens: number;
}

/**
 * One plan as the gateway itself describes it.
 *
 * Prices belong to the gateway and to nothing else. The moment a price is
 * copied into the UI it becomes a second source of truth, and it goes stale
 * silently on the day pricing changes — in the user's favour or in ours, and
 * either way we only find out from a complaint. So every number here comes
 * down the wire, and `null` means "the gateway did not say", which renders as
 * a dash rather than as a figure we invented.
 */
export interface GatewayPlanOffer {
  readonly code: string;
  readonly name: string;
  readonly priceUsdMonthly: number | null;
  readonly includedTokens: string | null;
  readonly description: string | null;
}

/**
 * What this *instance* can do, as opposed to what this *user* has.
 *
 * An instance with no `T3CODE_GATEWAY_URL` / `T3CODE_GATEWAY_PROVISION_TOKEN`
 * has no billing at all — there is nothing to buy, nothing to redeem against
 * and no plan to be on. The UI needs that told apart from "the gateway is
 * configured but unreachable", because the first means "hide the page" and the
 * second means "say it is down".
 */
export interface GatewayInstance {
  readonly configured: boolean;
  readonly planCatalogue: ReadonlyArray<GatewayPlanOffer>;
}

export interface GatewayUsageResult {
  readonly balance: { readonly nanos: string; readonly usd: number };
  readonly plan: GatewayUsagePlan | null;
  /**
   * False only on an instance with no gateway configured. A usage payload from
   * such an instance carries no real numbers, so a reader that sees `false`
   * should say so rather than render zeroes as if they were measurements.
   */
  readonly configured: boolean;
  /** The plans the gateway sells; empty when it publishes no catalogue. */
  readonly planCatalogue: ReadonlyArray<GatewayPlanOffer>;
  /** Null when the active plan (if any) defines no session limit. */
  readonly sessionWindow: GatewaySessionWindow | null;
  readonly usage30d: {
    readonly requests: number;
    readonly processedTokens: number;
    readonly cacheHitRate: number;
    readonly billedUsd: number;
  };
  /** "Inside LogicPacks" vs the same issued key used externally. */
  readonly usageBySource30d: {
    readonly internal: GatewayUsageBySource;
    readonly external: GatewayUsageBySource;
  };
  /** Real historical numbers — a GitHub-contributions-style daily calendar. */
  readonly dailyActivity: ReadonlyArray<GatewayDailyActivity>;
  readonly lifetime: {
    readonly requests: number;
    readonly processedTokens: number;
    readonly longestStreakDays: number;
  };
}

export type GatewayRedeemResult =
  | { readonly ok: true; readonly kind: "plan"; readonly planName: string }
  | { readonly ok: true; readonly kind: "credit"; readonly creditUsd: number };

export interface LogicPacksGatewayShape {
  /**
   * Ensures this user has an account on the gateway, minting one if not.
   * Never fails — this is called inline from signup, and a gateway hiccup
   * must never block someone creating a LogicPacks account. Failures are
   * logged and swallowed; callers that need the result read the mapping
   * back via the other methods, which self-heal by calling this first.
   */
  readonly provisionForUser: (input: {
    readonly userId: UserId;
    readonly email: string;
  }) => Effect.Effect<void>;
  readonly fetchUsage: (userId: UserId) => Effect.Effect<GatewayUsageResult, GatewayError>;
  /**
   * Answers "is there a gateway here at all, and what does it sell" without
   * touching the user's account. Never fails: a caller asking whether to show
   * a Billing page must get an answer even when the gateway is down, and a
   * gateway that is merely down is still a gateway (`configured: true`).
   */
  readonly fetchInstance: () => Effect.Effect<GatewayInstance>;
  readonly redeemCode: (
    userId: UserId,
    code: string,
  ) => Effect.Effect<GatewayRedeemResult, GatewayError>;
  readonly getApiKey: (userId: UserId) => Effect.Effect<Option.Option<string>, GatewayError>;
}

export class LogicPacksGateway extends Context.Service<LogicPacksGateway, LogicPacksGatewayShape>()(
  "t3/gateway/Services/LogicPacksGateway",
) {}
