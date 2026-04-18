import { FileDiff } from "@pierre/diffs/react";
import { type EnvironmentId, type ThreadId, type TurnId } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useMemo } from "react";

import { useSettings } from "~/hooks/useSettings";
import { useWorkspaceAgentTurnDiff } from "~/hooks/useWorkspaceAgentTurnDiff";
import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "~/timestampFormat";
import { basenameOfPath } from "~/vscode-icons";

import { resolveDiffThemeName } from "../lib/diffRendering";
import { DIFF_VIEWER_UNSAFE_CSS } from "../lib/patchDiff";
import { type WorkspaceAgentFileDiff } from "../lib/workspaceAgentDiffs";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { Button } from "./ui/button";
import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";

type DiffThemeType = "light" | "dark";

interface WorkspaceAgentDiffPreviewProps {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  filePath: string;
  fileHistory: ReadonlyArray<WorkspaceAgentFileDiff>;
  turnFilesByTurnId: ReadonlyMap<TurnId, ReadonlyArray<WorkspaceAgentFileDiff>>;
  selectedTurnId: TurnId | null;
  resolvedTheme: "light" | "dark";
  onSelectTurnId: (turnId: TurnId) => void;
  onOpenFile: (filePath: string) => void;
  onOpenFullDiff: (turnId: TurnId, filePath: string) => void;
}

export function WorkspaceAgentDiffPreview(props: WorkspaceAgentDiffPreviewProps) {
  const {
    environmentId,
    fileHistory,
    filePath,
    onOpenFile,
    onOpenFullDiff,
    onSelectTurnId,
    resolvedTheme,
    selectedTurnId,
    threadId,
    turnFilesByTurnId,
  } = props;
  const settings = useSettings();

  const selectedHistoryEntry =
    (selectedTurnId ? fileHistory.find((entry) => entry.turnId === selectedTurnId) : undefined) ??
    fileHistory[0] ??
    null;
  const selectedTurnFiles = useMemo(
    () =>
      (selectedHistoryEntry ? turnFilesByTurnId.get(selectedHistoryEntry.turnId) : undefined) ??
      (selectedHistoryEntry ? [selectedHistoryEntry] : []),
    [selectedHistoryEntry, turnFilesByTurnId],
  );
  const selectedPreviewFilePath = useMemo(() => {
    if (selectedTurnFiles.some((entry) => entry.path === filePath)) {
      return filePath;
    }
    return selectedTurnFiles[0]?.path ?? filePath;
  }, [filePath, selectedTurnFiles]);
  const selectedTurnStat = useMemo(
    () =>
      selectedTurnFiles.reduce(
        (totals, entry) => ({
          additions: totals.additions + entry.stat.additions,
          deletions: totals.deletions + entry.stat.deletions,
        }),
        { additions: 0, deletions: 0 },
      ),
    [selectedTurnFiles],
  );
  const { activeDiffQuery, diffError, renderableFile, renderablePatch } = useWorkspaceAgentTurnDiff(
    {
      environmentId,
      threadId,
      selectedHistoryEntry,
      targetFilePath: selectedPreviewFilePath,
      resolvedTheme,
      cacheScope: "workspace-preview",
    },
  );

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
            <span className="truncate">
              {selectedTurnFiles.length} file{selectedTurnFiles.length === 1 ? "" : "s"} in turn
            </span>
            {hasNonZeroStat(selectedTurnStat) ? (
              <span className="font-mono tabular-nums">
                <DiffStatLabel
                  additions={selectedTurnStat.additions}
                  deletions={selectedTurnStat.deletions}
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
          onClick={() => onOpenFullDiff(selectedHistoryEntry.turnId, selectedPreviewFilePath)}
        >
          <ExternalLinkIcon className="size-3" />
          Review turn
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
              onClick={() => onSelectTurnId(entry.turnId)}
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

      <div className="grid max-h-[18rem] min-h-[12rem] grid-cols-[15rem_minmax(0,1fr)] overflow-hidden bg-background/70">
        <div className="min-h-0 overflow-auto border-r border-border/50 bg-card/20">
          <div className="border-b border-border/50 px-3 py-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
            Changed files
          </div>
          <div className="space-y-1 p-2">
            {selectedTurnFiles.map((entry) => {
              const selected = entry.path === selectedPreviewFilePath;
              const fileName = basenameOfPath(entry.path);
              const showFullPath = fileName !== entry.path;
              return (
                <button
                  key={`${entry.turnId}:${entry.path}`}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border px-2 py-1.5 text-left transition-colors",
                    selected
                      ? "border-border bg-accent text-accent-foreground"
                      : "border-border/60 bg-background/60 text-muted-foreground/80 hover:border-border hover:text-foreground/85",
                  )}
                  aria-label={`Show agent diff for ${entry.path}`}
                  title={entry.path}
                  onClick={() => onOpenFile(entry.path)}
                >
                  <VscodeEntryIcon
                    pathValue={entry.path}
                    kind="file"
                    theme={resolvedTheme}
                    className="mt-0.5 size-3.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "truncate text-[11px] font-medium",
                        selected ? "text-accent-foreground" : "text-foreground",
                      )}
                    >
                      {fileName}
                    </div>
                    {showFullPath ? (
                      <div
                        className={cn(
                          "truncate text-[10px]",
                          selected ? "text-accent-foreground/75" : "text-muted-foreground/70",
                        )}
                      >
                        {entry.path}
                      </div>
                    ) : null}
                  </div>
                  <div
                    className={cn(
                      "shrink-0 font-mono text-[10px] tabular-nums",
                      selected ? "text-accent-foreground/80" : "text-muted-foreground/80",
                    )}
                  >
                    {hasNonZeroStat(entry.stat) ? (
                      <DiffStatLabel
                        additions={entry.stat.additions}
                        deletions={entry.stat.deletions}
                      />
                    ) : (
                      "changed"
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div className="min-h-0 overflow-auto p-2">
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
    </div>
  );
}
