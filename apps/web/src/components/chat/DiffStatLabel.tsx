import type { GitWorkingTreeFileStatus } from "@t3tools/contracts";
import { memo } from "react";

import { cn } from "~/lib/utils";

export function hasNonZeroStat(stat: { additions: number; deletions: number }): boolean {
  return stat.additions > 0 || stat.deletions > 0;
}

const FILE_STATUS_BADGE_CONFIG: Record<
  GitWorkingTreeFileStatus,
  { letter: string; label: string; className: string }
> = {
  modified: { letter: "M", label: "Modified", className: "text-primary/80" },
  added: { letter: "A", label: "Added", className: "text-success" },
  untracked: { letter: "U", label: "Untracked", className: "text-success/80" },
  deleted: { letter: "D", label: "Deleted", className: "text-destructive" },
  renamed: { letter: "R", label: "Renamed", className: "text-warning" },
};

export function fileStatusBadgeClassName(status: GitWorkingTreeFileStatus): string {
  return FILE_STATUS_BADGE_CONFIG[status].className;
}

export function fileStatusLabel(status: GitWorkingTreeFileStatus): string {
  return FILE_STATUS_BADGE_CONFIG[status].label;
}

export const FileStatusBadge = memo(function FileStatusBadge(props: {
  status: GitWorkingTreeFileStatus;
  className?: string;
}) {
  const config = FILE_STATUS_BADGE_CONFIG[props.status];
  return (
    <span
      className={cn(
        "shrink-0 font-mono text-[10px] uppercase tabular-nums",
        config.className,
        props.className,
      )}
      title={config.label}
      aria-label={config.label}
    >
      {config.letter}
    </span>
  );
});

export const DiffStatLabel = memo(function DiffStatLabel(props: {
  additions: number;
  deletions: number;
  showParentheses?: boolean;
}) {
  const { additions, deletions, showParentheses = false } = props;
  return (
    <>
      {showParentheses && <span className="text-muted-foreground/70">(</span>}
      <span className="text-success">+{additions}</span>
      <span className="mx-0.5 text-muted-foreground/70">/</span>
      <span className="text-destructive">-{deletions}</span>
      {showParentheses && <span className="text-muted-foreground/70">)</span>}
    </>
  );
});
