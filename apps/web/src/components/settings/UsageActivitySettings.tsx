import { TenantId, WorkspaceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { ActivityIcon } from "lucide-react";

import { readEnvironmentApi } from "../../environmentApi";
import {
  fetchGatewayUsage,
  usePrimaryEnvironmentId,
  type GatewayUsageResult,
} from "../../environments/primary";
import { useCollaborationUsage } from "../../hooks/useCollaborationUsage";
import { UsagePanel } from "../collaboration/usage/UsagePanel";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { UsageActivityHeatmap } from "./UsageActivityHeatmap";
import {
  formatCompactCount,
  formatResetsIn,
  isLimitReached,
  percentUsed,
} from "./usageActivity.logic";

/**
 * A bar rendered from percent alone reads the same at 96% and at "actually
 * exhausted, your next request is refused right now" — both clamp to a
 * nearly-full bar in the same color. `reached` breaks that tie explicitly:
 * red bar, and the reset countdown is joined by "Limit reached" instead of
 * standing alone, so a person who just saw a rate-limit error in chat and
 * came here to check isn't left staring at what looks like normal headroom.
 */
function LimitBar({
  label,
  percent,
  resetsLabel,
  reached,
}: {
  label: string;
  percent: number;
  resetsLabel: string;
  reached: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{label}</span>
        <span className={reached ? "font-medium text-destructive" : "text-muted-foreground"}>
          {reached ? `Limit reached · ${resetsLabel}` : resetsLabel}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-border/60">
        <div
          className={
            reached
              ? "h-full rounded-full bg-destructive transition-[width]"
              : "h-full rounded-full bg-[var(--usage-accent,theme(colors.blue.500))] transition-[width]"
          }
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/** Finds this user's personal tenant/workspace — every account has exactly one. */
function usePersonalWorkspace(environmentId: ReturnType<typeof usePrimaryEnvironmentId>) {
  const [scope, setScope] = useState<{ tenantId: TenantId; workspaceId: WorkspaceId } | null>(null);

  useEffect(() => {
    if (!environmentId) return;
    const api = readEnvironmentApi(environmentId);
    if (!api) return;
    let cancelled = false;
    void api.organizations.list().then((result) => {
      if (cancelled) return;
      const personalTenant = result.tenants?.find((t) => t.kind === "personal");
      const personalWorkspace = result.workspaces?.find(
        (w) => w.kind === "personal" && (!personalTenant || w.tenantId === personalTenant.id),
      );
      if (personalTenant && personalWorkspace) {
        setScope({ tenantId: personalTenant.id, workspaceId: personalWorkspace.id });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId]);

  return scope;
}

export function UsageActivitySettings() {
  const environmentId = usePrimaryEnvironmentId();
  const personalScope = usePersonalWorkspace(environmentId);
  const nowMs = useRelativeTimeTick(30_000);

  const collaborationUsage = useCollaborationUsage({
    environmentId,
    tenantId: personalScope?.tenantId ?? null,
    workspaceId: personalScope?.workspaceId ?? null,
    enabled: personalScope !== null,
  });

  const [gatewayUsage, setGatewayUsage] = useState<GatewayUsageResult | null>(null);
  const [gatewayError, setGatewayError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      fetchGatewayUsage()
        .then(setGatewayUsage)
        .catch((err: unknown) =>
          setGatewayError(err instanceof Error ? err.message : "Failed to load usage."),
        );

    load();
    // A page opened before hitting the 5-hour burst limit — or just left open
    // in a background tab across it — would otherwise show whatever was true
    // at mount forever. This is exactly the settings page people check right
    // after seeing a rate-limit error in chat, so it has to reflect "right
    // now," not "whenever this tab happened to load."
    const intervalId = window.setInterval(load, 30_000);
    return () => window.clearInterval(intervalId);
  }, []);

  return (
    <SettingsPageContainer>
      <SettingsSection title="Usage limits" icon={<ActivityIcon className="size-3.5" />}>
        {gatewayError ? (
          <SettingsRow title="Could not load limits" description={gatewayError} />
        ) : !gatewayUsage ? (
          <SettingsRow title="Loading…" description="Fetching your current limits." />
        ) : (
          <>
            <SettingsRow
              title="Monthly plan allowance"
              description={
                gatewayUsage.plan
                  ? `${gatewayUsage.plan.name} plan`
                  : "No active plan — billed from balance."
              }
            >
              {gatewayUsage.plan ? (
                <div className="pb-4">
                  <LimitBar
                    label="Monthly allowance"
                    percent={percentUsed(
                      Number(gatewayUsage.plan.tokensUsed),
                      Number(gatewayUsage.plan.includedTokens),
                    )}
                    resetsLabel={formatResetsIn(gatewayUsage.plan.periodEnd, nowMs)}
                    reached={isLimitReached(
                      Number(gatewayUsage.plan.tokensUsed),
                      Number(gatewayUsage.plan.includedTokens),
                    )}
                  />
                </div>
              ) : null}
            </SettingsRow>
            <SettingsRow
              title="5-hour burst limit"
              description="A rolling window on top of your monthly allowance, so one long session can't use up the whole month at once."
            >
              {gatewayUsage.sessionWindow ? (
                <div className="pb-4">
                  <LimitBar
                    label="Current 5h window"
                    percent={percentUsed(
                      gatewayUsage.sessionWindow.tokensUsed,
                      gatewayUsage.sessionWindow.tokensLimit,
                    )}
                    resetsLabel={formatResetsIn(gatewayUsage.sessionWindow.resetsAt, nowMs)}
                    reached={isLimitReached(
                      gatewayUsage.sessionWindow.tokensUsed,
                      gatewayUsage.sessionWindow.tokensLimit,
                    )}
                  />
                </div>
              ) : (
                <div className="pb-4 text-xs text-muted-foreground">
                  No session limit on this plan.
                </div>
              )}
            </SettingsRow>
          </>
        )}
      </SettingsSection>

      <SettingsSection title="Where your usage came from">
        {gatewayUsage ? (
          <SettingsRow
            title="Inside LogicPacks vs external"
            description="Requests from LogicPacks' own chat vs the same API key used in your own scripts or tools (last 30 days)."
          >
            <div className="grid grid-cols-2 gap-3 pb-4 sm:w-80">
              <div className="rounded-lg border border-border/60 p-3">
                <div className="text-[11px] text-muted-foreground">Inside LogicPacks</div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCompactCount(gatewayUsage.usageBySource30d.internal.requests)}
                </div>
                <div className="text-[11px] text-muted-foreground">requests</div>
              </div>
              <div className="rounded-lg border border-border/60 p-3">
                <div className="text-[11px] text-muted-foreground">External (same key)</div>
                <div className="text-lg font-semibold tabular-nums">
                  {formatCompactCount(gatewayUsage.usageBySource30d.external.requests)}
                </div>
                <div className="text-[11px] text-muted-foreground">requests</div>
              </div>
            </div>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Activity">
        {gatewayUsage ? (
          <>
            <SettingsRow title="Daily activity" description="Requests per day, last 365 days.">
              <div className="pb-4">
                <UsageActivityHeatmap daily={gatewayUsage.dailyActivity} />
              </div>
            </SettingsRow>
            <SettingsRow title="Lifetime" description="Since this account was created.">
              <div className="grid grid-cols-3 gap-3 pb-4">
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCompactCount(gatewayUsage.lifetime.requests)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">total requests</div>
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-lg font-semibold tabular-nums">
                    {formatCompactCount(gatewayUsage.lifetime.processedTokens)}
                  </div>
                  <div className="text-[11px] text-muted-foreground">tokens processed</div>
                </div>
                <div className="rounded-lg border border-border/60 p-3">
                  <div className="text-lg font-semibold tabular-nums">
                    {gatewayUsage.lifetime.longestStreakDays}
                  </div>
                  <div className="text-[11px] text-muted-foreground">day streak</div>
                </div>
              </div>
            </SettingsRow>
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection title="Claude & Codex usage">
        <div className="p-4 sm:p-5">
          <UsagePanel
            usage={collaborationUsage.data}
            loading={collaborationUsage.isLoading}
            error={collaborationUsage.error}
            onRefresh={() => void collaborationUsage.refetch()}
            refreshing={collaborationUsage.isFetching}
          />
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
