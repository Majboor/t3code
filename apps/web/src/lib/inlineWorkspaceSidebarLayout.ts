import {
  DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_AND_TERMINAL_PX,
  DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_PX,
} from "~/components/AppSidebarLayout.logic";

export const COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX = 208;

export function canAcceptInlineWorkspaceSidebarWidth(input: {
  nextWidth: number;
  projectsSidebarOpen: boolean;
  terminalOpen: boolean;
  wrapper: HTMLElement;
}): boolean {
  const composerForm = document.querySelector<HTMLElement>("[data-chat-composer-form='true']");
  if (!composerForm) return true;
  const composerViewport = composerForm.parentElement;
  if (!composerViewport) return true;
  const previousSidebarWidth = input.wrapper.style.getPropertyValue("--sidebar-width");
  input.wrapper.style.setProperty("--sidebar-width", `${input.nextWidth}px`);

  const viewportStyle = window.getComputedStyle(composerViewport);
  const viewportPaddingLeft = Number.parseFloat(viewportStyle.paddingLeft) || 0;
  const viewportPaddingRight = Number.parseFloat(viewportStyle.paddingRight) || 0;
  const viewportContentWidth = Math.max(
    0,
    composerViewport.clientWidth - viewportPaddingLeft - viewportPaddingRight,
  );
  const formRect = composerForm.getBoundingClientRect();
  const composerFooter = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-footer='true']",
  );
  const composerRightActions = composerForm.querySelector<HTMLElement>(
    "[data-chat-composer-actions='right']",
  );
  const composerRightActionsWidth = composerRightActions?.getBoundingClientRect().width ?? 0;
  const composerFooterGap = composerFooter
    ? Number.parseFloat(window.getComputedStyle(composerFooter).columnGap) ||
      Number.parseFloat(window.getComputedStyle(composerFooter).gap) ||
      0
    : 0;
  const chatColumn = document.querySelector<HTMLElement>("[data-layout-column='chat']");
  const minimumComposerWidth =
    COMPOSER_COMPACT_MIN_LEFT_CONTROLS_WIDTH_PX + composerRightActionsWidth + composerFooterGap;
  const minimumChatWidth = !input.projectsSidebarOpen
    ? 0
    : input.terminalOpen
      ? DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_AND_TERMINAL_PX
      : DEV_CHAT_MIN_WIDTH_WITH_PROJECTS_PX;
  const chatColumnWidth = chatColumn?.getBoundingClientRect().width ?? viewportContentWidth;
  const hasComposerOverflow = composerForm.scrollWidth > composerForm.clientWidth + 0.5;
  const overflowsViewport = formRect.width > viewportContentWidth + 0.5;
  const violatesMinimumComposerWidth = composerForm.clientWidth + 0.5 < minimumComposerWidth;
  const violatesMinimumChatWidth = chatColumnWidth + 0.5 < minimumChatWidth;

  if (previousSidebarWidth.length > 0) {
    input.wrapper.style.setProperty("--sidebar-width", previousSidebarWidth);
  } else {
    input.wrapper.style.removeProperty("--sidebar-width");
  }

  return (
    !hasComposerOverflow &&
    !overflowsViewport &&
    !violatesMinimumComposerWidth &&
    !violatesMinimumChatWidth
  );
}

export function findLargestAcceptedInlineWorkspaceWidth(input: {
  currentWidth: number;
  minWidth: number;
  projectsSidebarOpen: boolean;
  requestedWidth: number;
  terminalOpen: boolean;
  wrapper: HTMLElement;
}): number | null {
  const acceptsWidth = (nextWidth: number) =>
    canAcceptInlineWorkspaceSidebarWidth({
      nextWidth,
      projectsSidebarOpen: input.projectsSidebarOpen,
      terminalOpen: input.terminalOpen,
      wrapper: input.wrapper,
    });

  if (acceptsWidth(input.requestedWidth)) {
    return input.requestedWidth;
  }
  if (!acceptsWidth(input.minWidth)) {
    return null;
  }

  let low = input.minWidth;
  let high = input.requestedWidth;
  while (high - low > 1) {
    const candidate = Math.floor((high + low) / 2);
    if (acceptsWidth(candidate)) {
      low = candidate;
    } else {
      high = candidate;
    }
  }

  return low;
}
