import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { type DesktopLayoutMode } from "@t3tools/contracts/settings";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import {
  DiffIcon,
  EllipsisIcon,
  FilesIcon,
  LayoutPanelLeftIcon,
  TerminalSquareIcon,
} from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { Toggle as ToggleGroupItem, ToggleGroup } from "../ui/toggle-group";
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
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { shortcutLabelForCommand } from "~/keybindings";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
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
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleWorkspace,
  onToggleDiff,
  onDesktopLayoutModeChange,
}: ChatHeaderProps) {
  const projectsToggleShortcutLabel = shortcutLabelForCommand(keybindings, "projects.toggle");
  const projectsTriggerTooltip = projectsToggleShortcutLabel
    ? `Toggle Projects sidebar (${projectsToggleShortcutLabel})`
    : "Toggle Projects sidebar";
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger
          aria-label={projectsTriggerTooltip}
          title={projectsTriggerTooltip}
          className="size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]"
        />

        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        <DesktopLayoutToggle
          desktopLayoutMode={desktopLayoutMode}
          onDesktopLayoutModeChange={onDesktopLayoutModeChange}
        />
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

const DesktopLayoutToggle = memo(function DesktopLayoutToggle(props: {
  desktopLayoutMode: DesktopLayoutMode;
  onDesktopLayoutModeChange: (mode: DesktopLayoutMode) => void;
}) {
  return (
    <div className="hidden shrink-0 @md/header-actions:flex">
      <ToggleGroup
        aria-label="Desktop layout mode"
        className="shrink-0 [-webkit-app-region:no-drag]"
        variant="outline"
        size="xs"
        value={[props.desktopLayoutMode]}
        onValueChange={(value) => {
          const nextMode = value[0];
          if (nextMode === "vibe" || nextMode === "dev") {
            props.onDesktopLayoutModeChange(nextMode);
          }
        }}
      >
        <ToggleGroupItem
          aria-label="Switch to vibe layout"
          title="Vibe layout: Projects, Chat, Workspace"
          value="vibe"
        >
          Vibe
        </ToggleGroupItem>
        <ToggleGroupItem
          aria-label="Switch to dev layout"
          title="Dev layout: Workspace, Chat, Projects"
          value="dev"
        >
          Dev
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
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
              if (value === "vibe" || value === "dev") {
                props.onDesktopLayoutModeChange(value);
              }
            }}
          >
            <MenuRadioItem value="vibe">Vibe · Projects · Chat · Workspace</MenuRadioItem>
            <MenuRadioItem value="dev">Dev · Workspace · Chat · Projects</MenuRadioItem>
          </MenuRadioGroup>
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
