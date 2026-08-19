import { ArrowLeftIcon, MonitorSmartphoneIcon, SettingsIcon } from "lucide-react";
import type { ComponentType } from "react";
import { memo, useCallback } from "react";
import { useCanGoBack, useLocation, useNavigate } from "@tanstack/react-router";

import { cn } from "~/lib/utils";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "../ui/sidebar";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import {
  resolveSidebarUtilityPage,
  SIDEBAR_UTILITY_ROUTES,
  type SidebarUtilityPage,
} from "./sidebarChrome.logic";

const UTILITY_ITEMS: ReadonlyArray<{
  readonly page: SidebarUtilityPage;
  readonly label: string;
  readonly icon: ComponentType<{ className?: string }>;
}> = [
  { page: "environments", label: "Environments", icon: MonitorSmartphoneIcon },
  { page: "settings", label: "Settings", icon: SettingsIcon },
];

function SidebarUtilityRow({
  icon: Icon,
  label,
  isActive = false,
  onClick,
}: {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly isActive?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        size="sm"
        isActive={isActive}
        className={cn(
          "gap-2 px-2 py-1.5 hover:bg-accent hover:text-foreground",
          isActive ? "text-foreground" : "text-muted-foreground/70",
        )}
        onClick={onClick}
      >
        <Icon className={cn("size-3.5", isActive ? "text-foreground" : undefined)} />
        <span className="text-xs">{label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * The links every sidebar ends with.
 *
 * Shape adopted from upstream's `SidebarUtilityMenu`: the footer knows which
 * utility surface you are on and marks it, and offers the way back out only
 * from there. Unlike upstream we keep both destinations visible on a utility
 * page instead of replacing them with a lone "Back" — our `/environments` page
 * keeps the project sidebar, so hiding "Settings" there would strand it.
 */
export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const { isMobile, setOpenMobile } = useSidebar();
  const currentUtilityPage = useLocation({
    select: (location) => resolveSidebarUtilityPage(location.pathname),
  });

  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  const handleUtilityClick = useCallback(
    (page: SidebarUtilityPage) => {
      closeMobileSidebar();
      void navigate({ to: SIDEBAR_UTILITY_ROUTES[page] });
    },
    [closeMobileSidebar, navigate],
  );

  // History is the right answer when there is history — it returns to the
  // thread you left. Entering on a utility page directly (a bookmark, a
  // desktop menu item) has none, and `history.back()` would leave the app.
  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, closeMobileSidebar, navigate]);

  return (
    <SidebarMenu>
      {UTILITY_ITEMS.map((item) => (
        <SidebarUtilityRow
          key={item.page}
          icon={item.icon}
          label={item.label}
          isActive={currentUtilityPage === item.page}
          onClick={() => handleUtilityClick(item.page)}
        />
      ))}
      {currentUtilityPage ? (
        <SidebarUtilityRow
          icon={ArrowLeftIcon}
          label="Back to your work"
          onClick={handleBackClick}
        />
      ) : null}
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter className="p-2">
      <SidebarUpdatePill />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
