export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/account"
  | "/settings/organization"
  | "/settings/connections"
  | "/settings/archived";

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionPath, string>> = {
  "/settings/general": "General",
  "/settings/account": "Account",
  "/settings/organization": "Organization",
  "/settings/connections": "Connections",
  "/settings/archived": "Archive",
};

export const SETTINGS_SECTION_PATHS = Object.keys(
  SETTINGS_SECTION_LABELS,
) as readonly SettingsSectionPath[];

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

/**
 * The label for the settings section a pathname is inside, or `null` when the
 * pathname is the settings root — which is a real state (the redirect to
 * `/settings/general` has not landed yet), not an unknown one.
 */
export function settingsSectionLabel(pathname: string): string | null {
  const normalized = normalizePathname(pathname);
  return SETTINGS_SECTION_LABELS[normalized as SettingsSectionPath] ?? null;
}

/** Whether a nav entry should read as the current section, including its sub-paths. */
export function isSettingsSectionActive(pathname: string, to: SettingsSectionPath): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === to || normalized.startsWith(`${to}/`);
}
