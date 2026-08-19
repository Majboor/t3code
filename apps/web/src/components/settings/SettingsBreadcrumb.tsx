import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { settingsSectionLabel } from "./settingsNav.logic";

/**
 * `Settings / Connections` in the top bar, so a settings page says which one it
 * is. Adopted from upstream. The root `/settings` shows a single crumb rather
 * than "Settings / Settings" — it only ever renders for the instant before the
 * redirect to a section lands.
 */
export function SettingsBreadcrumb({ pathname }: { readonly pathname: string }) {
  const sectionLabel = settingsSectionLabel(pathname);

  return (
    <WorkspaceBreadcrumb ariaLabel="Settings breadcrumb">
      {sectionLabel ? (
        <>
          <WorkspaceBreadcrumbItem>Settings</WorkspaceBreadcrumbItem>
          <WorkspaceBreadcrumbSeparator />
        </>
      ) : null}
      <WorkspaceBreadcrumbItem current className="truncate">
        {sectionLabel ?? "Settings"}
      </WorkspaceBreadcrumbItem>
    </WorkspaceBreadcrumb>
  );
}
