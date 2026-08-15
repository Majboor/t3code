import type { CollaborationUsageQueryResult } from "@t3tools/contracts";
import { RefreshCwIcon, TableIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { Button } from "../../ui/button";
import { Skeleton } from "../../ui/skeleton";
import { UsageHoursChart } from "./UsageHoursChart";
import { UsageLeaderboard } from "./UsageLeaderboard";
import { UsageProviderSplit } from "./UsageProviderSplit";
import { UsageTrendChart } from "./UsageTrendChart";
import {
  buildDayTrendView,
  describeUsageError,
  buildHourOfDayView,
  buildLeaderboardRows,
  buildProviderSplit,
  describeUnpricedTokens,
  formatEstimatedCost,
  formatTokenCount,
  formatWindowLabel,
  viewerUtcOffsetMinutes,
} from "./usageMetrics.logic";

/**
 * The panel's own chart palette, kept local because the app has no chart ramp
 * of its own yet. Slots come from a validated categorical set: blue and orange
 * clear the colourblind separation gates in both modes, and the unattributed
 * slice takes a neutral grey on purpose — it is the absence of an identity,
 * not a third one.
 */
const USAGE_PALETTE = cn(
  "[--usage-accent:#2a78d6] [--usage-accent-soft:#86b6ef] [--usage-codex:#2a78d6]",
  "[--usage-claude:#eb6834] [--usage-unrecorded:#8a8983] [--usage-grid:#e5e4df]",
  "dark:[--usage-accent:#3987e5] dark:[--usage-accent-soft:#184f95] dark:[--usage-codex:#3987e5]",
  "dark:[--usage-claude:#d95926] dark:[--usage-unrecorded:#7d7c76] dark:[--usage-grid:#33322f]",
);

export function UsagePanel({
  usage,
  loading,
  error,
  onRefresh,
  refreshing,
}: {
  usage: CollaborationUsageQueryResult | undefined;
  loading: boolean;
  error: Error | null;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [showNumbers, setShowNumbers] = useState(false);
  const failure = describeUsageError(error);

  const views = useMemo(() => {
    if (!usage) return null;
    return {
      trend: buildDayTrendView(usage.byDay),
      hours: buildHourOfDayView(usage.byHourOfDay, viewerUtcOffsetMinutes()),
      providers: buildProviderSplit(usage.byProvider),
      leaderboard: buildLeaderboardRows(usage.leaderboard),
      unpriced: describeUnpricedTokens(usage.estimatedCost),
      window: formatWindowLabel(usage.since, usage.until),
    };
  }, [usage]);

  return (
    <div className={USAGE_PALETTE} data-testid="collaboration-usage-panel">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">Usage</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {views?.window ?? "Last 30 days"}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            size="xs"
            variant="ghost"
            aria-label={showNumbers ? "Show charts" : "Show numbers"}
            aria-pressed={showNumbers}
            className={cn(showNumbers && "text-foreground")}
            onClick={() => setShowNumbers((current) => !current)}
            data-testid="collaboration-usage-numbers-toggle"
          >
            <TableIcon className="size-3.5" />
          </Button>
          {/* Refetching is deliberate and manual: the panel shares a per-user
              RPC budget with the rest of the app, and a month of usage does not
              move while someone reads it. */}
          <Button
            size="xs"
            variant="ghost"
            aria-label="Refresh usage"
            disabled={refreshing}
            onClick={onRefresh}
            data-testid="collaboration-usage-refresh"
          >
            <RefreshCwIcon className={cn("size-3.5", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {failure ? (
        <div className="mt-3" data-testid="collaboration-usage-error">
          <p className="text-[11px] text-destructive-foreground">{failure.summary}</p>
          {failure.detail ? (
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{failure.detail}</p>
          ) : null}
          <Button size="xs" variant="outline" className="mt-2" onClick={onRefresh}>
            Try again
          </Button>
        </div>
      ) : !views ? (
        <UsagePanelSkeleton loading={loading} />
      ) : (
        <>
          <div className="mt-3 flex items-end justify-between gap-3 border-b border-border pb-3">
            <div className="min-w-0">
              <div className="text-[11px] text-muted-foreground">Estimated cost</div>
              <div
                className="text-[26px] font-semibold leading-none text-foreground"
                data-testid="collaboration-usage-cost"
              >
                {formatEstimatedCost(usage?.estimatedCost.estimatedTotalCost ?? 0)}
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] text-muted-foreground">Tokens</div>
              <div className="text-sm font-medium tabular-nums text-foreground">
                {formatTokenCount(usage?.totals.totalTokens ?? 0)}
              </div>
            </div>
          </div>

          <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
            An estimate from a rate table the server keeps, not a bill. Plan pricing, discounts and
            rate changes are invisible here.
          </p>

          {views.unpriced ? (
            <p
              className="mt-1.5 rounded-md bg-warning/10 px-2 py-1.5 text-[10px] leading-snug text-warning-foreground"
              data-testid="collaboration-usage-unpriced"
            >
              {views.unpriced.summary}
            </p>
          ) : null}

          <UsageSection title="Weekly usage" caption="Tokens per UTC calendar day">
            <UsageTrendChart trend={views.trend} showNumbers={showNumbers} />
          </UsageSection>

          <UsageSection title="Peak usage hours" caption="Summed across the whole window">
            <UsageHoursChart hours={views.hours} showNumbers={showNumbers} />
          </UsageSection>

          <UsageSection title="Which agent" caption="Tokens by the runtime that ran the turn">
            <UsageProviderSplit split={views.providers} />
          </UsageSection>

          <UsageSection title="Who used most" caption="Members who share their usage">
            <UsageLeaderboard
              rows={views.leaderboard}
              hiddenMemberCount={usage?.hiddenMemberCount ?? 0}
            />
          </UsageSection>

          <p className="mt-3 border-t border-border pt-2 text-[10px] leading-snug text-muted-foreground">
            No quota or renewal date is shown because T3 cannot see one — that lives in the
            provider&rsquo;s billing account. Switch this panel off in Settings.
          </p>
        </>
      )}
    </div>
  );
}

function UsageSection({
  title,
  caption,
  children,
}: {
  title: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <section className="mt-3 border-t border-border pt-3">
      <div className="mb-2">
        <div className="text-xs font-medium text-foreground">{title}</div>
        <div className="text-[10px] text-muted-foreground">{caption}</div>
      </div>
      {children}
    </section>
  );
}

function UsagePanelSkeleton({ loading }: { loading: boolean }) {
  if (!loading) {
    return (
      <p className="mt-3 text-[11px] text-muted-foreground">No usage has been recorded yet.</p>
    );
  }
  return (
    <div className="mt-3 grid gap-3" data-testid="collaboration-usage-loading">
      <Skeleton className="h-8 w-32" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-14 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}
