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

export interface GatewayUsageResult {
  readonly balance: { readonly nanos: string; readonly usd: number };
  readonly plan: GatewayUsagePlan | null;
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
  readonly redeemCode: (
    userId: UserId,
    code: string,
  ) => Effect.Effect<GatewayRedeemResult, GatewayError>;
  readonly getApiKey: (userId: UserId) => Effect.Effect<Option.Option<string>, GatewayError>;
}

export class LogicPacksGateway extends Context.Service<LogicPacksGateway, LogicPacksGatewayShape>()(
  "t3/gateway/Services/LogicPacksGateway",
) {}
