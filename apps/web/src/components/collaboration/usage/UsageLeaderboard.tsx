import { CollaborationAvatar } from "../CollaborationPeople";
import { cn } from "../../../lib/utils";
import {
  describeHiddenMembers,
  formatEstimatedCost,
  formatTokenCount,
  type LeaderboardRowView,
} from "./usageMetrics.logic";

/**
 * Who spent what, heaviest first. One series, so one hue: the bar is a length
 * comparison, and the number beside it carries the value regardless.
 */
export function UsageLeaderboard({
  rows,
  hiddenMemberCount,
}: {
  rows: readonly LeaderboardRowView[];
  hiddenMemberCount: number;
}) {
  const hidden = describeHiddenMembers(hiddenMemberCount);

  return (
    <div data-testid="collaboration-usage-leaderboard">
      {rows.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Nobody in this workspace has shared usage for this window.
        </p>
      ) : (
        <div className="grid gap-1.5">
          {rows.map((row) => (
            <div
              key={row.userId}
              className="flex items-center gap-2"
              data-testid="collaboration-usage-leaderboard-row"
              data-viewer={row.isViewer ? "true" : "false"}
            >
              <CollaborationAvatar member={row.member} size="xs" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span
                    className={cn(
                      "min-w-0 truncate text-[11px]",
                      row.isViewer ? "font-medium text-foreground" : "text-foreground",
                    )}
                    title={row.displayName}
                  >
                    {row.displayName}
                  </span>
                  {row.isViewer ? (
                    <span className="shrink-0 rounded-sm bg-muted px-1 text-[9px] font-medium text-muted-foreground">
                      You
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 h-1 w-full rounded-full bg-[var(--usage-grid)]">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(row.share * 100, row.tokens > 0 ? 3 : 0)}%`,
                      backgroundColor: row.isViewer
                        ? "var(--usage-accent)"
                        : "var(--usage-accent-soft)",
                    }}
                  />
                </div>
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[11px] tabular-nums text-foreground">
                  {formatTokenCount(row.tokens)}
                </div>
                <div className="text-[10px] tabular-nums text-muted-foreground">
                  est. {formatEstimatedCost(row.cost)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {hidden ? (
        <p
          className="mt-2 text-[10px] leading-snug text-muted-foreground"
          data-testid="collaboration-usage-hidden-members"
        >
          {hidden}
        </p>
      ) : null}
    </div>
  );
}
