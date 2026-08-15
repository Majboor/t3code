import { useState } from "react";

import { cn } from "../../../lib/utils";
import {
  formatEstimatedCost,
  formatTokenCount,
  formatWeekChange,
  type DayTrendView,
} from "./usageMetrics.logic";

/**
 * Daily tokens across the window, with the last seven days called out because
 * "is this week worse than last" is the question people open the panel with.
 *
 * One series, so no legend: the heading already says what is plotted. Only the
 * peak day is direct-labelled — a number over every column would go unread.
 */
export function UsageTrendChart({
  trend,
  showNumbers,
}: {
  trend: DayTrendView;
  showNumbers: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const focus = hovered ?? trend.peakIndex;
  const focusPoint = focus === null ? null : trend.points[focus];
  const weekChange = formatWeekChange(trend.weekChange);

  if (showNumbers) {
    return <UsageTrendTable trend={trend} />;
  }

  return (
    <div data-testid="collaboration-usage-trend">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] tabular-nums text-muted-foreground">
          {focusPoint ? (
            <>
              <span className="text-foreground">{focusPoint.label}</span>
              {" · "}
              {formatTokenCount(focusPoint.tokens)} tokens · est.{" "}
              {formatEstimatedCost(focusPoint.cost)}
            </>
          ) : (
            "No tokens recorded in this window"
          )}
        </div>
        {weekChange ? (
          <div className="shrink-0 text-[11px] text-muted-foreground">{weekChange}</div>
        ) : null}
      </div>

      <div
        className="mt-2 flex h-16 items-end gap-px"
        onMouseLeave={() => setHovered(null)}
        role="img"
        aria-label={`Daily tokens for ${trend.points.length} UTC days`}
      >
        {trend.points.map((point, index) => {
          const share = trend.maxTokens > 0 ? point.tokens / trend.maxTokens : 0;
          const isFocus = index === focus;
          return (
            <div
              key={point.day}
              className="flex h-full flex-1 items-end"
              onMouseEnter={() => setHovered(index)}
              title={`${point.label} (UTC) · ${formatTokenCount(point.tokens)} tokens · est. ${formatEstimatedCost(point.cost)}`}
            >
              <div
                className={cn("w-full transition-colors", point.tokens > 0 && "rounded-t-[3px]")}
                style={{
                  height: point.tokens > 0 ? `${Math.max(share * 100, 4)}%` : "1px",
                  backgroundColor: point.tokens
                    ? isFocus
                      ? "var(--usage-accent)"
                      : "var(--usage-accent-soft)"
                    : "var(--usage-grid)",
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
        <span>{trend.points[0]?.label ?? ""}</span>
        <span>{trend.points.at(-1)?.label ?? ""}</span>
      </div>

      <div className="mt-1.5 flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
        <span>
          Last 7 days{" "}
          <span className="text-foreground">{formatTokenCount(trend.thisWeekTokens)}</span>
        </span>
        <span>
          Week before{" "}
          <span className="text-foreground">{formatTokenCount(trend.previousWeekTokens)}</span>
        </span>
      </div>
    </div>
  );
}

/** The same series as plain numbers, so no value is only reachable by hovering. */
function UsageTrendTable({ trend }: { trend: DayTrendView }) {
  return (
    <div className="max-h-44 overflow-y-auto" data-testid="collaboration-usage-trend-table">
      <table className="w-full text-[11px] tabular-nums">
        <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Day (UTC)</th>
            <th className="py-1 text-right font-normal">Tokens</th>
            <th className="py-1 text-right font-normal">Est. cost</th>
          </tr>
        </thead>
        <tbody>
          {trend.points.map((point) => (
            <tr key={point.day} className="border-t border-border/60">
              <td className="py-1 text-foreground">{point.day}</td>
              <td className="py-1 text-right text-foreground">{formatTokenCount(point.tokens)}</td>
              <td className="py-1 text-right text-muted-foreground">
                {formatEstimatedCost(point.cost)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
