import type { ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

/**
 * The one top-bar geometry every workspace surface sits under.
 *
 * Shape taken from upstream's `WorkspacePageHeader`; the measurements are
 * ours. Desktop draws a fixed titlebar row that doubles as the window drag
 * region, the browser draws a padded row that grows with its contents — the
 * two used to be copied by hand into every surface, `wco:` incantations and
 * all, and had already drifted apart by a few pixels.
 */
export function WorkspacePageHeader({
  electron = false,
  reserveNativeControls = false,
  className,
  ...props
}: ComponentPropsWithoutRef<"header"> & {
  /** Draw the desktop titlebar row (fixed height, draggable) instead of the browser row. */
  readonly electron?: boolean;
  /** Keep the window-controls overlay from covering trailing content. */
  readonly reserveNativeControls?: boolean;
}) {
  return (
    <header
      className={cn(
        "px-3 sm:px-5",
        electron
          ? "drag-region flex h-[52px] shrink-0 items-center wco:h-[env(titlebar-area-height)]"
          : "py-2 sm:py-3",
        electron &&
          reserveNativeControls &&
          "wco:pr-[calc(100vw-env(titlebar-area-width)-env(titlebar-area-x)+1em)]",
        className,
      )}
      {...props}
    />
  );
}
