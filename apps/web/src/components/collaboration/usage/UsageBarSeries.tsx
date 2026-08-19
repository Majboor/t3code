import { cn } from "../../../lib/utils";

export interface UsageBar {
  /** Stable across renders, so a column is never re-keyed by its own value. */
  readonly key: string;
  readonly value: number;
  /** Native tooltip, because every bar's value has to be readable somehow. */
  readonly title?: string | undefined;
}

/**
 * A column series, and nothing else.
 *
 * The daily trend, the hour-of-day histogram and the preview sparkline in the
 * collaboration popover are the same drawing at three sizes, and they used to
 * be three copies of the same twenty lines — which is how a zero bar ends up
 * one pixel tall in one chart and invisible in another. The differences that
 * are real are props: how tall, how tight, and whether a column can take focus.
 *
 * A zero is drawn as a hairline in the grid colour rather than as nothing, so
 * "no tokens that day" and "no day here at all" stay different pictures.
 */
export function UsageBarSeries({
  ariaLabel,
  bars,
  barColor = "var(--usage-accent-soft)",
  className,
  focusIndex = null,
  gapClassName = "gap-px",
  minPercent = 4,
  onFocus,
  onLeave,
}: {
  ariaLabel: string;
  bars: readonly UsageBar[];
  /** Colour for every column that is not the focused one. */
  barColor?: string;
  /** Height, always: the caller owns the box this fills. */
  className: string;
  focusIndex?: number | null;
  gapClassName?: string;
  /** Floor for a non-zero column, so a small value is still a visible mark. */
  minPercent?: number;
  onFocus?: ((index: number) => void) | undefined;
  onLeave?: (() => void) | undefined;
}) {
  const max = bars.reduce((highest, bar) => Math.max(highest, bar.value), 0);

  return (
    <div
      className={cn("flex items-end", gapClassName, className)}
      onMouseLeave={onLeave}
      role="img"
      aria-label={ariaLabel}
      data-testid="usage-bar-series"
    >
      {bars.map((bar, index) => {
        const share = max > 0 ? bar.value / max : 0;
        const isFocus = index === focusIndex;
        return (
          <div
            key={bar.key}
            className="flex h-full flex-1 items-end"
            onMouseEnter={onFocus ? () => onFocus(index) : undefined}
            title={bar.title}
          >
            <div
              className={cn("w-full transition-colors", bar.value > 0 && "rounded-t-[3px]")}
              style={{
                height: bar.value > 0 ? `${Math.max(share * 100, minPercent)}%` : "1px",
                backgroundColor:
                  bar.value > 0
                    ? isFocus
                      ? "var(--usage-accent)"
                      : barColor
                    : "var(--usage-grid)",
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/**
 * The same series at preview size: no axis, no hover, one colour.
 *
 * At four bars to the centimetre there is nothing to compare a second hue
 * against, so the whole series takes the accent and the shape carries the
 * meaning. Anything a reader would want a number for is in the line of text
 * beside it.
 */
export function UsageSparkline({
  ariaLabel,
  bars,
  className,
}: {
  ariaLabel: string;
  bars: readonly UsageBar[];
  className?: string;
}) {
  return (
    <UsageBarSeries
      ariaLabel={ariaLabel}
      bars={bars}
      barColor="var(--usage-accent)"
      className={cn("h-6 w-16", className)}
      gapClassName="gap-[1px]"
      // Small enough not to lie about a quiet slice, tall enough to be a mark.
      minPercent={14}
    />
  );
}
