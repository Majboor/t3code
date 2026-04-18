import { FileDiff } from "@pierre/diffs/react";
import { useQuery } from "@tanstack/react-query";
import { type EnvironmentId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useSettings } from "~/hooks/useSettings";
import { checkpointDiffQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";

import { resolveDiffThemeName } from "../lib/diffRendering";
import { DIFF_VIEWER_UNSAFE_CSS, getRenderablePatch, resolveFileDiffPath } from "../lib/patchDiff";
import { type WorkspaceAgentFileDiff } from "../lib/workspaceAgentDiffs";
import { Button } from "./ui/button";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";

type DiffThemeType = "light" | "dark";

interface WorkspaceAgentDiffPreviewProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  filePath: string;
  fileHistory: ReadonlyArray<WorkspaceAgentFileDiff>;
  resolvedTheme: "light" | "dark";
  onOpenFullDiff: (turnId: TurnId, filePath: string) => void;
}

export function WorkspaceAgentDiffPreview(props: WorkspaceAgentDiffPreviewProps) {
  const { environmentId, fileHistory, filePath, onOpenFullDiff, resolvedTheme, threadId } = props;
  const settings = useSettings();
  const [selectedTurnId, setSelectedTurnId] = useState<TurnId | null>(
    () => fileHistory[0]?.turnId ?? null,
  );

  useEffect(() => {
    if (fileHistory.length === 0) {
      setSelectedTurnId(null);
      return;
    }

    const selectedStillExists = fileHistory.some((entry) => entry.turnId === selectedTurnId);
    if (!selectedStillExists) {
      setSelectedTurnId(fileHistory[0]?.turnId ?? null);
    }
  }, [fileHistory, selectedTurnId]);

  const selectedHistoryEntry =
    (selectedTurnId ? fileHistory.find((entry) => entry.turnId === selectedTurnId) : undefined) ??
    fileHistory[0] ??
    null;
  const checkpointRange = useMemo(() => {
    if (typeof selectedHistoryEntry?.checkpointTurnCount !== "number") {
      return null;
    }
    return {
      fromTurnCount: Math.max(0, selectedHistoryEntry.checkpointTurnCount - 1),
      toTurnCount: selectedHistoryEntry.checkpointTurnCount,
    };
  }, [selectedHistoryEntry?.checkpointTurnCount]);

  const activeDiffQuery = useQuery(
    checkpointDiffQueryOptions({
      environmentId,
      threadId,
      fromTurnCount: checkpointRange?.fromTurnCount ?? null,
      toTurnCount: checkpointRange?.toTurnCount ?? null,
      cacheScope: selectedHistoryEntry
        ? `workspace-file:${filePath}:${selectedHistoryEntry.turnId}`
        : null,
      enabled: selectedHistoryEntry !== null && checkpointRange !== null,
    }),
  );
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(
        activeDiffQuery.data?.diff,
        selectedHistoryEntry
          ? `workspace-file:${selectedHistoryEntry.turnId}:${resolvedTheme}`
          : "workspace-file",
      ),
    [activeDiffQuery.data?.diff, resolvedTheme, selectedHistoryEntry],
  );
  const renderableFile = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return null;
    }
    return (
      renderablePatch.files.find((fileDiff) => resolveFileDiffPath(fileDiff) === filePath) ?? null
    );
  }, [filePath, renderablePatch]);
  const diffError =
    activeDiffQuery.error instanceof Error
      ? activeDiffQuery.error.message
      : activeDiffQuery.error
        ? "Failed to load agent diff preview."
        : null;

  if (!selectedHistoryEntry) {
    return null;
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border/60 bg-card/20">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="min-w-0">
          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            Agent diff
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground/80">
            <span className="truncate">
              {fileHistory.length} turn{fileHistory.length === 1 ? "" : "s"}
            </span>
            {hasNonZeroStat(selectedHistoryEntry.stat) ? (
              <span className="font-mono tabular-nums">
                <DiffStatLabel
                  additions={selectedHistoryEntry.stat.additions}
                  deletions={selectedHistoryEntry.stat.deletions}
                />
              </span>
            ) : (
              <span>Changed</span>
            )}
          </div>
        </div>
        <Button
          type="button"
          size="xs"
          variant="outline"
          onClick={() => onOpenFullDiff(selectedHistoryEntry.turnId, filePath)}
        >
          <ExternalLinkIcon className="size-3" />
          Full diff
        </Button>
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-border/50 px-3 py-2">
        {fileHistory.map((entry) => {
          const selected = entry.turnId === selectedHistoryEntry.turnId;
          return (
            <button
              key={entry.turnId}
              type="button"
              className={cn(
                "shrink-0 rounded-md border px-2 py-1 text-left transition-colors",
                selected
                  ? "border-border bg-accent text-accent-foreground"
                  : "border-border/70 bg-background/70 text-muted-foreground/80 hover:border-border hover:text-foreground/85",
              )}
              onClick={() => setSelectedTurnId(entry.turnId)}
            >
              <div className="text-[10px] font-medium leading-tight">
                Turn {entry.checkpointTurnCount ?? "?"}
              </div>
              <div className="mt-0.5 flex items-center gap-1 text-[9px] leading-tight opacity-75">
                <span>{formatShortTimestamp(entry.completedAt, settings.timestampFormat)}</span>
                {hasNonZeroStat(entry.stat) ? (
                  <span className="font-mono tabular-nums">
                    <DiffStatLabel
                      additions={entry.stat.additions}
                      deletions={entry.stat.deletions}
                    />
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>

      <div className="max-h-[18rem] min-h-[12rem] overflow-auto bg-background/70 p-2">
        {diffError && !renderablePatch ? (
          <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive/80">
            {diffError}
          </div>
        ) : activeDiffQuery.isLoading && !renderablePatch ? (
          <div className="flex h-full min-h-[10rem] items-center justify-center text-xs text-muted-foreground/70">
            Loading agent diff preview...
          </div>
        ) : renderableFile ? (
          <div className="overflow-hidden rounded-md border border-border/60 bg-card">
            <FileDiff
              fileDiff={renderableFile}
              options={{
                diffStyle: "unified",
                lineDiffType: "none",
                overflow: settings.diffWordWrap ? "wrap" : "scroll",
                theme: resolveDiffThemeName(resolvedTheme),
                themeType: resolvedTheme as DiffThemeType,
                unsafeCSS: DIFF_VIEWER_UNSAFE_CSS,
              }}
            />
          </div>
        ) : renderablePatch?.kind === "raw" ? (
          <div className="space-y-2">
            <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
            <pre
              className={cn(
                "rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                settings.diffWordWrap
                  ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                  : "overflow-auto",
              )}
            >
              {renderablePatch.text}
            </pre>
          </div>
        ) : (
          <div className="flex h-full min-h-[10rem] items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
            No file-specific patch is available for this turn.
          </div>
        )}
      </div>
    </div>
  );
}
