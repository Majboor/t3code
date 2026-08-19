/** The utility surfaces the sidebar footer navigates to. */
export type SidebarUtilityPage = "environments" | "settings";

export const SIDEBAR_UTILITY_ROUTES: Readonly<Record<SidebarUtilityPage, string>> = {
  environments: "/environments",
  settings: "/settings",
};

/**
 * Which utility page a pathname is on, or `null` for the workspace itself.
 *
 * `null` is a real answer, not a missing one: the footer shows its links
 * unmarked on the workspace and marks the current one on a utility page, and
 * only a utility page offers a way back out.
 */
export function resolveSidebarUtilityPage(pathname: string): SidebarUtilityPage | null {
  const normalized = pathname.replace(/\/+$/, "") || "/";
  for (const [page, route] of Object.entries(SIDEBAR_UTILITY_ROUTES) as ReadonlyArray<
    [SidebarUtilityPage, string]
  >) {
    if (normalized === route || normalized.startsWith(`${route}/`)) {
      return page;
    }
  }
  return null;
}
