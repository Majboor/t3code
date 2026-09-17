import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export interface GatewayUsagePlan {
  readonly code: string;
  readonly name: string;
  readonly includedTokens: string;
  readonly tokensUsed: string;
  readonly periodEnd: string;
}

export interface GatewaySessionWindow {
  readonly tokensUsed: number;
  readonly tokensLimit: number;
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
  readonly sessionWindow: GatewaySessionWindow | null;
  readonly usage30d: {
    readonly requests: number;
    readonly processedTokens: number;
    readonly cacheHitRate: number;
    readonly billedUsd: number;
  };
  readonly usageBySource30d: {
    readonly internal: GatewayUsageBySource;
    readonly external: GatewayUsageBySource;
  };
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

function parseGatewayErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.trim().length > 0
    ) {
      return parsed.error.trim();
    }
  } catch {
    return trimmed;
  }
  return null;
}

async function readGatewayErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text();
  return parseGatewayErrorMessage(text) ?? fallbackMessage;
}

export async function fetchGatewayUsage(): Promise<GatewayUsageResult> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/gateway/usage"), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(
      await readGatewayErrorMessage(response, `Failed to load API usage (${response.status}).`),
    );
  }
  return (await response.json()) as GatewayUsageResult;
}

export async function fetchGatewayApiKey(): Promise<string | null> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/gateway/key"), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(
      await readGatewayErrorMessage(response, `Failed to load your API key (${response.status}).`),
    );
  }
  const body = (await response.json()) as { api_key: string | null };
  return body.api_key;
}

export async function redeemGatewayCode(code: string): Promise<GatewayRedeemResult> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/gateway/redeem"), {
    body: JSON.stringify({ code }),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      await readGatewayErrorMessage(response, `Failed to redeem code (${response.status}).`),
    );
  }
  return (await response.json()) as GatewayRedeemResult;
}
