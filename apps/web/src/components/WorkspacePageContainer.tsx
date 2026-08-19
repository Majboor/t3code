import type { ComponentPropsWithoutRef } from "react";

import { cn } from "~/lib/utils";

export type WorkspacePageWidth = "readable" | "wide" | "expanded";

const WIDTH_CLASS: Record<WorkspacePageWidth, string> = {
  readable: "max-w-2xl",
  wide: "max-w-3xl",
  expanded: "max-w-5xl",
};

/**
 * Shared content frame for workspace pages. Adopted from upstream's
 * `WorkspacePageContainer`, measured against our existing page widths rather
 * than theirs.
 */
export function WorkspacePageContainer({
  width = "readable",
  className,
  ...props
}: ComponentPropsWithoutRef<"div"> & { readonly width?: WorkspacePageWidth }) {
  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-col px-4 py-8 sm:px-6 sm:py-10",
        WIDTH_CLASS[width],
        className,
      )}
      {...props}
    />
  );
}
