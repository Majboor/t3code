import { useCallback, useEffect, useState } from "react";

import {
  fetchGatewayUsage,
  redeemGatewayCode,
  type GatewayUsageResult,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PLAN_TILES = [
  { code: "free", name: "Free", price: "$0/mo", tokens: "2M tokens/mo" },
  { code: "starter", name: "Starter", price: "$5/mo", tokens: "60M tokens/mo" },
  { code: "pro", name: "Pro", price: "$12/mo", tokens: "180M tokens/mo" },
  { code: "max", name: "Max", price: "$60/mo", tokens: "1B tokens/mo" },
] as const;

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
  const [usage, setUsage] = useState<GatewayUsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    fetchGatewayUsage()
      .then(setUsage)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load billing info."));
  }, []);

  useEffect(() => reload(), [reload]);

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
        <div className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-4">
          {PLAN_TILES.map((tile) => (
            <div key={tile.code} className="space-y-1 bg-card p-4">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
                {tile.name}
              </div>
              <div className="text-lg font-semibold">{tile.price}</div>
              <div className="text-xs text-muted-foreground">{tile.tokens}</div>
            </div>
          ))}
        </div>
        <SettingsRow
          title="Upgrade"
          description="Payment is handled off-platform for now — once confirmed, you'll get a one-time code to redeem below."
          control={<RedeemCodeForm onRedeemed={reload} />}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
