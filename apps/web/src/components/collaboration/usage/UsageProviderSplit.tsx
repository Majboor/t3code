import {
  formatEstimatedCost,
  formatTokenCount,
  type ProviderSplitView,
  type UsageProviderKey,
} from "./usageMetrics.logic";

/** Colour follows the runtime, never its rank, so re-ordering never repaints. */
const SLICE_COLOR: Record<UsageProviderKey, string> = {
  codex: "var(--usage-codex)",
  claudeAgent: "var(--usage-claude)",
  unrecorded: "var(--usage-unrecorded)",
};

/**
 * Which agent spent the tokens. A part-to-whole with three classes at most, so
 * one stacked bar rather than three, separated by a gap in the surface colour
 * rather than a stroke.
 */
export function UsageProviderSplit({ split }: { split: ProviderSplitView }) {
  if (split.slices.length === 0) {
    return <p className="text-[11px] text-muted-foreground">No tokens recorded in this window.</p>;
  }

  return (
    <div data-testid="collaboration-usage-providers">
      <div className="flex h-2 gap-[2px] overflow-hidden">
        {split.slices.map((slice) => (
          <div
            key={slice.key}
            className="h-full rounded-[2px]"
            style={{
              width: `${Math.max(slice.share * 100, 1.5)}%`,
              backgroundColor: SLICE_COLOR[slice.key],
            }}
            title={`${slice.label} · ${formatTokenCount(slice.tokens)} tokens`}
          />
        ))}
      </div>

      <div className="mt-2 grid gap-1">
        {split.slices.map((slice) => (
          <div
            key={slice.key}
            className="flex items-center gap-2 text-[11px]"
            data-testid="collaboration-usage-provider-row"
            data-provider={slice.key}
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-[2px]"
              style={{ backgroundColor: SLICE_COLOR[slice.key] }}
            />
            <span className="min-w-0 flex-1 truncate text-foreground">{slice.label}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {Math.round(slice.share * 100)}%
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums text-foreground">
              {formatTokenCount(slice.tokens)}
            </span>
            <span className="w-14 shrink-0 text-right tabular-nums text-muted-foreground">
              {slice.recorded ? formatEstimatedCost(slice.cost) : "—"}
            </span>
          </div>
        ))}
      </div>

      {split.unrecordedShare > 0 ? (
        <p
          className="mt-1.5 text-[10px] leading-snug text-muted-foreground"
          data-testid="collaboration-usage-unrecorded-note"
        >
          {Math.round(split.unrecordedShare * 100)}% of these tokens were reported before the server
          started recording which runtime ran the turn. They are counted, just not attributed.
        </p>
      ) : null}
    </div>
  );
}
