import { PauseIcon, PlayIcon, SquareIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  cloudSyncModeLabel,
  describeActivelyChanging,
  describeCloudSyncFailure,
  describeCloudSyncHeadline,
  describeCloudSyncProgress,
  describeConflictCount,
  describeLastAgreement,
  type CloudSyncTone,
} from "./cloudSync.logic";
import { CloudSyncConflicts } from "./CloudSyncConflicts";
import { CloudSyncModePicker } from "./CloudSyncModePicker";
import type { CloudSyncState } from "./useCloudSync";

const TONE_BADGE = {
  idle: "secondary",
  busy: "info",
  paused: "warning",
  error: "error",
} as const satisfies Record<CloudSyncTone, string>;

/**
 * Everything a person wants to know about one project's sync, in one place.
 *
 * The order is deliberate: what it is doing, how far through this pass it is,
 * why it might not be finishing, when the two sides last actually agreed, and
 * only then the files that need a human. The last-agreement line is the one
 * that answers "is my work safe?", so it is never the thing that gets cut when
 * the panel is short of room.
 */
export function CloudSyncPanel({ state }: { state: CloudSyncState }) {
  const { sync, loaded, readError, busy } = state;

  if (readError) {
    const notice = describeCloudSyncFailure(readError, {
      fallbackTitle: "Could not read this project's sync",
    });
    return (
      <div className="flex flex-col gap-1" data-testid="cloud-sync-read-error">
        <div className="text-xs font-medium text-foreground">{notice.title}</div>
        <div className="text-[10px] text-muted-foreground">{notice.description}</div>
      </div>
    );
  }

  if (!loaded) {
    return <div className="text-[10px] text-muted-foreground">Checking…</div>;
  }

  if (!sync) {
    return <CloudSyncModePicker busy={busy} onStart={(mode) => void state.start(mode)} />;
  }

  const headline = describeCloudSyncHeadline(sync);
  const progress = describeCloudSyncProgress(sync);
  const changing = describeActivelyChanging(sync);
  const conflictCount = describeConflictCount(sync.conflictCount);
  const { wait } = state;

  return (
    <div className="flex flex-col gap-2.5" data-testid="cloud-sync-panel">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge size="sm" variant={TONE_BADGE[headline.tone]} data-testid="cloud-sync-status">
          {headline.label}
        </Badge>
        <Badge size="sm" variant="outline">
          {cloudSyncModeLabel(sync.mode)}
        </Badge>
        {conflictCount ? (
          <Badge size="sm" variant="warning" data-testid="cloud-sync-conflict-count">
            {conflictCount}
          </Badge>
        ) : null}
      </div>

      <div className="text-[10px] text-muted-foreground">{headline.detail}</div>

      {/* The message the server gave, kept apart from our reassurance about it —
          a person retrying needs to read the actual reason. */}
      {sync.lastError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/8 p-2 text-[10px] text-destructive-foreground"
          data-testid="cloud-sync-last-error"
        >
          {sync.lastError}
        </div>
      ) : null}

      {progress.percent === null ? null : (
        <div data-testid="cloud-sync-progress">
          <div className="h-1 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                "h-full rounded-full transition-[width]",
                headline.tone === "error" ? "bg-destructive" : "bg-primary",
              )}
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{progress.filesLabel}</span>
            <span>{progress.bytesLabel}</span>
          </div>
          <div className="text-[10px] text-muted-foreground/80">This pass only.</div>
        </div>
      )}

      {changing ? (
        <div
          className="rounded-md border border-border bg-muted/30 p-2 text-[10px] text-muted-foreground"
          data-testid="cloud-sync-actively-changing"
        >
          {changing}
        </div>
      ) : null}

      <div className="text-[10px] text-muted-foreground" data-testid="cloud-sync-last-agreed">
        {describeLastAgreement(sync.lastAgreedAt)}
      </div>

      {wait.blocked ? (
        <div
          className="rounded-md border border-amber-500/40 bg-amber-500/8 p-2"
          data-testid="cloud-sync-wait"
          data-wait-kind={wait.kind}
        >
          <div className="text-[10px] font-medium text-foreground">{wait.title}</div>
          <div className="mt-0.5 text-[10px] text-muted-foreground">{wait.detail}</div>
          {wait.liveCopyUrl ? (
            <a
              href={wait.liveCopyUrl}
              rel="noreferrer"
              className="mt-1 inline-block text-[10px] font-medium underline underline-offset-2"
              data-testid="cloud-sync-live-copy"
            >
              Open the live copy instead
            </a>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5">
        {sync.status === "paused" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            // Resuming is `start` with the mode already running: anything else
            // would be a mode change, which the server refuses mid-flight.
            onClick={() => void state.start(sync.mode)}
            data-testid="cloud-sync-resume"
          >
            <PlayIcon className="size-3.5" />
            Resume
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy || sync.status === "error"}
            onClick={() => void state.pause()}
            data-testid="cloud-sync-pause"
          >
            <PauseIcon className="size-3.5" />
            Pause
          </Button>
        )}
        <Button
          size="xs"
          variant="outline"
          disabled={busy}
          onClick={() => void state.stop()}
          data-testid="cloud-sync-stop"
        >
          <SquareIcon className="size-3.5" />
          Stop
        </Button>
      </div>
      <div className="text-[10px] text-muted-foreground">
        {sync.mode === "mirror"
          ? "Stopping leaves both copies exactly as they are; they start drifting apart from that moment. Switching to handoff means stopping first."
          : "Stopping leaves both copies exactly as they are. Switching to a mirror means stopping first."}
      </div>

      <CloudSyncConflicts
        conflicts={state.conflicts}
        hasMore={state.hasMoreConflicts}
        busy={busy}
        onResolve={(conflictId) => void state.resolveConflict(conflictId)}
      />
    </div>
  );
}
