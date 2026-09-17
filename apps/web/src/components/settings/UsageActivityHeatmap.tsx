import { useMemo } from "react";
import type { GatewayDailyActivity } from "../../environments/primary";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildHeatmapCells } from "./usageActivity.logic";

const LEVEL_CLASS: Readonly<Record<0 | 1 | 2 | 3 | 4, string>> = {
  0: "bg-border/60",
  1: "bg-[var(--usage-accent-soft)]/40",
  2: "bg-[var(--usage-accent-soft)]",
  3: "bg-[var(--usage-accent)]/80",
  4: "bg-[var(--usage-accent)]",
};

/**
 * A GitHub-contributions-style calendar: one column per week, one cell per
 * day, shaded by request count (real historical data, not a current limit —
 * showing actual numbers here is fine, the "no raw counts" rule is about the
 * monthly/session limit bars, not this).
 */
export function UsageActivityHeatmap({ daily }: { daily: ReadonlyArray<GatewayDailyActivity> }) {
  const cells = useMemo(() => buildHeatmapCells(daily), [daily]);
  const weeks = useMemo(() => {
    const out: (typeof cells)[] = [];
    for (let i = 0; i < cells.length; i += 7) out.push(cells.slice(i, i + 7));
    return out;
  }, [cells]);

  return (
    <div className="[--usage-accent:#2a78d6] [--usage-accent-soft:#86b6ef] dark:[--usage-accent:#3987e5] dark:[--usage-accent-soft:#184f95]">
      <div className="flex gap-[3px] overflow-x-auto pb-1">
        {weeks.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col gap-[3px]">
            {week.map((cell) => (
              <Tooltip key={cell.day}>
                <TooltipTrigger
                  render={
                    <div
                      className={`size-[10px] rounded-[2px] ${LEVEL_CLASS[cell.level]}`}
                      aria-label={`${cell.day}: ${cell.requests} requests`}
                    />
                  }
                />
                <TooltipPopup side="top">
                  {cell.requests} request{cell.requests === 1 ? "" : "s"} on {cell.day}
                </TooltipPopup>
              </Tooltip>
            ))}
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>Less</span>
        {([0, 1, 2, 3, 4] as const).map((level) => (
          <div key={level} className={`size-[10px] rounded-[2px] ${LEVEL_CLASS[level]}`} />
        ))}
        <span>More</span>
      </div>
    </div>
  );
}
