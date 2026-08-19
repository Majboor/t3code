import type { ComponentType } from "react";
import { ArchiveIcon, Building2Icon, Link2Icon, Settings2Icon, UserIcon } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

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

  return (
    <>
      <SidebarContent className="overflow-x-hidden">
        <SidebarGroup className="px-2 py-3">
          <SidebarMenu>
            {SETTINGS_NAV_ITEMS.map((item) => {
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
