import { GlobeIcon, LockIcon } from "lucide-react";
import type {
  PackRelease,
  PackScarRecord,
  PackVisibility,
  PackVisibilityScope,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  PACK_VISIBILITY_CHOICES,
  PACK_VISIBILITY_DESCRIPTIONS,
  describePublication,
  describeVisibilityChange,
} from "./packDetail.logic";
import { cn } from "../../lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Publishing is a second act, not a consequence of deploying. Deploying always
 * produces a pack; who may see it is decided here, deliberately, and the
 * default stays workspace-private — a scar record means nothing if every
 * abandoned first attempt is sitting next to it in the marketplace.
 */
export function PackPublishControl({
  visibility,
  record,
  release,
  onChangeVisibility,
}: {
  visibility: PackVisibility;
  record: PackScarRecord;
  /** The release being read, so the copy can name the moment it is about. */
  release: PackRelease | undefined;
  onChangeVisibility: (scope: PackVisibilityScope) => Promise<void>;
}) {
  const current = visibility.scope;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<PackVisibilityScope>(current);
  const [busy, setBusy] = useState(false);

  const description = describeVisibilityChange(current, target, record, release);
  const publication = describePublication(release);
  const isPrivate = current === "workspace";

  return (
    <>
      <div
        className="rounded-lg border border-border p-4"
        data-testid="pack-detail-visibility"
        data-scope={current}
      >
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              {isPrivate ? (
                <LockIcon className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="text-sm font-medium text-foreground">
                {PACK_VISIBILITY_DESCRIPTIONS[current].label}
              </span>
            </div>
            <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {PACK_VISIBILITY_DESCRIPTIONS[current].detail}
            </div>
            <div
              className="mt-0.5 text-[11px] leading-4 text-muted-foreground"
              data-testid="pack-detail-visibility-since"
            >
              {publication.line}
              {publication.narrowed === null ? "" : ` ${publication.narrowed}`}
            </div>
          </div>

          <Button
            size="sm"
            variant="outline"
            data-testid="pack-detail-visibility-change"
            onClick={() => {
              setTarget(current);
              setOpen(true);
            }}
          >
            Change who can see it
          </Button>
        </div>
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup data-testid="pack-detail-visibility-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{description.title}</AlertDialogTitle>
          </AlertDialogHeader>

          <div className="grid gap-2 px-6 pb-4">
            <div className="grid gap-1" data-testid="pack-detail-visibility-choices">
              {PACK_VISIBILITY_CHOICES.map((scope) => (
                <button
                  key={scope}
                  type="button"
                  aria-pressed={scope === target}
                  data-testid="pack-detail-visibility-choice"
                  data-scope={scope}
                  className={cn(
                    "rounded-md border px-3 py-2 text-left transition-colors",
                    scope === target
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-accent/40",
                  )}
                  onClick={() => setTarget(scope)}
                >
                  <div className="text-xs font-medium text-foreground">
                    {PACK_VISIBILITY_DESCRIPTIONS[scope].label}
                    {scope === current ? " — where it is now" : ""}
                  </div>
                  <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground">
                    {PACK_VISIBILITY_DESCRIPTIONS[scope].detail}
                  </div>
                </button>
              ))}
            </div>

            {target === current ? null : (
              <div
                className="rounded-md border border-border p-3"
                data-testid="pack-detail-visibility-consequence"
              >
                {description.sinceLine === null ? null : (
                  <div
                    className="mb-2 text-xs leading-5 text-muted-foreground"
                    data-testid="pack-detail-visibility-since-line"
                  >
                    {description.sinceLine}
                  </div>
                )}
                <div className="text-xs leading-5 text-foreground">{description.consequence}</div>
                {description.warning === null ? null : (
                  <div
                    className="mt-2 text-xs leading-5 text-destructive-foreground"
                    data-testid="pack-detail-visibility-warning"
                  >
                    {description.warning}
                  </div>
                )}
              </div>
            )}
          </div>

          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={busy || target === current}
              data-testid="pack-detail-visibility-confirm"
              variant={description.widening ? "default" : "outline"}
              onClick={() => {
                setBusy(true);
                onChangeVisibility(target)
                  .then(() => {
                    setOpen(false);
                    toastManager.add({
                      type: "success",
                      title: `Now ${PACK_VISIBILITY_DESCRIPTIONS[target].label.toLowerCase()}`,
                      description: PACK_VISIBILITY_DESCRIPTIONS[target].detail,
                    });
                  })
                  .catch((error: unknown) => {
                    toastManager.add({
                      type: "error",
                      title: "Could not change who can see it",
                      description: error instanceof Error ? error.message : "The request failed.",
                    });
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              {description.confirmLabel}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
