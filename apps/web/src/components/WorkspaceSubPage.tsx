import { ArrowLeftIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate, useCanGoBack } from "@tanstack/react-router";

import { isElectron } from "~/env";
import { Button } from "./ui/button";
import { SidebarInset, SidebarTrigger } from "./ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "./WorkspaceBreadcrumb";
import { WorkspacePageContainer, type WorkspacePageWidth } from "./WorkspacePageContainer";
import { WorkspacePageHeader } from "./WorkspacePageHeader";

/**
 * The frame for a workspace surface that is not a thread — analytics, infra, a
 * pack. Each of these had hand-rolled the same shell, and each had drifted:
 * none of them drew the desktop titlebar, so on the desktop app they were the
 * three pages you could not drag the window by.
 */
export function WorkspaceSubPage({
  title,
  width = "wide",
  contentClassName = "gap-4 py-4 sm:py-6",
  children,
}: {
  readonly title: string;
  readonly width?: WorkspacePageWidth;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="border-b border-border"
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Back"
              title="Back"
              className={isElectron ? "[-webkit-app-region:no-drag]" : undefined}
              onClick={() => {
                // Arriving here from a link or a reload leaves nothing to go
                // back to; the workspace is the honest destination.
                if (canGoBack) {
                  window.history.back();
                  return;
                }
                void navigate({ to: "/" });
              }}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <SidebarTrigger
              className={
                isElectron
                  ? "size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]"
                  : "size-7 shrink-0 md:hidden"
              }
            />
            <WorkspaceBreadcrumb ariaLabel={`${title} breadcrumb`}>
              <WorkspaceBreadcrumbItem current className="truncate">
                {title}
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </div>
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <WorkspacePageContainer width={width} className={contentClassName}>
            {children}
          </WorkspacePageContainer>
        </div>
      </div>
    </SidebarInset>
  );
}
