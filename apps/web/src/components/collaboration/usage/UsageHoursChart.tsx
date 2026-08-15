import { useState } from "react";

import { formatTokenCount, type HourOfDayView } from "./usageMetrics.logic";

const AXIS_HOURS = new Set([0, 6, 12, 18]);

/**
 * When in the day the workspace works, summed over the whole window.
 *
 * Emphasis rather than eight colours: the busiest hour wears the accent and
 * every other hour a lighter step of the same hue, because the only thing
 * being asked here is which bar is tallest.
 */
export function UsageHoursChart({
  hours,
  showNumbers,
}: {
  hours: HourOfDayView;
  showNumbers: boolean;
}) {
  const [hovered, setHovered] = useState<number | null>(null);

  const focus = hovered ?? hours.peakIndex;
  const focusBucket = focus === null ? null : hours.buckets[focus];

  if (showNumbers) {
    return <UsageHoursTable hours={hours} />;
  }

  return (
    <div data-testid="collaboration-usage-hours">
      <div className="text-[11px] tabular-nums text-muted-foreground">
        {focusBucket && hours.maxTokens > 0 ? (
          <>
            <span className="text-foreground">{focusBucket.label}</span>
            {" · "}
            {formatTokenCount(focusBucket.tokens)} tokens
            {focus === hours.peakIndex
              ? ` · busiest hour, ${Math.round(hours.peakShare * 100)}% of the window`
              : ""}
          </>
        ) : (
          "No tokens recorded in this window"
        )}
      </div>

      <div
        className="mt-2 flex h-14 items-end gap-[2px]"
        onMouseLeave={() => setHovered(null)}
        role="img"
        aria-label={`Tokens by hour of day, ${hours.zoneLabel}`}
      >
        {hours.buckets.map((bucket, index) => {
          const share = hours.maxTokens > 0 ? bucket.tokens / hours.maxTokens : 0;
          const isFocus = index === focus;
          return (
            <div
              key={bucket.hour}
              className="flex h-full flex-1 items-end"
              onMouseEnter={() => setHovered(index)}
              title={`${bucket.label} ${hours.zoneLabel} (${String(bucket.utcHour).padStart(2, "0")}:00 UTC) · ${formatTokenCount(bucket.tokens)} tokens`}
            >
              <div
                className="w-full rounded-t-[3px]"
                style={{
                  height: bucket.tokens > 0 ? `${Math.max(share * 100, 5)}%` : "1px",
                  backgroundColor: bucket.tokens
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

      <div className="mt-1 flex text-[10px] tabular-nums text-muted-foreground">
        {hours.buckets.map((bucket) => (
          <span key={bucket.hour} className="flex-1 text-center">
            {AXIS_HOURS.has(bucket.hour) ? String(bucket.hour).padStart(2, "0") : ""}
          </span>
        ))}
      </div>

      <p className="mt-1.5 text-[10px] leading-snug text-muted-foreground">
        {hours.zone === "local"
          ? `Hours shown in your timezone (${hours.zoneLabel}), shifted from the server's UTC buckets.`
          : "Your timezone is offset from UTC by less than a whole hour, so these stay on UTC hours rather than split a bucket."}
      </p>
    </div>
  );
}

function UsageHoursTable({ hours }: { hours: HourOfDayView }) {
  return (
    <div className="max-h-44 overflow-y-auto" data-testid="collaboration-usage-hours-table">
      <table className="w-full text-[11px] tabular-nums">
        <thead className="sticky top-0 bg-popover text-left text-muted-foreground">
          <tr>
            <th className="py-1 font-normal">Hour ({hours.zoneLabel})</th>
            <th className="py-1 text-right font-normal">UTC</th>
            <th className="py-1 text-right font-normal">Tokens</th>
          </tr>
        </thead>
        <tbody>
          {hours.buckets.map((bucket) => (
            <tr key={bucket.hour} className="border-t border-border/60">
              <td className="py-1 text-foreground">{bucket.label}</td>
              <td className="py-1 text-right text-muted-foreground">
                {String(bucket.utcHour).padStart(2, "0")}:00
              </td>
              <td className="py-1 text-right text-foreground">{formatTokenCount(bucket.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
