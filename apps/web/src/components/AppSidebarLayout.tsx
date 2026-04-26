import { useEffect, useEffectEvent, type ReactNode } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import {
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PanelRightCloseIcon,
  PanelRightOpenIcon,
} from "lucide-react";

import { useCommandPaletteStore } from "../commandPaletteStore";
import { resolveDesktopLayoutModeDefinition } from "../desktopLayoutModes";
import { useSettings } from "../hooks/useSettings";
import { useIsMobile } from "../hooks/useMediaQuery";
import { isTerminalFocused } from "../lib/terminalFocus";
import { resolveShortcutCommand, shortcutLabelForCommand } from "../keybindings";
import { useServerKeybindings } from "../rpc/serverState";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import { resolveThreadRouteTarget } from "../threadRoutes";
import { cn } from "../lib/utils";
import ThreadSidebar from "./Sidebar";
import {
  cancelActiveSidebarResizeInteractions,
  Sidebar,
  SidebarProvider,
  SidebarRail,
} from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import {
  PROJECT_SIDEBAR_DEFAULT_WIDTH_PX,
  PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX,
  PROJECT_SIDEBAR_MIN_WIDTH_PX,
  PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
  getMinimumDevMainContentWidthPx,
  rebalanceDevWorkspaceWidthBeforeProjectsOpen,
  useProjectSidebarOpen,
} from "./AppSidebarLayout.logic";
import { getLocalStorageItem, setLocalStorageItem } from "~/hooks/useLocalStorage";
import { Schema } from "effect";

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const desktopLayoutMode = useSettings((settings) => settings.desktopLayoutMode);
  const desktopLayoutDefinition = useSettings((settings) =>
    resolveDesktopLayoutModeDefinition(settings),
  );
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
  const projectSidebarSide = desktopLayoutDefinition.layout === "dev" ? "right" : "left";
  const [projectSidebarOpen, setProjectSidebarOpen] = useProjectSidebarOpen(desktopLayoutMode);
  const projectSidebarMainContentMinWidth =
    desktopLayoutDefinition.layout === "dev"
      ? getMinimumDevMainContentWidthPx(terminalOpen)
      : PROJECT_SIDEBAR_MAIN_CONTENT_MIN_WIDTH_PX;
  const projectsToggleShortcutLabel = shortcutLabelForCommand(keybindings, "projects.toggle", {
    context: {
      terminalFocus: false,
      terminalOpen,
    },
  });

  const toggleProjectSidebar = useEffectEvent(
    (nextOpen: boolean | ((open: boolean) => boolean)) => {
      cancelActiveSidebarResizeInteractions();
      setProjectSidebarOpen((previousOpen) => {
        const requestedOpen = typeof nextOpen === "function" ? nextOpen(previousOpen) : nextOpen;
        if (requestedOpen === previousOpen) {
          return previousOpen;
        }
        if (
          requestedOpen &&
          desktopLayoutDefinition.layout === "dev" &&
          !isMobile &&
          typeof document !== "undefined"
        ) {
          const projectSidebarWidth =
            getLocalStorageItem(PROJECT_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite) ??
            PROJECT_SIDEBAR_DEFAULT_WIDTH_PX;
          const appSidebarWrapper = document.querySelector<HTMLElement>(
            "[data-slot='sidebar-wrapper'][data-app-layout-layout='dev']",
          );
          const layoutWidth = appSidebarWrapper?.getBoundingClientRect().width ?? window.innerWidth;
          const result = rebalanceDevWorkspaceWidthBeforeProjectsOpen({
            layoutWidth,
            projectSidebarWidth,
            root: document,
            terminalOpen,
          });
          if (!result.canOpen) {
            return previousOpen;
          }
          if (result.nextProjectSidebarWidth !== null) {
            appSidebarWrapper?.style.setProperty(
              "--sidebar-width",
              `${result.nextProjectSidebarWidth}px`,
            );
            setLocalStorageItem(
              PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
              result.nextProjectSidebarWidth,
              Schema.Finite,
            );
          }
        }
        return requestedOpen;
      });
    },
  );

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
      toggleProjectSidebar((open) => !open);
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [keybindings, terminalOpen]);

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
          wrapper.clientWidth - nextWidth >= projectSidebarMainContentMinWidth,
        storageKey: PROJECT_SIDEBAR_WIDTH_STORAGE_KEY,
      }}
    >
      <ThreadSidebar />
      <SidebarRail />
    </Sidebar>
  );
  const projectSidebarShell = (
    <div
      className={cn("hidden shrink-0 md:block", projectSidebarOpen ? "w-(--sidebar-width)" : "w-0")}
      data-open={projectSidebarOpen ? "true" : "false"}
      data-slot="project-sidebar-shell"
    >
      {projectSidebar}
    </div>
  );

  return (
    <SidebarProvider
      data-app-layout-mode={desktopLayoutMode}
      data-app-layout-layout={desktopLayoutDefinition.layout}
      onOpenChange={setProjectSidebarOpen}
      open={projectSidebarOpen}
    >
      {desktopLayoutDefinition.layout === "dev" ? children : projectSidebarShell}
      {desktopLayoutDefinition.layout === "dev" ? projectSidebarShell : children}
      {!isMobile && (
        <ProjectSidebarDesktopToggle
          open={projectSidebarOpen}
          side={projectSidebarSide}
          shortcutLabel={projectsToggleShortcutLabel}
          onToggle={() => toggleProjectSidebar((open) => !open)}
        />
      )}
    </SidebarProvider>
  );
}

function ProjectSidebarDesktopToggle({
  open,
  side,
  shortcutLabel,
  onToggle,
}: {
  open: boolean;
  side: "left" | "right";
  shortcutLabel: string | null;
  onToggle: () => void;
}) {
  const Icon =
    side === "left"
      ? open
        ? PanelLeftCloseIcon
        : PanelLeftOpenIcon
      : open
        ? PanelRightCloseIcon
        : PanelRightOpenIcon;
  const label = `${open ? "Hide" : "Show"} Projects sidebar`;
  const tooltipLabel = shortcutLabel ? `${label} (${shortcutLabel})` : label;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={tooltipLabel}
            data-open={open ? "true" : "false"}
            data-slot="project-sidebar-desktop-toggle"
            data-side={side}
            onClick={onToggle}
            className={cn(
              "pointer-events-auto fixed top-16 z-30 hidden h-9 w-7 items-center justify-center border border-border/60 bg-card/95 text-muted-foreground shadow-sm/10 transition-[background-color,color,left,right] hover:bg-accent hover:text-accent-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring md:flex [-webkit-app-region:no-drag]",
              side === "left"
                ? open
                  ? "left-[calc(var(--sidebar-width)-0.875rem)] rounded-md"
                  : "left-0 rounded-r-md border-l-0"
                : open
                  ? "right-[calc(var(--sidebar-width)-0.875rem)] rounded-md"
                  : "right-0 rounded-l-md border-r-0",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        }
      />
      <TooltipPopup side={side === "left" ? "right" : "left"} align="center">
        {tooltipLabel}
      </TooltipPopup>
    </Tooltip>
  );
}
