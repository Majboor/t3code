import { useEffect, useState } from "react";

import {
  fetchGatewayApiKey,
  fetchGatewayUsage,
  type GatewayUsageResult,
} from "../../environments/primary";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Textarea } from "../ui/textarea";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function formatUsd(amount: number): string {
  return `$${amount.toFixed(2)}`;
}

function formatTokens(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function ApiKeyReveal() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isOpen, setIsOpen] = useState(false);
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  useEffect(() => {
    if (!isOpen || apiKey !== null) return;
    fetchGatewayApiKey()
      .then(setApiKey)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load API key."));
  }, [isOpen, apiKey]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger render={<Button size="xs" variant="outline" />}>Show API key</DialogTrigger>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Your LogicPacks API key</DialogTitle>
          <DialogDescription>
            Use it with any OpenAI-compatible client — including OpenCode — by pointing the base
            URL at the LogicPacks API gateway and passing this key as the bearer token.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-3">
          {error ? (
            <p className="text-xs text-destructive">{error}</p>
          ) : (
            <Textarea
              readOnly
              value={apiKey ?? "Loading…"}
              rows={2}
              className="font-mono text-xs"
              onFocus={(event) => event.currentTarget.select()}
              onClick={(event) => event.currentTarget.select()}
            />
          )}
          <pre className="overflow-auto rounded-lg border border-border/60 bg-muted/30 p-3 text-[11px] leading-relaxed">
            {`opencode.jsonc:
"provider": {
  "logicpacks": {
    "npm": "@ai-sdk/openai-compatible",
    "options": { "baseURL": "<gateway url>/v1", "apiKey": "<this key>" }
  }
}`}
          </pre>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={() => setIsOpen(false)}>
            Done
          </Button>
          {apiKey ? (
            <Button variant="outline" size="xs" onClick={() => copyToClipboard(apiKey, undefined)}>
              {isCopied ? "Copied" : "Copy"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function ApiUsageSettings() {
  const [usage, setUsage] = useState<GatewayUsageResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchGatewayUsage()
      .then(setUsage)
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Failed to load API usage."));
  }, []);

  return (
    <SettingsPageContainer>
      <SettingsSection title="LogicPacks API">
        {error ? (
          <SettingsRow title="Could not load usage" description={error} />
        ) : !usage ? (
          <SettingsRow title="Loading…" description="Fetching your plan and usage." />
        ) : (
          <>
            <SettingsRow
              title="Plan & balance"
              description={
                usage.plan
                  ? `${usage.plan.name} plan · ${formatTokens(usage.plan.tokensUsed)} of ${formatTokens(usage.plan.includedTokens)} tokens used this period`
                  : "No active plan."
              }
              status={`Credit balance: ${formatUsd(usage.balance.usd)}`}
            />
            <SettingsRow
              title="Last 30 days"
              description={`${usage.usage30d.requests.toLocaleString()} requests · ${(usage.usage30d.cacheHitRate * 100).toFixed(0)}% cache hit rate`}
              status={`Spent: ${formatUsd(usage.usage30d.billedUsd)}`}
            />
            <SettingsRow
              title="API key"
              description="Use it to call the LogicPacks API from OpenCode or any OpenAI-compatible tool."
              control={<ApiKeyReveal />}
            />
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
