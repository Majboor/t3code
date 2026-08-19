import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * Connection phases this app renders a dot for. `disconnected` and anything
 * unrecognised fall through to the muted "we do not know" colour, which is a
 * different state from "connected but idle" and must stay distinguishable.
 */
export type ConnectionDotPhase = "connected" | "connecting" | "reconnecting" | "error" | string;

/** Canonical connection-phase → dot colour mapping shared by every status dot. */
export function connectionPhaseDotClassName(phase: ConnectionDotPhase): string {
  switch (phase) {
    case "connected":
      return "bg-success";
    case "connecting":
    case "reconnecting":
      return "bg-warning";
    case "error":
      return "bg-destructive";
    default:
      return "bg-muted-foreground/40";
  }
}

/** Ping halo for transitional phases; null renders no ping. */
export function connectionPhasePingClassName(phase: ConnectionDotPhase): string | null {
  return phase === "connecting" || phase === "reconnecting" ? "bg-warning/60 duration-2000" : null;
}

type ConnectionStatusDotProps = {
  tooltipText?: string | null;
  dotClassName: string;
  pingClassName?: string | null;
};

/**
 * A status dot with an optional ping halo. Without `tooltipText` it renders as
 * a plain decorative span, so callers that have no explanation to offer do not
 * get a focusable control with an empty tooltip.
 */
export function ConnectionStatusDot({
  tooltipText,
  dotClassName,
  pingClassName,
}: ConnectionStatusDotProps) {
  const dotContent = (
    <>
      {pingClassName ? (
        <span
          className={cn(
            "absolute inline-flex h-full w-full animate-ping rounded-full",
            pingClassName,
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex size-2 rounded-full", dotClassName)} />
    </>
  );

  if (!tooltipText) {
    return (
      <span className="relative flex size-3 shrink-0 items-center justify-center">
        {dotContent}
      </span>
    );
  }

  const dot = (
    <button
      aria-label={tooltipText}
      className="relative flex size-3 shrink-0 cursor-help items-center justify-center rounded-full outline-hidden"
      title={tooltipText}
      type="button"
    >
      {dotContent}
    </button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={dot} />
      <TooltipPopup className="max-w-80 whitespace-pre-wrap leading-tight" side="top">
        {tooltipText}
      </TooltipPopup>
    </Tooltip>
  );
}
