import { CheckIcon, LinkIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";

/**
 * One click on a file row: make a `file`-scoped link and put its URL on the
 * clipboard.
 *
 * There is no dialog because there is nothing to ask. The scope is decided by
 * where the button is, the target is the row it sits on, and the token can only
 * be copied in the same breath as it is minted — a dialog between those two
 * would be a dialog holding a live public URL.
 */
export function ShareFileLinkButton({
  relativePath,
  onCopyShareLink,
  className,
}: {
  relativePath: string;
  /** Mints and copies; resolves once the clipboard has it (or has refused it). */
  onCopyShareLink: (relativePath: string) => Promise<void>;
  className?: string;
}) {
  const [phase, setPhase] = useState<"idle" | "busy" | "done">("idle");

  return (
    <button
      type="button"
      aria-label={`Copy share link for ${relativePath}`}
      title="Copy share link"
      disabled={phase === "busy"}
      data-testid="share-file-link"
      data-path={relativePath}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/entry:opacity-100",
        phase !== "idle" && "opacity-100",
        className,
      )}
      onClick={(event) => {
        // The row underneath opens the file; sharing it is not opening it.
        event.stopPropagation();
        setPhase("busy");
        void onCopyShareLink(relativePath)
          .then(() => setPhase("done"))
          .catch(() => setPhase("idle"))
          .finally(() => {
            window.setTimeout(() => setPhase("idle"), 1500);
          });
      }}
    >
      {phase === "busy" ? (
        <LoaderCircleIcon className="size-3 animate-spin" />
      ) : phase === "done" ? (
        <CheckIcon className="size-3 text-primary" />
      ) : (
        <LinkIcon className="size-3" />
      )}
    </button>
  );
}
