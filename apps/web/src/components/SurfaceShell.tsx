import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "./WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "./WorkspacePageContainer";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The frame the machine-connect pages share.
 *
 * `/environments` and `/download` are the same page at two different moments —
 * one lists the machines you have, the other gets you the app that becomes one
 * — and they are reached in the same two ways: from inside the app, where the
 * sidebar has to stay put, and by a browser that has not been let in yet, where
 * there is no sidebar to keep. Drawing that twice is how the two drift apart,
 * and a person who follows "Connect a machine" from one to the other should not
 * feel the page change underneath them.
 *
 * Extracted from `EnvironmentsSurface`, which was the only page with this
 * shape until there were two.
 */
export type SurfaceVariant = "page" | "standalone";

export function SurfaceHeading({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header>
      <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

export function SurfaceSection({
  title,
  description,
  children,
  ...rest
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: ReactNode;
  readonly "data-testid"?: string;
}) {
  return (
    <section
      className="overflow-hidden rounded-xl border border-border/80 bg-card/55"
      data-testid={rest["data-testid"]}
    >
      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

/**
 * Inside the shell the sidebar stays put, so the page is somewhere you went
 * rather than somewhere you were thrown; the way back is the sidebar's, not a
 * button stranded at the bottom. Standalone gets the gradient instead, because
 * it is the first thing a browser sees and there is nothing else on screen.
 */
export function SurfaceShell({
  variant,
  breadcrumbLabel,
  children,
}: {
  readonly variant: SurfaceVariant;
  readonly breadcrumbLabel: string;
  readonly children: ReactNode;
}) {
  if (variant === "page") {
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
          <WorkspacePageHeader
            electron={isElectron}
            reserveNativeControls
            className="border-b border-border"
          >
            <div className="flex w-full min-w-0 items-center gap-2">
              <SidebarTrigger
                className={
                  isElectron
                    ? "size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]"
                    : "size-7 shrink-0 md:hidden"
                }
              />
              <WorkspaceBreadcrumb ariaLabel={`${breadcrumbLabel} breadcrumb`}>
                <WorkspaceBreadcrumbItem current className="truncate">
                  {breadcrumbLabel}
                </WorkspaceBreadcrumbItem>
              </WorkspaceBreadcrumb>
            </div>
          </WorkspacePageHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <WorkspacePageContainer width="wide">{children}</WorkspacePageContainer>
          </div>
        </div>
      </SidebarInset>
    );
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background text-foreground">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--primary)_14%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <WorkspacePageContainer className="relative">{children}</WorkspacePageContainer>
    </div>
  );
}
