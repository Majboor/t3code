import type { CloudSyncConflict, CloudSyncConflictId } from "@t3tools/contracts";
import { FileWarningIcon } from "lucide-react";

import { Button } from "../ui/button";
import { CLOUD_SYNC_RESOLVE_HINT, describeConflict } from "./cloudSync.logic";

/**
 * The files where both sides changed, and where each version ended up.
 *
 * No "keep mine" and no "keep theirs". Both versions are already on disk by the
 * time a row appears here, and a button offering to choose between them would
 * be a delete with better manners — the one thing the whole feature exists to
 * prevent. Marking a row done clears it from the list and touches no file.
 */
export function CloudSyncConflicts({
  conflicts,
  hasMore,
  busy,
  onResolve,
}: {
  conflicts: readonly CloudSyncConflict[];
  hasMore: boolean;
  busy: boolean;
  onResolve: (conflictId: CloudSyncConflictId) => void;
}) {
  if (conflicts.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="cloud-sync-conflicts">
      <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
        <FileWarningIcon className="size-3.5 shrink-0 opacity-80" />
        Both sides changed these
      </div>
      <div className="text-[10px] text-muted-foreground">{CLOUD_SYNC_RESOLVE_HINT}</div>

      {conflicts.map((conflict) => {
        const copy = describeConflict(conflict);
        return (
          <div
            key={conflict.id}
            className="rounded-md border border-border p-2"
            data-testid="cloud-sync-conflict"
          >
            <div className="truncate text-xs font-medium text-foreground" title={copy.title}>
              {copy.title}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">{copy.explanation}</div>
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[10px] text-muted-foreground">
                Noticed {copy.detectedLabel}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onResolve(conflict.id)}
                data-testid="cloud-sync-conflict-resolve"
              >
                Mark done
              </Button>
            </div>
          </div>
        );
      })}

      {hasMore ? (
        <div className="text-[10px] text-muted-foreground">
          More conflicts are waiting than fit here. Clearing these will reveal the rest.
        </div>
      ) : null}
    </div>
  );
}
