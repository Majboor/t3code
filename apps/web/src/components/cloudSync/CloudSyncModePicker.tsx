import type { CloudSyncMode } from "@t3tools/contracts";
import { CloudUploadIcon, RefreshCwIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { CLOUD_SYNC_MODE_CHOICES } from "./cloudSync.logic";

const MODE_ICONS = {
  handoff: CloudUploadIcon,
  mirror: RefreshCwIcon,
} as const;

/**
 * The one question, asked once, when a project is first shared.
 *
 * Both consequences are on screen before either button is reachable, at the
 * same weight as the summary they qualify. Neither mode is preselected: the two
 * answers differ in which copy becomes canonical, and a highlighted default is
 * an answer given on the person's behalf.
 */
export function CloudSyncModePicker({
  busy,
  onStart,
}: {
  busy: boolean;
  onStart: (mode: CloudSyncMode) => void;
}) {
  const [chosen, setChosen] = useState<CloudSyncMode | null>(null);

  return (
    <div className="flex flex-col gap-2" data-testid="cloud-sync-mode-picker">
      <div>
        <div className="text-xs font-medium text-foreground">Share this project to the cloud</div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          You are asked this once. Both keep every file you have — they differ in which copy the app
          treats as the real one.
        </div>
      </div>

      {CLOUD_SYNC_MODE_CHOICES.map((choice) => {
        const Icon = MODE_ICONS[choice.mode];
        const selected = chosen === choice.mode;
        return (
          <button
            key={choice.mode}
            type="button"
            aria-pressed={selected}
            onClick={() => setChosen(choice.mode)}
            data-testid="cloud-sync-mode-option"
            data-mode={choice.mode}
            className={cn(
              "rounded-md border p-2 text-left transition-colors",
              selected ? "border-primary bg-accent/40" : "border-border hover:bg-accent/20",
            )}
          >
            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <Icon className="size-3.5 shrink-0 opacity-80" />
              {choice.title}
            </div>
            <div className="mt-1 text-[10px] text-muted-foreground">{choice.summary}</div>
            {/* Never collapsed behind a disclosure. A consequence a person has to
                expand is a consequence they meet afterwards, by surprise. */}
            <div className="mt-1 text-[10px] font-medium text-amber-700 dark:text-amber-500">
              {choice.consequence}
            </div>
          </button>
        );
      })}

      <Button
        size="xs"
        variant="outline"
        disabled={chosen === null || busy}
        onClick={() => chosen && onStart(chosen)}
        data-testid="cloud-sync-start"
        className="self-start"
      >
        {chosen === null ? "Pick one to continue" : "Start syncing"}
      </Button>
    </div>
  );
}
