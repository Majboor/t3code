import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The trail a workspace surface shows in its top bar.
 *
 * Adopted from upstream: a list, not a row of divs, so the crumbs are a
 * navigation landmark and the current page is announced as such.
 */
export function WorkspaceBreadcrumb({
  ariaLabel,
  children,
  className,
}: {
  readonly ariaLabel: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav aria-label={ariaLabel} className={cn("min-w-0", className)}>
      {/* Keep the flexible container draggable in Electron; interactive
          descendants opt out through the shared .drag-region rules. */}
      <ol className="m-0 flex min-w-0 list-none items-center gap-1.5 p-0 text-sm sm:gap-2">
        {children}
      </ol>
    </nav>
  );
}

export function WorkspaceBreadcrumbItem({
  children,
  className,
  current = false,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly current?: boolean;
}) {
  return (
    <li
      aria-current={current ? "page" : undefined}
      className={cn(
        "flex min-w-0 items-center font-medium",
        current ? "text-foreground" : "shrink-0 text-muted-foreground/70",
        className,
      )}
    >
      {children}
    </li>
  );
}

export function WorkspaceBreadcrumbSeparator({ className }: { readonly className?: string }) {
  return (
    <li
      aria-hidden="true"
      className={cn("flex shrink-0 items-center text-muted-foreground/40", className)}
    >
      /
    </li>
  );
}
