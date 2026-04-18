import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { cn } from "~/lib/utils";

import { Skeleton } from "./ui/skeleton";

export type WorkspacePanelMode = "inline" | "sheet" | "sidebar";

function getWorkspacePanelHeaderRowClassName(mode: WorkspacePanelMode) {
  const shouldUseDragRegion = isElectron && mode !== "sheet";
  return cn(
    "flex items-center justify-between gap-2 px-4 wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
    shouldUseDragRegion
      ? "drag-region h-[52px] border-b border-border wco:h-[env(titlebar-area-height)]"
      : "h-12 wco:max-h-[env(titlebar-area-height)]",
  );
}

export function WorkspacePanelShell(props: {
  mode: WorkspacePanelMode;
  header: ReactNode;
  children: ReactNode;
}) {
  const shouldUseDragRegion = isElectron && props.mode !== "sheet";

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      {shouldUseDragRegion ? (
        <div className={getWorkspacePanelHeaderRowClassName(props.mode)}>{props.header}</div>
      ) : (
        <div className="border-b border-border">
          <div className={getWorkspacePanelHeaderRowClassName(props.mode)}>{props.header}</div>
        </div>
      )}
      {props.children}
    </div>
  );
}

export function WorkspacePanelLoadingState(props: { label: string }) {
  return (
    <div className="flex min-h-0 flex-1 p-2">
      <div
        className="grid min-h-0 flex-1 grid-cols-[15rem_minmax(0,1fr)] overflow-hidden rounded-md border border-border/60 bg-card/25"
        role="status"
        aria-live="polite"
        aria-label={props.label}
      >
        <div className="flex min-h-0 flex-col border-r border-border/50">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Skeleton className="h-4 w-20 rounded-full" />
            <div className="ml-auto flex gap-1">
              <Skeleton className="size-6 rounded-md" />
              <Skeleton className="size-6 rounded-md" />
              <Skeleton className="size-6 rounded-md" />
            </div>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 py-3">
            <Skeleton className="h-3 w-3/4 rounded-full" />
            <Skeleton className="h-3 w-5/6 rounded-full" />
            <Skeleton className="h-3 w-2/3 rounded-full" />
            <Skeleton className="h-3 w-4/5 rounded-full" />
          </div>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
            <Skeleton className="h-5 w-28 rounded-md" />
            <Skeleton className="h-5 w-24 rounded-md" />
            <Skeleton className="ml-auto h-6 w-16 rounded-md" />
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-3 py-4">
            <div className="space-y-2">
              <Skeleton className="h-3 w-full rounded-full" />
              <Skeleton className="h-3 w-full rounded-full" />
              <Skeleton className="h-3 w-10/12 rounded-full" />
              <Skeleton className="h-3 w-11/12 rounded-full" />
              <Skeleton className="h-3 w-9/12 rounded-full" />
            </div>
            <span className="sr-only">{props.label}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
