export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/account"
  | "/settings/organization"
  | "/settings/connections"
  | "/settings/api-usage"
  | "/settings/usage-activity"
  | "/settings/billing"
  | "/settings/storage"
  | "/settings/archived";

export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSectionPath, string>> = {
  "/settings/general": "General",
  "/settings/account": "Account",
  "/settings/organization": "Organization",
  "/settings/connections": "Connections",
  "/settings/api-usage": "API usage",
  "/settings/usage-activity": "Usage & activity",
  "/settings/billing": "Billing",
  "/settings/storage": "Storage",
  "/settings/archived": "Archive",
};

export const SETTINGS_SECTION_PATHS = Object.keys(
  SETTINGS_SECTION_LABELS,
) as readonly SettingsSectionPath[];

/**
 * Every reason a settings section can be absent, in one place.
 *
 * The sidebar nav decided two of these inline and the breadcrumb knew about
 * none of them, so a section could be missing from the menu and still be
 * reachable and titled. One function answers it for both.
 *
 * - `orgSettingsVisible` / `apiUsageTabVisible` are user preferences.
 * - `billingAvailable` is the LogicPacks API gateway: an instance without
 *   `T3CODE_GATEWAY_URL` / `T3CODE_GATEWAY_PROVISION_TOKEN` has no plan, no
 *   balance and nothing to buy, so a Billing entry there leads only to a page
 *   explaining that it cannot work.
 *
 * `null` means "not known yet" and reads as VISIBLE throughout: never
 * flash-hide a section somebody can already see, only hide once we know for
 * sure it is off. That rule is why these are three-valued rather than booleans
 * defaulted at the call site.
 */
export interface SettingsSectionAvailability {
  readonly orgSettingsVisible?: boolean | null;
  readonly apiUsageTabVisible?: boolean | null;
  readonly billingAvailable?: boolean | null;
}

export function isSettingsSectionAvailable(
  to: SettingsSectionPath,
  availability: SettingsSectionAvailability,
): boolean {
  switch (to) {
    case "/settings/organization":
      return availability.orgSettingsVisible ?? true;
    case "/settings/api-usage":
      return availability.apiUsageTabVisible ?? true;
    case "/settings/billing":
      return availability.billingAvailable ?? true;
    default:
      return true;
  }
}

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
