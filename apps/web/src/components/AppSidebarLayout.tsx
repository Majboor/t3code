import { useEffect, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PanelLeftOpenIcon, PanelRightOpenIcon } from "lucide-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useMediaQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { cn } from "../lib/utils";
import ThreadSidebar from "./Sidebar";
import { Sidebar, SidebarProvider, SidebarRail } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX,
  PROJECT_SIDEBAR_MIN_WIDTH_PX,
  PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
  useProjectSidebarOpen,
} from "./AppSidebarLayout.logic";

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const desktopLayoutMode = useSettings((settings) => settings.desktopLayoutMode);
  const keybindings = useServerKeybindings();
  const isMobile = useIsMobile();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeThreadRef = routeTarget?.kind === "server" ? routeTarget.threadRef : null;
  const terminalOpen = useTerminalStateStore((state) =>
    routeThreadRef
      ? selectThreadTerminalState(state.terminalStateByThreadKey, routeThreadRef).terminalOpen
      : false,
  );
  const projectSidebarSide = desktopLayoutMode === "dev" ? "right" : "left";
  const [projectSidebarOpen, setProjectSidebarOpen] = useProjectSidebarOpen(desktopLayoutMode);

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action !== "open-settings") return;
      void navigate({ to: "/settings" });
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (useCommandPaletteStore.getState().open) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
        },
      });
      if (command !== "projects.toggle") {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setProjectSidebarOpen((open) => !open);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [keybindings, setProjectSidebarOpen, terminalOpen]);

  const projectSidebar = (
    <Sidebar
      side={projectSidebarSide}
      collapsible="offcanvas"
      className={cn(
        "bg-card text-foreground",
        projectSidebarSide === "right" ? "border-l border-border" : "border-r border-border",
      )}
      data-layout-column="projects"
      resizable={{
        minWidth: PROJECT_SIDEBAR_MIN_WIDTH_PX,
        shouldAcceptWidth: ({ nextWidth, wrapper }) =>
          wrapper.clientWidth - nextWidth >= PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX,
        storageKey: PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
      }}
    >
      <ThreadSidebar />
      <SidebarRail />
    </Sidebar>
  );

  const reopenAffordanceVisible = !isMobile && !projectSidebarOpen;

  return (
    <SidebarProvider
      data-app-layout-mode={desktopLayoutMode}
      onOpenChange={setProjectSidebarOpen}
      open={projectSidebarOpen}
    >
      {desktopLayoutMode === "dev" ? children : projectSidebar}
      {desktopLayoutMode === "dev" ? projectSidebar : children}
      {reopenAffordanceVisible && (
        <ProjectSidebarReopenAffordance
          side={projectSidebarSide}
          onOpen={() => setProjectSidebarOpen(true)}
        />
      )}
    </SidebarProvider>
  );
}

function ProjectSidebarReopenAffordance({
  side,
  onOpen,
}: {
  side: "left" | "right";
  onOpen: () => void;
}) {
  const Icon = side === "left" ? PanelLeftOpenIcon : PanelRightOpenIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label="Open Projects sidebar"
            data-slot="project-sidebar-reopen"
            data-side={side}
            onClick={onOpen}
            className={cn(
              "pointer-events-auto fixed top-16 z-30 hidden h-9 w-6 items-center justify-center border border-border/60 bg-card/95 text-muted-foreground shadow-sm/10 transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring md:flex [-webkit-app-region:no-drag]",
              side === "left"
                ? "left-0 rounded-r-md border-l-0"
                : "right-0 rounded-l-md border-r-0",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        }
      />
      <TooltipPopup side={side === "left" ? "right" : "left"} align="center">
        Open Projects sidebar
      </TooltipPopup>
    </Tooltip>
  );
}
