import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";

import type { Pack } from "./packMode.logic";
import { formatPackSignals } from "./packMode.logic";
import { Button } from "../ui/button";

/**
 * A proposed pack, argued as correctness rather than effort: what it does, what
 * it already survived, and what the person still has to supply before any of it
 * runs. The last part is the honest half — a pack that needs three keys is not
 * a one-click install and saying so up front is cheaper than finding out later.
 */
export function PackSuggestionCard({
  pack,
  onIntegrate,
  onDismiss,
}: {
  pack: Pack;
  onIntegrate: () => void;
  onDismiss: () => void;
}) {
  return (
    <div
      className="rounded-md border border-border p-2.5"
      data-testid="pack-suggestion-card"
      data-pack-id={pack.id}
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0 truncate text-xs font-medium text-foreground">{pack.name}</div>
        <div className="shrink-0 text-[11px] text-muted-foreground">
          {pack.scope === "workspace" ? "Yours" : pack.version}
        </div>
      </div>

      <div className="mt-1 text-[11px] leading-4 text-muted-foreground">{pack.summary}</div>

      {pack.handles.length > 0 ? (
        <div className="mt-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <ShieldCheckIcon className="size-3 shrink-0 text-muted-foreground" />
            Already handles
          </div>
          <ul className="mt-1 grid gap-0.5">
            {pack.handles.map((failure) => (
              <li key={failure} className="text-[11px] leading-4 text-muted-foreground">
                — {failure}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {pack.requires.length > 0 ? (
        <div className="mt-2">
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-foreground">
            <KeyRoundIcon className="size-3 shrink-0 text-muted-foreground" />
            You would need to supply
          </div>
          <div className="mt-1 text-[11px] leading-4 text-muted-foreground">
            {pack.requires.join(", ")}
          </div>
        </div>
      ) : null}

      <div
        className="mt-2 border-t border-border pt-2 text-[11px] leading-4 text-muted-foreground"
        data-testid="pack-suggestion-signals"
      >
        {formatPackSignals(pack.signals)}
      </div>

      <div className="mt-2 flex items-center justify-end gap-1.5">
        <Button size="xs" variant="ghost" data-testid="pack-suggestion-dismiss" onClick={onDismiss}>
          Not this
        </Button>
        <Button size="xs" data-testid="pack-suggestion-integrate" onClick={onIntegrate}>
          Integrate
        </Button>
      </div>
    </div>
  );
}
