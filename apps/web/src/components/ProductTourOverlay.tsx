import { memo, useEffect, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { XIcon } from "lucide-react";
import { Button } from "./ui/button";
import { useUpdateSettings } from "~/hooks/useSettings";
import { useProductTourStore } from "~/productTourStore";
import { PRODUCT_TOUR_STEPS } from "~/productTour";

/** How long a step waits for its anchor before giving up and moving on. */
const ANCHOR_WAIT_MS = 3_000;
const ANCHOR_POLL_MS = 100;
const SPOTLIGHT_PADDING = 6;

interface AnchorRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

function readRect(selector: string): AnchorRect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

/**
 * Renders the current step's spotlight + callout, drives step advancement,
 * and persists completion. Mounted once in `_chat.tsx` so it survives route
 * changes — a step can navigate (e.g. to Settings → Connections) without
 * unmounting the tour.
 *
 * A step whose anchor never appears (a feature this user hasn't unlocked —
 * no project, no git repo, nothing to share) is skipped after a short wait
 * rather than blocking the rest of the tour.
 */
export const ProductTourOverlay = memo(function ProductTourOverlay() {
  const active = useProductTourStore((state) => state.active);
  const stepIndex = useProductTourStore((state) => state.stepIndex);
  const next = useProductTourStore((state) => state.next);
  const back = useProductTourStore((state) => state.back);
  const stop = useProductTourStore((state) => state.stop);
  const { updateSettings } = useUpdateSettings();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });

  const step = PRODUCT_TOUR_STEPS[stepIndex];
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const [skipping, setSkipping] = useState(false);

  const finish = () => {
    updateSettings({ hasSeenProductTour: true });
    stop();
  };

  // Navigate to the step's route once, if we're not already there.
  useEffect(() => {
    if (!active || !step?.route) return;
    if (pathname !== step.route) {
      void navigate({ to: step.route as "/settings/connections" });
    }
    // Only re-run when the step (and so its route) changes — re-navigating on
    // every pathname tick would fight a person who clicks away mid-step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, step?.id]);

  // Poll for the anchor. Give up and skip after ANCHOR_WAIT_MS.
  useEffect(() => {
    if (!active || !step) {
      setRect(null);
      return;
    }
    setSkipping(false);
    let cancelled = false;
    const startedAt = Date.now();

    const tick = () => {
      if (cancelled) return;
      const found = readRect(step.selector);
      if (found) {
        setRect(found);
        return;
      }
      setRect(null);
      if (Date.now() - startedAt >= ANCHOR_WAIT_MS) {
        setSkipping(true);
        return;
      }
      window.setTimeout(tick, ANCHOR_POLL_MS);
    };
    tick();

    return () => {
      cancelled = true;
    };
  }, [active, step, pathname]);

  // Keep the spotlight glued to its anchor across scroll/resize.
  useEffect(() => {
    if (!active || !step || skipping) return;
    const onReposition = () => setRect(readRect(step.selector));
    window.addEventListener("scroll", onReposition, true);
    window.addEventListener("resize", onReposition);
    return () => {
      window.removeEventListener("scroll", onReposition, true);
      window.removeEventListener("resize", onReposition);
    };
  }, [active, step, skipping]);

  // A step that never found its anchor auto-advances (or ends the tour, on
  // the last step) once the wait above gives up.
  useEffect(() => {
    if (!skipping) return;
    if (stepIndex >= PRODUCT_TOUR_STEPS.length - 1) {
      finish();
      return;
    }
    next(PRODUCT_TOUR_STEPS.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipping]);

  if (!active || !step || skipping) {
    return null;
  }

  const isLast = stepIndex === PRODUCT_TOUR_STEPS.length - 1;
  const placement = step.placement ?? "bottom";

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]">
      {rect ? (
        <>
          <div
            className="pointer-events-none absolute rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background/80 transition-all duration-150"
            style={{
              top: rect.top - SPOTLIGHT_PADDING,
              left: rect.left - SPOTLIGHT_PADDING,
              width: rect.width + SPOTLIGHT_PADDING * 2,
              height: rect.height + SPOTLIGHT_PADDING * 2,
              boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.45)",
            }}
          />
          <TourCallout
            rect={rect}
            placement={placement}
            title={step.title}
            body={step.body}
            index={stepIndex}
            total={PRODUCT_TOUR_STEPS.length}
            isLast={isLast}
            onBack={stepIndex > 0 ? back : undefined}
            onNext={() => (isLast ? finish() : next(PRODUCT_TOUR_STEPS.length))}
            onSkip={finish}
          />
        </>
      ) : null}
    </div>
  );
});

function TourCallout({
  rect,
  placement,
  title,
  body,
  index,
  total,
  isLast,
  onBack,
  onNext,
  onSkip,
}: {
  readonly rect: AnchorRect;
  readonly placement: "top" | "bottom" | "left" | "right";
  readonly title: string;
  readonly body: string;
  readonly index: number;
  readonly total: number;
  readonly isLast: boolean;
  readonly onBack: (() => void) | undefined;
  readonly onNext: () => void;
  readonly onSkip: () => void;
}) {
  const calloutWidth = 320;
  const gap = 14;
  let top = rect.top + rect.height + gap;
  let left = rect.left + rect.width / 2 - calloutWidth / 2;

  if (placement === "top") {
    top = rect.top - gap;
  } else if (placement === "left") {
    top = rect.top + rect.height / 2 - 60;
    left = rect.left - calloutWidth - gap;
  } else if (placement === "right") {
    top = rect.top + rect.height / 2 - 60;
    left = rect.left + rect.width + gap;
  }

  // Clamp to viewport so a callout near an edge never renders off-screen.
  left = Math.min(Math.max(left, 12), window.innerWidth - calloutWidth - 12);
  const maxTop = window.innerHeight - 220;
  top = Math.min(Math.max(top, 12), Math.max(12, maxTop));

  return (
    <div
      className="pointer-events-auto absolute w-80 rounded-lg border bg-popover text-popover-foreground shadow-lg/5 before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)]"
      style={{ top, left, width: calloutWidth }}
      role="dialog"
      aria-modal="false"
      aria-label={title}
    >
      <div className="flex items-start justify-between gap-2 p-4 pb-2">
        <h3 className="text-sm font-semibold leading-tight text-foreground">{title}</h3>
        <button
          type="button"
          onClick={onSkip}
          aria-label="Skip tour"
          className="shrink-0 rounded-md p-0.5 text-muted-foreground/70 hover:bg-accent hover:text-foreground"
        >
          <XIcon className="size-3.5" />
        </button>
      </div>
      <p className="px-4 pb-3 text-xs text-muted-foreground">{body}</p>
      <div className="flex items-center justify-between gap-2 border-t px-4 py-2.5">
        <span className="text-[11px] text-muted-foreground/70">
          {index + 1} of {total}
        </span>
        <div className="flex items-center gap-1.5">
          {onBack ? (
            <Button size="xs" variant="ghost" onClick={onBack}>
              Back
            </Button>
          ) : null}
          <Button size="xs" variant="default" onClick={onNext}>
            {isLast ? "Finish" : "Next"}
          </Button>
        </div>
      </div>
    </div>
  );
}
