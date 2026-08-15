import {
  type EnvironmentId,
  type EditorId,
  type OrchestrationProjectOwnership,
  type ProjectId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { type DesktopLayoutMode } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { useNavigate } from "@tanstack/react-router";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  DiffIcon,
  EllipsisIcon,
  FilesIcon,
  LayoutPanelLeftIcon,
  PanelLeftCloseIcon,
  PanelLeftIcon,
  PanelRightCloseIcon,
  PanelRightIcon,
  TerminalSquareIcon,
  SettingsIcon,
} from "lucide-react";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useSidebar } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { ProjectSurfaceLinks } from "./ProjectSurfaceLinks";
import { shortcutLabelForCommand } from "~/keybindings";
import type { DesktopLayoutModeDefinition } from "~/desktopLayoutModes";
import { CollaborationPresenceBar } from "../collaboration/CollaborationPresenceBar";
import { CollaborationUsageBar } from "../collaboration/CollaborationUsageBar";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectId: ProjectId | null;
  activeProjectOwnership: OrchestrationProjectOwnership | null | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  workspaceAvailable: boolean;
  workspaceOpen: boolean;
  diffOpen: boolean;
  desktopLayoutMode: DesktopLayoutMode;
  desktopLayoutModeDefinitions: readonly DesktopLayoutModeDefinition[];
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleWorkspace: () => void;
  onToggleDiff: () => void;
  onDesktopLayoutModeChange: (mode: DesktopLayoutMode) => void;
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectId,
  activeProjectOwnership,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  workspaceAvailable,
  workspaceOpen,
  diffOpen,
  desktopLayoutMode,
  desktopLayoutModeDefinitions,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleWorkspace,
  onToggleDiff,
  onDesktopLayoutModeChange,
}: ChatHeaderProps) {
  const activeLayoutDefinition =
    desktopLayoutModeDefinitions.find((definition) => definition.id === desktopLayoutMode) ??
    desktopLayoutModeDefinitions[0];
  const projectsToggleShortcutLabel = shortcutLabelForCommand(keybindings, "projects.toggle");
  const projectsTriggerTooltip = projectsToggleShortcutLabel
    ? `Toggle Projects sidebar (${projectsToggleShortcutLabel})`
    : "Toggle Projects sidebar";
  const projectsSidebarSide = activeLayoutDefinition?.layout === "dev" ? "right" : "left";
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <HeaderProjectsTrigger side={projectsSidebarSide} tooltip={projectsTriggerTooltip} />

        <div className="min-w-0 flex-1 @sm/header-actions:flex @sm/header-actions:items-center @sm/header-actions:gap-2">
          <h2
            className="min-w-0 truncate text-[13px] font-medium leading-tight text-foreground @sm/header-actions:text-sm"
            title={activeThreadTitle}
          >
            {activeThreadTitle}
          </h2>
          {activeProjectName && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 @sm/header-actions:mt-0 @sm/header-actions:shrink-0">
              <span
                className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/78 @sm/header-actions:max-w-36 @sm/header-actions:rounded-md @sm/header-actions:border @sm/header-actions:border-border/70 @sm/header-actions:px-1.5 @sm/header-actions:py-0.5 @sm/header-actions:text-xs @sm/header-actions:text-foreground"
                title={activeProjectName}
              >
                {activeProjectName}
              </span>
              {!isGitRepo ? (
                <span className="shrink-0 text-[10px] font-medium text-amber-700">No Git</span>
              ) : null}
            </div>
          )}
          {activeProjectId ? (
            <div className="mt-1 flex items-center gap-1.5 @xl/header-actions:mt-0">
              <CollaborationPresenceBar
                environmentId={activeThreadEnvironmentId}
                ownership={activeProjectOwnership}
                projectId={activeProjectId}
                threadId={activeThreadId}
              />
              <CollaborationUsageBar
                environmentId={activeThreadEnvironmentId}
                ownership={activeProjectOwnership}
                projectId={activeProjectId}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {activeProjectName && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        {activeProjectId ? <ProjectSurfaceLinks projectId={activeProjectId} /> : null}
        <InlinePanelToggles
          terminalAvailable={terminalAvailable}
          terminalOpen={terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          workspaceAvailable={workspaceAvailable}
          workspaceOpen={workspaceOpen}
          diffToggleShortcutLabel={diffToggleShortcutLabel}
          isGitRepo={isGitRepo}
          diffOpen={diffOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleWorkspace={onToggleWorkspace}
          onToggleDiff={onToggleDiff}
        />
        <ViewOverflowMenu
          desktopLayoutMode={desktopLayoutMode}
          desktopLayoutModeDefinitions={desktopLayoutModeDefinitions}
          onDesktopLayoutModeChange={onDesktopLayoutModeChange}
          terminalAvailable={terminalAvailable}
          terminalOpen={terminalOpen}
          terminalToggleShortcutLabel={terminalToggleShortcutLabel}
          workspaceAvailable={workspaceAvailable}
          workspaceOpen={workspaceOpen}
          diffToggleShortcutLabel={diffToggleShortcutLabel}
          isGitRepo={isGitRepo}
          diffOpen={diffOpen}
          onToggleTerminal={onToggleTerminal}
          onToggleWorkspace={onToggleWorkspace}
          onToggleDiff={onToggleDiff}
        />
      </div>
    </div>
  );
});

const HeaderProjectsTrigger = memo(function HeaderProjectsTrigger(props: {
  side: "left" | "right";
  tooltip: string;
}) {
  const { openMobile, toggleSidebar } = useSidebar();
  const Icon =
    props.side === "right"
      ? openMobile
        ? PanelRightCloseIcon
        : PanelRightIcon
      : openMobile
        ? PanelLeftCloseIcon
        : PanelLeftIcon;

  return (
    <Button
      aria-label={props.tooltip}
      title={props.tooltip}
      className="size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]"
      data-sidebar="trigger"
      data-slot="chat-header-projects-trigger"
      onClick={toggleSidebar}
      size="icon"
      variant="ghost"
    >
      <Icon aria-hidden="true" className="size-4" />
      <span className="sr-only">Toggle Projects sidebar</span>
    </Button>
  );
});

const InlinePanelToggles = memo(function InlinePanelToggles(props: {
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  workspaceAvailable: boolean;
  workspaceOpen: boolean;
  diffToggleShortcutLabel: string | null;
  isGitRepo: boolean;
  diffOpen: boolean;
  onToggleTerminal: () => void;
  onToggleWorkspace: () => void;
  onToggleDiff: () => void;
}) {
  return (
    <div
      data-slot="chat-header-inline-toggles"
      className="hidden shrink-0 items-center gap-2 @3xl/header-actions:flex"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0"
              pressed={props.terminalOpen}
              onPressedChange={props.onToggleTerminal}
              aria-label="Toggle terminal drawer"
              variant="outline"
              size="xs"
              disabled={!props.terminalAvailable}
            >
              <TerminalSquareIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {!props.terminalAvailable
            ? "Terminal is unavailable until this thread has an active project."
            : props.terminalToggleShortcutLabel
              ? `Toggle terminal drawer (${props.terminalToggleShortcutLabel})`
              : "Toggle terminal drawer"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0"
              pressed={props.workspaceOpen}
              onPressedChange={props.onToggleWorkspace}
              aria-label="Toggle workspace panel"
              variant="outline"
              size="xs"
              disabled={!props.workspaceAvailable}
            >
              <FilesIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {!props.workspaceAvailable
            ? "Workspace panel is unavailable until this thread has an active workspace."
            : "Toggle workspace panel"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              className="shrink-0"
              pressed={props.diffOpen}
              onPressedChange={props.onToggleDiff}
              aria-label="Toggle diff panel"
              variant="outline"
              size="xs"
              disabled={!props.isGitRepo}
            >
              <DiffIcon className="size-3" />
            </Toggle>
          }
        />
        <TooltipPopup side="bottom">
          {!props.isGitRepo
            ? "Diff panel is unavailable because this project is not a git repository."
            : props.diffToggleShortcutLabel
              ? `Toggle diff panel (${props.diffToggleShortcutLabel})`
              : "Toggle diff panel"}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
});

const ViewOverflowMenu = memo(function ViewOverflowMenu(props: {
  desktopLayoutMode: DesktopLayoutMode;
  desktopLayoutModeDefinitions: readonly DesktopLayoutModeDefinition[];
  onDesktopLayoutModeChange: (mode: DesktopLayoutMode) => void;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  workspaceAvailable: boolean;
  workspaceOpen: boolean;
  diffToggleShortcutLabel: string | null;
  isGitRepo: boolean;
  diffOpen: boolean;
  onToggleTerminal: () => void;
  onToggleWorkspace: () => void;
  onToggleDiff: () => void;
}) {
  const navigate = useNavigate();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              aria-label="View options"
              render={<Button size="icon-xs" variant="outline" className="shrink-0" />}
            />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-3" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">View options</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end" className="min-w-52">
        <MenuGroup>
          <MenuGroupLabel>
            <span className="inline-flex items-center gap-1.5">
              <LayoutPanelLeftIcon className="size-3.5" aria-hidden="true" />
              Desktop layout
            </span>
          </MenuGroupLabel>
          <MenuRadioGroup
            value={props.desktopLayoutMode}
            onValueChange={(value) => {
              if (
                value &&
                props.desktopLayoutModeDefinitions.some((definition) => definition.id === value)
              ) {
                props.onDesktopLayoutModeChange(value);
              }
            }}
          >
            {props.desktopLayoutModeDefinitions.map((definition) => (
              <MenuRadioItem key={definition.id} value={definition.id}>
                {definition.label} · {definition.description}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuItem onClick={() => void navigate({ to: "/settings/general" })}>
            <SettingsIcon className="size-3.5" aria-hidden="true" />
            Layout settings
          </MenuItem>
        </MenuGroup>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Panels</MenuGroupLabel>
          <MenuItem
            disabled={!props.terminalAvailable}
            onClick={() => {
              if (props.terminalAvailable) {
                props.onToggleTerminal();
              }
            }}
          >
            <TerminalSquareIcon className="size-3.5" aria-hidden="true" />
            {props.terminalOpen ? "Hide terminal drawer" : "Show terminal drawer"}
            {props.terminalToggleShortcutLabel ? (
              <kbd className="ms-auto font-medium font-sans text-muted-foreground/72 text-xs">
                {props.terminalToggleShortcutLabel}
              </kbd>
            ) : null}
          </MenuItem>
          <MenuItem
            disabled={!props.workspaceAvailable}
            onClick={() => {
              if (props.workspaceAvailable) {
                props.onToggleWorkspace();
              }
            }}
          >
            <FilesIcon className="size-3.5" aria-hidden="true" />
            {props.workspaceOpen ? "Hide workspace panel" : "Show workspace panel"}
          </MenuItem>
          <MenuItem
            disabled={!props.isGitRepo}
            onClick={() => {
              if (props.isGitRepo) {
                props.onToggleDiff();
              }
            }}
          >
            <DiffIcon className="size-3.5" aria-hidden="true" />
            {props.diffOpen ? "Hide diff panel" : "Show diff panel"}
            {props.diffToggleShortcutLabel ? (
              <kbd className="ms-auto font-medium font-sans text-muted-foreground/72 text-xs">
                {props.diffToggleShortcutLabel}
              </kbd>
            ) : null}
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
});
