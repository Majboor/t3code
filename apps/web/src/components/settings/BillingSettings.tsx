import { useCallback, useEffect, useState } from "react";

import {
  fetchGatewayInstance,
  fetchGatewayUsage,
  redeemGatewayCode,
  type GatewayInstance,
  type GatewayPlanOffer,
  type GatewayUsageResult,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The shapes `/api/gateway/status` answers with, and the two fields a newer
 * `/api/gateway/usage` adds. They are declared here rather than in the shared
 * gateway client because every one of them is optional by design: an older
 * server sends none of it, and this page has to keep working against one.
 */
/** What a server new enough to answer at all adds to the usage payload. */
type UsageWithCatalogue = GatewayUsageResult &
  Partial<{
    readonly configured: boolean;
    readonly planCatalogue: ReadonlyArray<GatewayPlanOffer>;
  }>;

/**
 * Prices come from the gateway or they do not come at all. A plan the gateway
 * quoted no price for shows a dash: a wrong number is worse than no number,
 * because someone acts on it.
 */
export function formatPlanPrice(priceUsdMonthly: number | null): string {
  if (priceUsdMonthly === null || !Number.isFinite(priceUsdMonthly)) return "—";
  if (priceUsdMonthly === 0) return "Free";
  return Number.isInteger(priceUsdMonthly)
    ? `$${priceUsdMonthly}/mo`
    : `$${priceUsdMonthly.toFixed(2)}/mo`;
}

/** Matches the `12.3M` shorthand the API usage page already uses. */
export function formatPlanTokens(includedTokens: string | null): string | null {
  if (includedTokens === null) return null;
  const n = Number(includedTokens);
  if (!Number.isFinite(n)) return includedTokens;
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B tokens/mo`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens/mo`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K tokens/mo`;
  return `${n} tokens/mo`;
}

/**
 * The catalogue the page should draw, given both places it can arrive from.
 * The usage payload wins when it has one — it is the fresher of the two, and
 * on a server that inlines the catalogue it arrived in the same round trip.
 */
export function resolvePlanCatalogue(
  usage: UsageWithCatalogue | null,
  instance: GatewayInstance | null,
): ReadonlyArray<GatewayPlanOffer> {
  if (usage?.planCatalogue && usage.planCatalogue.length > 0) return usage.planCatalogue;
  return instance?.planCatalogue ?? [];
}

/** Only a server that positively said so counts as "there is no gateway here". */
export function isGatewayAbsent(
  usage: UsageWithCatalogue | null,
  instance: GatewayInstance | null,
): boolean {
  return instance?.configured === false || usage?.configured === false;
}

function RedeemCodeForm({ onRedeemed }: { onRedeemed: () => void }) {
  const [code, setCode] = useState("");
  const [isRedeeming, setIsRedeeming] = useState(false);

  const handleRedeem = useCallback(async () => {
    if (!code.trim()) return;
    setIsRedeeming(true);
    try {
      const result = await redeemGatewayCode(code.trim());
      setCode("");
      toastManager.add({
        type: "success",
        title: "Code redeemed",
        description:
          result.kind === "plan"
            ? `You're now on the ${result.planName} plan.`
            : `Added $${result.creditUsd.toFixed(2)} credit to your account.`,
      });
      onRedeemed();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to redeem code.";
      toastManager.add({ type: "error", title: "Could not redeem code", description: message });
    } finally {
      setIsRedeeming(false);
    }
  }, [code, onRedeemed]);

  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <Input
        value={code}
        onChange={(event) => setCode(event.target.value)}
        placeholder="rdm_..."
        disabled={isRedeeming}
        className="font-mono text-xs"
      />
      <Button size="xs" disabled={isRedeeming || !code.trim()} onClick={() => void handleRedeem()}>
        {isRedeeming ? "Redeeming…" : "Redeem"}
      </Button>
    </div>
  );
}

export function BillingSettings() {
  const [usage, setUsage] = useState<UsageWithCatalogue | null>(null);
  const [instance, setInstance] = useState<GatewayInstance | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchGatewayUsage()
      .then((result) => setUsage(result as UsageWithCatalogue))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Failed to load billing info."),
      );
  }, []);

  useEffect(() => reload(), [reload]);

  // Asked separately from usage because it answers a different question: usage
  // is about this person's account and fails when they have none, while this is
  // about the instance and always answers.
  useEffect(() => {
    let cancelled = false;
    fetchGatewayInstance()
      .then((result) => {
        if (!cancelled) setInstance(result);
      })
      .catch(() => {
        // Not knowing is the starting state already; nothing to record.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const gatewayAbsent = isGatewayAbsent(usage, instance);
  const planCatalogue = resolvePlanCatalogue(usage, instance);

  if (gatewayAbsent) {
    return (
      <SettingsPageContainer>
        <SettingsSection title="Billing">
          <SettingsRow
            title="No billing on this instance"
            description="This T3 Code instance runs without the LogicPacks API gateway, so there is no plan, no balance and nothing to buy here. Model access is whatever the provider logins on this instance allow."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection title="Current plan">
        {error ? (
          <SettingsRow title="Could not load billing info" description={error} />
        ) : (
          <SettingsRow
            title={usage?.plan?.name ?? "Loading…"}
            description={
              usage?.plan
                ? `Resets ${new Date(usage.plan.periodEnd).toLocaleDateString()}`
                : "Your current LogicPacks API plan."
            }
          />
        )}
      </SettingsSection>

      <SettingsSection title="Plans">
        {planCatalogue.length > 0 ? (
          <div className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4">
            {planCatalogue.map((offer) => {
              const tokens = formatPlanTokens(offer.includedTokens);
              return (
                <div key={offer.code} className="space-y-1 bg-card p-4">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
                    {offer.name}
                  </div>
                  <div className="text-lg font-semibold">
                    {formatPlanPrice(offer.priceUsdMonthly)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {tokens ?? offer.description ?? ""}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          // Previously this grid showed four hardcoded tiles with prices this
          // app had no way to keep true. An empty catalogue now says nothing
          // rather than something possibly wrong.
          <SettingsRow
            title="Plans"
            description="The gateway has not published a plan list, so there is nothing to show here yet. Redeeming a code below still works."
          />
        )}
        <SettingsRow
          title="Upgrade"
          description="Payment is handled off-platform for now — once confirmed, you'll get a one-time code to redeem below."
          control={<RedeemCodeForm onRedeemed={reload} />}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
