/**
 * Should a bare `/` keypress jump into the sidebar's search field?
 *
 * Adopted from upstream's settings-search shortcut. The guards matter more
 * than the shortcut: typing `/` inside a field, a code editor or an open
 * dialog must stay a slash, and pulling focus out of a dialog's focus trap
 * would strand the dialog.
 */
export function shouldFocusSidebarSearchShortcut(input: {
  readonly key: string;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly defaultPrevented: boolean;
  readonly targetIsTextEntry: boolean;
  readonly targetIsInsideOverlay: boolean;
}): boolean {
  if (input.key !== "/") return false;
  if (input.altKey || input.ctrlKey || input.metaKey) return false;
  if (input.defaultPrevented) return false;
  if (input.targetIsTextEntry || input.targetIsInsideOverlay) return false;
  return true;
}

export const SIDEBAR_FILTER_SHORTCUT_TARGET_SELECTOR =
  '[role="dialog"], [aria-modal="true"], [data-slot$="popup"]';

/** Whether an event target should swallow the shortcut instead of the sidebar taking it. */
export function isTextEntryElement(element: {
  readonly tagName: string;
  readonly isContentEditable: boolean;
}): boolean {
  return (
    element.tagName === "INPUT" ||
    element.tagName === "TEXTAREA" ||
    element.tagName === "SELECT" ||
    element.isContentEditable
  );
}

export interface SidebarFilterState {
  readonly searchQuery: string;
  readonly threadStatusFilter: string;
  readonly projectSourceFilter: string;
  readonly ownerFilter: string;
}

/**
 * How many of the sidebar's narrowing controls are doing something.
 *
 * Zero means the list is showing everything it has — which is a different
 * thing from a filtered list that happens to match everything, and different
 * again from having no projects at all. Only a non-zero count earns the
 * "clear" affordance.
 */
export function countActiveSidebarFilters(state: SidebarFilterState): number {
  let count = 0;
  if (state.searchQuery.trim().length > 0) count += 1;
  if (state.threadStatusFilter !== "all") count += 1;
  if (state.projectSourceFilter !== "all") count += 1;
  if (state.ownerFilter !== "all") count += 1;
  return count;
}

/** `2 filters` / `1 filter`, for the clear affordance's label. */
export function describeActiveSidebarFilters(count: number): string {
  return count === 1 ? "1 filter" : `${count} filters`;
}
