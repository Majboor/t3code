import type { ComponentType } from "react";
import {
  ActivityIcon,
  ArchiveIcon,
  Building2Icon,
  CreditCardIcon,
  GaugeIcon,
  Link2Icon,
  Settings2Icon,
  UserIcon,
} from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

import { useUserPreferences } from "../../hooks/useUserPreferences";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import {
  SidebarContent,
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "../ui/sidebar";
import {
  isSettingsSectionActive,
  SETTINGS_SECTION_LABELS,
  SETTINGS_SECTION_PATHS,
  type SettingsSectionPath,
} from "./settingsNav.logic";

export type { SettingsSectionPath };

const SETTINGS_SECTION_ICONS: Readonly<
  Record<SettingsSectionPath, ComponentType<{ className?: string }>>
> = {
  "/settings/general": Settings2Icon,
  "/settings/account": UserIcon,
  "/settings/organization": Building2Icon,
  "/settings/connections": Link2Icon,
  "/settings/api-usage": GaugeIcon,
  "/settings/usage-activity": ActivityIcon,
  "/settings/billing": CreditCardIcon,
  "/settings/archived": ArchiveIcon,
};

export const SETTINGS_NAV_ITEMS: ReadonlyArray<{
  label: string;
  to: SettingsSectionPath;
  icon: ComponentType<{ className?: string }>;
}> = SETTINGS_SECTION_PATHS.map((to) => ({
  to,
  label: SETTINGS_SECTION_LABELS[to],
  icon: SETTINGS_SECTION_ICONS[to],
}));

export function SettingsSidebarNav({ pathname }: { pathname: string }) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { preferences } = useUserPreferences();
  // `null` (not loaded yet) reads as "visible" - never flash-hide a section
  // the user can already see, only hide once we know for sure it's off.
  const orgSettingsVisible = preferences?.orgSettingsVisible ?? true;
  const apiUsageTabVisible = preferences?.apiUsageTabVisible ?? true;
  const visibleNavItems = SETTINGS_NAV_ITEMS.filter((item) => {
    if (item.to === "/settings/organization") return orgSettingsVisible;
    if (item.to === "/settings/api-usage") return apiUsageTabVisible;
    return true;
  });

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {visibleNavItems.map((item) => {
              const Icon = item.icon;
              const isActive = isSettingsSectionActive(pathname, item.to);
              return (
                <SidebarMenuItem key={item.to}>
                  <SidebarMenuButton
                    size="sm"
                    isActive={isActive}
                    className={
                      isActive
                        ? "gap-2.5 px-2.5 py-2 text-left text-[13px] font-medium text-foreground"
                        : "gap-2.5 px-2.5 py-2 text-left text-[13px] text-muted-foreground/70 hover:text-foreground/80"
                    }
                    onClick={() => {
                      if (isMobile) {
                        setOpenMobile(false);
                      }
                      void navigate({ to: item.to, replace: true });
                    }}
                  >
                    <Icon
                      className={
                        isActive
                          ? "size-4 shrink-0 text-foreground"
                          : "size-4 shrink-0 text-muted-foreground/60"
                      }
                    />
                    <span className="truncate">{item.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              );
            })}
          </SidebarMenu>
        </SidebarGroup>
      </SidebarContent>

      <SidebarSeparator />
      <SidebarChromeFooter />
    </>
  );
}
