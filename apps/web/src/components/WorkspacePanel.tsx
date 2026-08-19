import * as Schema from "effect/Schema";
import Editor from "@monaco-editor/react";

import { useLocalMonaco } from "../lib/monacoSetup";
import { FileDiff } from "@pierre/diffs/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  CollaborationFileTouch,
  GitStatusResult,
  GitWorkingTreeFileStatus,
  ProjectCreateEntryInput,
  ProjectDirectoryEntry,
  ProjectReadFileResult,
  TurnId,
} from "@t3tools/contracts";
import { createThreadSelectorByRef } from "~/storeSelectors";
import {
  ChevronRightIcon,
  FilePlus2Icon,
  FileWarningIcon,
  FilesIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  GitCompareArrowsIcon,
  HardDriveUploadIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  SaveIcon,
  Share2Icon,
  XIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ensureEnvironmentApi, readEnvironmentApi } from "~/environmentApi";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { useCollaborationGovernance } from "~/hooks/useCollaborationGovernance";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { useWorkspaceAgentTurnDiff } from "~/hooks/useWorkspaceAgentTurnDiff";
import { useWorkspaceWorkingTreeDiff } from "~/hooks/useWorkspaceWorkingTreeDiff";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { gitQueryKeys } from "~/lib/gitReactQuery";
import { refreshGitStatus, useGitStatus } from "~/lib/gitStatusState";
import { buildFileDiffRenderKey, DIFF_VIEWER_UNSAFE_CSS } from "~/lib/patchDiff";
import {
  buildWorkspaceAgentDiffIndex,
  type WorkspaceAgentFileDiff,
} from "~/lib/workspaceAgentDiffs";
import {
  buildWorkspaceDiffReviewItems,
  buildWorkspaceFocusedFileDiff,
  type WorkspaceDiffReviewItem,
} from "~/lib/workspaceDiffReview";
import {
  peekPendingWorkspaceLiveDiffBaselineForThread,
  takePendingWorkspaceLiveDiffBaselineForThread,
} from "~/lib/workspaceLiveDiffBaselineState";
import {
  buildWorkspaceLiveTurnDiffStatByPath,
  hashWorkspaceChangeText,
  type WorkspaceWorkingTreeFileStat,
} from "~/lib/workspaceLiveDiffs";
import {
  workspaceListDirectoryQueryOptions,
  workspaceQueryKeys,
  workspaceReadFileQueryOptions,
} from "~/lib/workspaceReactQuery";
import { cn } from "~/lib/utils";
import { selectProjectByRef, useStore } from "~/store";
import { resolveProjectRouteRef, resolveThreadRouteRef } from "~/threadRoutes";
import { basenameOfPath } from "~/vscode-icons";

import { DiffStatLabel, FileStatusBadge, hasNonZeroStat } from "./chat/DiffStatLabel";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { mintAndCopyShareLink } from "./shareLinks/mintShareLink";
import { ShareFileLinkButton } from "./shareLinks/ShareFileLinkButton";
import { ShareLinksPanel } from "./shareLinks/ShareLinksPanel";
import { WorkspaceAgentDiffPreview } from "./WorkspaceAgentDiffPreview";
import {
  WorkspacePanelLoadingState,
  WorkspacePanelShell,
  type WorkspacePanelMode,
} from "./WorkspacePanelShell";
import {
  createWorkspaceDirectoryRelistGate,
  type WorkspaceDirectoryRelistGate,
} from "./workspaceTreePoll.logic";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { SidebarTrigger } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";

const ROOT_DIRECTORY_KEY = "";
const EMPTY_WORKSPACE_FILE_DIFF_HISTORY: ReadonlyArray<WorkspaceAgentFileDiff> = [];
const EMPTY_WORKSPACE_DIFF_STAT_MAP = new Map<
  string,
  { additions: number; deletions: number; diffSignature?: string | undefined }
>();
const EMPTY_WORKSPACE_DIFF_REVIEW_ITEMS: ReadonlyArray<WorkspaceDiffReviewItem> = [];
const EMPTY_WORKSPACE_DIFF_REVIEW_IDS: ReadonlyArray<string> = [];
const EMPTY_WORKSPACE_WORKING_TREE_FILES: ReadonlyArray<WorkspaceWorkingTreeFileStat> = [];
const EMPTY_WORKSPACE_AUTHORS: ReadonlyMap<string, CollaborationFileTouch> = new Map();
// The tree mirrors a directory that anyone can change without telling us: a
// collaborator in another browser, the agent, or a process outside the app
// entirely. Re-list what is on screen on a timer so it stops going stale.
//
// The cost scales with folders open, because there is no call that returns the
// whole visible tree — see `workspaceTreePoll.logic.ts`. With 12 folders
// expanded that was 144 requests/minute from the tree alone; at 15s it is 48,
// and none at all while a turn is running.
const WORKSPACE_TREE_POLL_INTERVAL_MS = 15_000;
const WORKSPACE_ACCEPTED_DIFF_STORAGE_PREFIX = "t3code:workspace-accepted-diffs:v1";
const WORKSPACE_DIFF_REVIEW_STORAGE_PREFIX = "t3code:workspace-diff-review:v1";

/**
 * The fallback colour for a collaborator, derived from the id so everyone's
 * browser agrees without the server having to hand out a palette.
 *
 * A fallback only. It matches what the server assigns by default — the same
 * hash lives in `defaultMemberColor` — but an approver may override any
 * member's colour from the roster, and that override exists only on the
 * server. Deriving the colour here regardless is why a recoloured person kept
 * their old colour against every file they touched: the roster changed and the
 * tree did not, so one person wore two colours. Prefer `memberColorByUserId`
 * and come here only for somebody the roster does not list.
 */
function authorColor(userId: string): string {
  let hash = 0;
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) % 360;
  }
  return `hsl(${hash} 70% 55%)`;
}

/** Lets a polled re-list keep the existing array when the directory is unchanged. */
function directoryEntriesMatch(
  left: ReadonlyArray<ProjectDirectoryEntry>,
  right: ReadonlyArray<ProjectDirectoryEntry>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.name === other.name &&
      entry.path === other.path &&
      entry.kind === other.kind
    );
  });
}

function buildWorkspaceLiveDiffKey(
  turnKey: string,
  pathValue: string,
  stat: { additions: number; deletions: number; diffSignature?: string | undefined },
): string {
  return `working-tree:${turnKey}:${pathValue}:${stat.additions}:${stat.deletions}:${
    stat.diffSignature ?? ""
  }`;
}

function buildWorkspaceCheckpointDiffKey(entry: WorkspaceAgentFileDiff): string {
  return `checkpoint:${entry.turnId}:${entry.path.replaceAll("\\", "/")}`;
}

function buildWorkspaceReviewSessionKey(turnId: TurnId, pathValue: string): string {
  return `turn:${turnId}:${pathValue}`;
}

function buildWorkspaceCurrentReviewSessionKey(scopeKey: string, pathValue: string): string {
  return `current:${scopeKey}:${pathValue}`;
}

function isWorkspaceRelativePath(pathValue: string): boolean {
  const normalizedPath = pathValue.replaceAll("\\", "/").replace(/^\.\/+/, "");
  return (
    normalizedPath.length > 0 &&
    !normalizedPath.startsWith("/") &&
    normalizedPath !== ".." &&
    !normalizedPath.startsWith("../") &&
    !normalizedPath.includes("/../")
  );
}

interface WorkspaceResolvedFileDiffState {
  source: "working-tree" | "checkpoint";
  sessionKey: string;
  visibilityKey: string;
  stat: {
    additions: number;
    deletions: number;
    diffSignature?: string | undefined;
  };
}

interface WorkspaceAcceptedDiffState {
  source: "working-tree" | "checkpoint";
  sessionKey: string;
  visibilityKey: string;
}

interface WorkspaceReviewFileEntry extends WorkspaceResolvedFileDiffState {
  path: string;
}

type WorkspaceLiveDiffBaselineSource = "pending" | "status";

interface WorkspaceCompletedLiveDiffState {
  turnId: TurnId;
  turnKey: string;
  source: WorkspaceLiveDiffBaselineSource;
  statByPath: ReadonlyMap<
    string,
    { additions: number; deletions: number; diffSignature?: string | undefined }
  >;
}

interface WorkspaceGitStatusSnapshot {
  isRepo: boolean;
  files: ReadonlyArray<WorkspaceWorkingTreeFileStat>;
}

function isWorkspaceDiffAccepted(
  acceptedState: WorkspaceAcceptedDiffState | null | undefined,
  visibleDiffState: Pick<WorkspaceResolvedFileDiffState, "source" | "sessionKey" | "visibilityKey">,
): boolean {
  if (!acceptedState) {
    return false;
  }

  if (acceptedState.visibilityKey === visibleDiffState.visibilityKey) {
    return true;
  }

  return (
    acceptedState.source === "working-tree" &&
    visibleDiffState.source === "checkpoint" &&
    acceptedState.sessionKey === visibleDiffState.sessionKey
  );
}

function directoryKey(pathValue: string | null | undefined): string {
  return pathValue ?? ROOT_DIRECTORY_KEY;
}

function parentDirectoryOf(pathValue: string | null | undefined): string | null {
  if (!pathValue) {
    return null;
  }

  const separatorIndex = pathValue.lastIndexOf("/");
  if (separatorIndex < 0) {
    return null;
  }
  return pathValue.slice(0, separatorIndex);
}

function joinRelativePath(directoryPath: string | null, name: string): string {
  const normalizedName = name
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "");
  return directoryPath ? `${directoryPath}/${normalizedName}` : normalizedName;
}

function hasDraggedFiles(event: DragEvent<HTMLElement>): boolean {
  return [...event.dataTransfer.items].some((item) => item.kind === "file");
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }

  return btoa(chunks.join(""));
}

const WorkspaceExplorerRow = memo(function WorkspaceExplorerRow(props: {
  depth: number;
  entry: ProjectDirectoryEntry;
  expanded: boolean;
  loading: boolean;
  selected: boolean;
  dropTarget: boolean;
  resolvedTheme: "light" | "dark";
  changed: boolean;
  diffStat?: { additions: number; deletions: number } | null;
  status?: GitWorkingTreeFileStatus | null;
  /** Who last wrote this file, when someone else did. */
  author?: { userId: string; displayName: string } | null;
  /** The roster's colour for that person, so a recolour reaches this mark too. */
  authorColorValue?: string | null;
  onToggleDirectory: (directoryPath: string) => void;
  onOpenFile: (relativePath: string) => void;
  /** Absent when this workspace has no tenancy to hand a public link out of. */
  onCopyShareLink?: ((relativePath: string) => Promise<void>) | undefined;
  onSelectEntry: (entry: Pick<ProjectDirectoryEntry, "kind" | "path">) => void;
  onDirectoryDrop: (event: DragEvent<HTMLButtonElement>, directoryPath: string) => void;
  onDirectoryDragOver: (event: DragEvent<HTMLButtonElement>, directoryPath: string) => void;
  onDirectoryDragLeave: (event: DragEvent<HTMLButtonElement>, directoryPath: string) => void;
  children?: React.ReactNode;
}) {
  const { depth, entry, resolvedTheme } = props;
  const paddingLeft = 10 + depth * 14;

  if (entry.kind === "directory") {
    return (
      <div key={entry.path}>
        <button
          type="button"
          className={cn(
            "group flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors",
            props.selected
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground/80 hover:bg-accent/70 hover:text-foreground",
            props.dropTarget && "bg-primary/10 ring-1 ring-primary/35",
          )}
          style={{ paddingLeft: `${paddingLeft}px` }}
          onClick={() => {
            props.onSelectEntry(entry);
            props.onToggleDirectory(entry.path);
          }}
          onDragOver={(event) => props.onDirectoryDragOver(event, entry.path)}
          onDragLeave={(event) => props.onDirectoryDragLeave(event, entry.path)}
          onDrop={(event) => props.onDirectoryDrop(event, entry.path)}
        >
          <ChevronRightIcon
            className={cn("size-3.5 shrink-0 transition-transform", props.expanded && "rotate-90")}
          />
          {props.loading ? (
            <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-muted-foreground/70" />
          ) : props.expanded ? (
            <VscodeEntryIcon
              pathValue={entry.path}
              kind="directory"
              theme={resolvedTheme}
              className="size-3.5"
            />
          ) : (
            <FolderClosedIcon className="size-3.5 shrink-0 text-muted-foreground/70" />
          )}
          <span className="truncate text-xs font-medium">{entry.name}</span>
        </button>
        {props.expanded ? <div className="space-y-0.5">{props.children}</div> : null}
      </div>
    );
  }

  return (
    // A row action cannot be nested inside the row's own button, so the file
    // row is a flex line holding the open-the-file button and the share control
    // side by side.
    <div className="group/entry flex w-full items-center pr-2">
      <button
        type="button"
        className={cn(
          "flex min-w-0 flex-1 items-center gap-1.5 rounded-md py-1 text-left transition-colors",
          props.selected
            ? "bg-accent text-accent-foreground"
            : "text-muted-foreground/80 hover:bg-accent/70 hover:text-foreground",
          props.changed && "text-foreground/90",
        )}
        style={{ paddingLeft: `${paddingLeft + 18}px` }}
        onClick={() => {
          props.onSelectEntry(entry);
          props.onOpenFile(entry.path);
        }}
      >
        <VscodeEntryIcon
          pathValue={entry.path}
          kind="file"
          theme={resolvedTheme}
          className="size-3.5"
        />
        <span className="truncate text-xs">{entry.name}</span>
        {props.author ? (
          <span
            className="ml-1 size-1.5 shrink-0 rounded-full"
            style={{
              backgroundColor: props.authorColorValue || authorColor(props.author.userId),
            }}
            title={`Last changed by ${props.author.displayName}`}
            data-testid="workspace-entry-author"
            data-author={props.author.displayName}
          />
        ) : null}
        {props.changed || props.status ? (
          <span
            className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[10px] tabular-nums"
            data-workspace-entry-diff-state={entry.path}
          >
            {props.status ? <FileStatusBadge status={props.status} /> : null}
            {props.diffStat && hasNonZeroStat(props.diffStat) ? (
              <DiffStatLabel
                additions={props.diffStat.additions}
                deletions={props.diffStat.deletions}
              />
            ) : props.changed && !props.status ? (
              <span className="text-primary/80">changed</span>
            ) : null}
          </span>
        ) : null}
      </button>
      {props.onCopyShareLink ? (
        <ShareFileLinkButton
          relativePath={entry.path}
          onCopyShareLink={props.onCopyShareLink}
          className="ml-1"
        />
      ) : null}
    </div>
  );
});

interface WorkspacePanelProps {
  mode?: WorkspacePanelMode;
  onClose?: () => void;
  onOpenDiff?: () => void;
}

type WorkspaceFileViewMode = "editor" | "diff";

const WorkspaceAcceptedDiffStateSchema = Schema.Struct({
  source: Schema.Literals(["working-tree", "checkpoint"]),
  sessionKey: Schema.String,
  visibilityKey: Schema.String,
});
const WorkspaceAcceptedDiffStateByPathSchema = Schema.Record(
  Schema.String,
  WorkspaceAcceptedDiffStateSchema,
);
const WorkspaceDiffReviewStateSchema = Schema.Struct({
  acceptedHunkIds: Schema.Array(Schema.String),
  selectedHunkId: Schema.NullOr(Schema.String),
});
const WorkspaceDiffReviewStateByKeySchema = Schema.Record(
  Schema.String,
  WorkspaceDiffReviewStateSchema,
);
type WorkspaceDiffReviewState = typeof WorkspaceDiffReviewStateSchema.Type;

function buildWorkspaceReviewStorageScopeKey(input: {
  environmentId: string | null;
  workspaceRoot: string | null;
  projectId?: string | null;
  threadId?: string | null;
}): string {
  const normalizedWorkspaceRoot = input.workspaceRoot?.replaceAll("\\", "/") ?? "none";

  if (input.environmentId && input.threadId) {
    return `thread:${input.environmentId}:${input.threadId}`;
  }

  if (input.environmentId && input.projectId) {
    return `project:${input.environmentId}:${input.projectId}`;
  }

  if (input.environmentId) {
    return `workspace:${input.environmentId}:${normalizedWorkspaceRoot}`;
  }

  return "inactive";
}

export default function WorkspacePanel({
  mode = "inline",
  onClose,
  onOpenDiff,
}: WorkspacePanelProps) {
  // Before anything can mount an editor.
  useLocalMonaco();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const { resolvedTheme } = useTheme();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const routeProjectRef = useParams({
    strict: false,
    select: (params) => resolveProjectRouteRef(params),
  });
  const routeDraftId = useParams({
    strict: false,
    select: (params) => (typeof params.draftId === "string" ? DraftId.make(params.draftId) : null),
  });
  const draftSession = useComposerDraftStore((store) =>
    routeDraftId ? store.getDraftSession(routeDraftId) : null,
  );
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProject = useStore((store) => {
    if (activeThread) {
      return selectProjectByRef(store, {
        environmentId: activeThread.environmentId,
        projectId: activeThread.projectId,
      });
    }
    if (draftSession) {
      return selectProjectByRef(store, {
        environmentId: draftSession.environmentId,
        projectId: draftSession.projectId,
      });
    }
    return selectProjectByRef(store, routeProjectRef);
  });
  const activeEnvironmentId =
    activeThread?.environmentId ??
    draftSession?.environmentId ??
    activeProject?.environmentId ??
    null;
  const activeWorkspaceRoot =
    activeThread?.worktreePath ?? draftSession?.worktreePath ?? activeProject?.cwd ?? null;
  const workspaceReviewStorageScopeKey = useMemo(
    () =>
      buildWorkspaceReviewStorageScopeKey({
        environmentId: activeEnvironmentId,
        workspaceRoot: activeWorkspaceRoot,
        projectId: activeProject?.id ?? null,
        threadId: activeThread?.id ?? null,
      }),
    [activeEnvironmentId, activeProject?.id, activeThread?.id, activeWorkspaceRoot],
  );
  const collaborationGovernance = useCollaborationGovernance({
    environmentId: activeEnvironmentId,
    tenantId: activeProject?.ownership?.tenantId ?? null,
    workspaceId: activeProject?.ownership?.workspaceId ?? null,
  });
  // "Collaboration off" is a personal filter, so other people's marks simply
  // stop being drawn for this viewer.
  const workspaceAuthorByPath =
    collaborationGovernance.preferences?.showOthersFiles === false
      ? EMPTY_WORKSPACE_AUTHORS
      : collaborationGovernance.touchesByPath;
  const workspaceAuthorColors = collaborationGovernance.memberColorByUserId;
  const workspaceLabel = activeWorkspaceRoot ? basenameOfPath(activeWorkspaceRoot) : "Workspace";
  const workspaceScopeLabel = activeThread?.worktreePath ? "Thread workspace" : "Project workspace";
  const activeRunningTurnId =
    activeThread?.session?.orchestrationStatus === "running" && activeThread.session.activeTurnId
      ? activeThread.session.activeTurnId
      : null;
  const activeRunningTurnKey =
    activeRunningTurnId !== null && activeThread
      ? `${activeThread.environmentId}:${activeThread.id}:${activeRunningTurnId}`
      : null;
  const gitStatus = useGitStatus({
    environmentId: activeEnvironmentId,
    cwd: activeWorkspaceRoot,
  });
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const workspaceAgentDiffIndex = useMemo(
    () => buildWorkspaceAgentDiffIndex(turnDiffSummaries, inferredCheckpointTurnCountByTurnId),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );
  const workspaceAgentDiffHistoryByPath = workspaceAgentDiffIndex.fileHistoryByPath;
  const workspaceAgentDiffTurnFilesByTurnId = workspaceAgentDiffIndex.turnFilesByTurnId;
  const currentWorkspaceWorkingTreeFiles = useMemo(
    () =>
      gitStatus.data?.isRepo
        ? gitStatus.data.workingTree.files.filter((file) => isWorkspaceRelativePath(file.path))
        : EMPTY_WORKSPACE_WORKING_TREE_FILES,
    [gitStatus.data?.isRepo, gitStatus.data?.workingTree.files],
  );
  const currentWorkspaceWorkingTreeFilesRef = useRef(currentWorkspaceWorkingTreeFiles);
  currentWorkspaceWorkingTreeFilesRef.current = currentWorkspaceWorkingTreeFiles;
  const workingTreeStatusByPath = useMemo(() => {
    const map = new Map<string, GitWorkingTreeFileStatus>();
    for (const file of currentWorkspaceWorkingTreeFiles) {
      map.set(file.path.replaceAll("\\", "/"), file.status);
    }
    return map;
  }, [currentWorkspaceWorkingTreeFiles]);
  const hasCurrentGitStatusSnapshotRef = useRef(gitStatus.data !== null);
  hasCurrentGitStatusSnapshotRef.current = gitStatus.data !== null;
  // The server only publishes a status it considers changed, so a new object
  // here is the cheapest honest signal that the diffs are worth re-fetching.
  const gitStatusDataRef = useRef(gitStatus.data);
  gitStatusDataRef.current = gitStatus.data;
  const gitStatusIsRepoRef = useRef(Boolean(gitStatus.data?.isRepo));
  gitStatusIsRepoRef.current = Boolean(gitStatus.data?.isRepo);
  const lastCommittedGitStatusSnapshotRef = useRef<WorkspaceGitStatusSnapshot | null>(
    gitStatus.data !== null
      ? {
          isRepo: Boolean(gitStatus.data.isRepo),
          files: currentWorkspaceWorkingTreeFiles,
        }
      : null,
  );
  const previousRunningTurnKeyRef = useRef<string | null>(activeRunningTurnKey);
  const workspaceRootRef = useRef(activeWorkspaceRoot);
  workspaceRootRef.current = activeWorkspaceRoot;

  const [directoryEntriesByPath, setDirectoryEntriesByPath] = useState<
    Record<string, ReadonlyArray<ProjectDirectoryEntry>>
  >({});
  const [loadingDirectoriesByPath, setLoadingDirectoriesByPath] = useState<Record<string, boolean>>(
    {},
  );
  const [expandedDirectoriesByPath, setExpandedDirectoriesByPath] = useState<
    Record<string, boolean>
  >({});
  const [selectedEntry, setSelectedEntry] = useState<{
    path: string | null;
    kind: "file" | "directory" | null;
  }>({
    path: null,
    kind: null,
  });
  const [compactExplorerOpen, setCompactExplorerOpen] = useState(true);
  const [shareLinksOpen, setShareLinksOpen] = useState(false);
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [savingFilePath, setSavingFilePath] = useState<string | null>(null);
  const [uploadingDirectoryPath, setUploadingDirectoryPath] = useState<string | null>(null);
  const [dropTargetDirectoryPath, setDropTargetDirectoryPath] = useState<string | null>(null);
  const [fileStateByPath, setFileStateByPath] = useState<Record<string, ProjectReadFileResult>>({});
  const [draftByPath, setDraftByPath] = useState<Record<string, string>>({});
  const [selectedDiffTurnId, setSelectedDiffTurnId] = useState<TurnId | null>(null);
  const [acceptedDiffStateByPath, setAcceptedDiffStateByPath] = useLocalStorage(
    `${WORKSPACE_ACCEPTED_DIFF_STORAGE_PREFIX}:${workspaceReviewStorageScopeKey}`,
    {},
    WorkspaceAcceptedDiffStateByPathSchema,
  );
  const [diffReviewStateByKey, setDiffReviewStateByKey] = useLocalStorage(
    `${WORKSPACE_DIFF_REVIEW_STORAGE_PREFIX}:${workspaceReviewStorageScopeKey}`,
    {},
    WorkspaceDiffReviewStateByKeySchema,
  );
  const [fileViewModeByPath, setFileViewModeByPath] = useState<
    Record<string, WorkspaceFileViewMode>
  >({});
  const [createDialogState, setCreateDialogState] = useState<{
    open: boolean;
    kind: ProjectCreateEntryInput["kind"];
    name: string;
  }>({
    open: false,
    kind: "file",
    name: "",
  });
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const fileStateByPathRef = useRef(fileStateByPath);
  fileStateByPathRef.current = fileStateByPath;
  const draftByPathRef = useRef(draftByPath);
  draftByPathRef.current = draftByPath;
  const openTabsRef = useRef(openTabs);
  openTabsRef.current = openTabs;
  const expandedDirectoriesByPathRef = useRef(expandedDirectoriesByPath);
  expandedDirectoriesByPathRef.current = expandedDirectoriesByPath;
  // A gate per workspace: what it remembers about a directory is meaningless
  // once the tree is pointing somewhere else.
  const directoryRelistTargetKey = `${activeEnvironmentId ?? ""}:${activeWorkspaceRoot ?? ""}`;
  const directoryRelistGateRef = useRef<{
    targetKey: string;
    gate: WorkspaceDirectoryRelistGate;
  }>({ targetKey: directoryRelistTargetKey, gate: createWorkspaceDirectoryRelistGate() });
  if (directoryRelistGateRef.current.targetKey !== directoryRelistTargetKey) {
    directoryRelistGateRef.current = {
      targetKey: directoryRelistTargetKey,
      gate: createWorkspaceDirectoryRelistGate(),
    };
  }
  const workspaceTurnIsRunningRef = useRef(false);
  workspaceTurnIsRunningRef.current = activeThread?.session?.orchestrationStatus === "running";
  const activeFileState = activeFilePath ? (fileStateByPath[activeFilePath] ?? null) : null;
  const activeFileDraft =
    activeFilePath && activeFileState && !activeFileState.isBinary && !activeFileState.tooLarge
      ? (draftByPath[activeFilePath] ?? activeFileState.contents)
      : "";
  const observedWorkspaceDiffSignatureRef = useRef("");
  const hasObservedWorkspaceDiffBaselineRef = useRef(false);
  const observedLiveWorkspaceDiffSignatureRef = useRef("");
  const hasObservedLiveWorkspaceDiffBaselineRef = useRef(false);
  const workspaceFilesErrorToastRef = useRef<{ message: string; shownAt: number } | null>(null);
  const [liveDiffBaselineTurnKey, setLiveDiffBaselineTurnKey] = useState<string | null>(null);
  const liveDiffBaselinePendingTurnKeyRef = useRef<string | null>(null);
  const [liveDiffBaselineFiles, setLiveDiffBaselineFiles] = useState<
    ReadonlyArray<WorkspaceWorkingTreeFileStat>
  >(EMPTY_WORKSPACE_WORKING_TREE_FILES);
  const [liveDiffBaselineSource, setLiveDiffBaselineSource] =
    useState<WorkspaceLiveDiffBaselineSource | null>(null);
  const latestRunningLiveDiffRef = useRef<WorkspaceCompletedLiveDiffState | null>(null);
  const [completedLiveDiffState, setCompletedLiveDiffState] =
    useState<WorkspaceCompletedLiveDiffState | null>(null);

  const loadDirectory = useCallback(
    async (directoryPath: string | null, options?: { force?: boolean; silent?: boolean }) => {
      if (!activeEnvironmentId || !activeWorkspaceRoot) {
        return;
      }

      const key = directoryKey(directoryPath);
      // A background re-list shows no spinner and stays quiet on failure, or a
      // polled directory would blink and toast every few seconds.
      const silent = options?.silent ?? false;
      if (!silent) {
        setLoadingDirectoriesByPath((current) => ({ ...current, [key]: true }));
      }

      try {
        const result = await queryClient.fetchQuery(
          workspaceListDirectoryQueryOptions({
            environmentId: activeEnvironmentId,
            cwd: activeWorkspaceRoot,
            ...(options?.force ? { staleTime: 0 } : {}),
            ...(directoryPath ? { directoryPath } : {}),
          }),
        );

        if (workspaceRootRef.current !== activeWorkspaceRoot) {
          return;
        }

        setDirectoryEntriesByPath((current) => {
          const previous = current[key];
          if (previous && directoryEntriesMatch(previous, result.entries)) {
            return current;
          }
          return {
            ...current,
            [key]: result.entries,
          };
        });
      } catch (error) {
        if (silent) {
          return;
        }
        const description =
          error instanceof Error ? error.message : "An unexpected error occurred.";
        const previousToast = workspaceFilesErrorToastRef.current;
        const now = Date.now();
        if (
          !previousToast ||
          previousToast.message !== description ||
          now - previousToast.shownAt > 15_000
        ) {
          workspaceFilesErrorToastRef.current = { message: description, shownAt: now };
          toastManager.add({
            type: "error",
            title: "Could not load workspace files",
            description,
          });
        }
      } finally {
        if (!silent) {
          setLoadingDirectoriesByPath((current) => {
            const next = { ...current };
            delete next[key];
            return next;
          });
        }
      }
    },
    [activeEnvironmentId, activeWorkspaceRoot, queryClient],
  );

  const loadFile = useCallback(
    async (
      relativePath: string,
      options?: {
        force?: boolean;
        suppressErrorToast?: boolean;
      },
    ) => {
      if (!activeEnvironmentId || !activeWorkspaceRoot) {
        return;
      }

      setLoadingFilePath(relativePath);

      try {
        const result = await queryClient.fetchQuery(
          workspaceReadFileQueryOptions({
            environmentId: activeEnvironmentId,
            cwd: activeWorkspaceRoot,
            relativePath,
            ...(options?.force ? { staleTime: 0 } : {}),
          }),
        );

        if (workspaceRootRef.current !== activeWorkspaceRoot) {
          return;
        }

        const previousFileState = fileStateByPathRef.current[relativePath];
        const existingDraft = draftByPathRef.current[relativePath];
        const hasUnsavedLocalEdits =
          existingDraft !== undefined &&
          previousFileState !== undefined &&
          !previousFileState.isBinary &&
          !previousFileState.tooLarge &&
          existingDraft !== previousFileState.contents;

        setFileStateByPath((current) => ({
          ...current,
          [relativePath]: result,
        }));
        setDraftByPath((current) => {
          if (result.isBinary || result.tooLarge || hasUnsavedLocalEdits) {
            return current;
          }
          if (current[relativePath] === result.contents) {
            return current;
          }
          return {
            ...current,
            [relativePath]: result.contents,
          };
        });
      } catch (error) {
        if (!options?.suppressErrorToast) {
          toastManager.add({
            type: "error",
            title: "Could not open file",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          });
        }
      } finally {
        setLoadingFilePath((current) => (current === relativePath ? null : current));
      }
    },
    [activeEnvironmentId, activeWorkspaceRoot, queryClient],
  );

  useEffect(() => {
    setDirectoryEntriesByPath({});
    setLoadingDirectoriesByPath({});
    setExpandedDirectoriesByPath({});
    setSelectedEntry({ path: null, kind: null });
    setCompactExplorerOpen(true);
    setOpenTabs([]);
    setActiveFilePath(null);
    setLoadingFilePath(null);
    setSavingFilePath(null);
    setUploadingDirectoryPath(null);
    setDropTargetDirectoryPath(null);
    setFileStateByPath({});
    setDraftByPath({});
    setSelectedDiffTurnId(null);
    setFileViewModeByPath({});
    setLiveDiffBaselineTurnKey(null);
    liveDiffBaselinePendingTurnKeyRef.current = null;
    setLiveDiffBaselineFiles(EMPTY_WORKSPACE_WORKING_TREE_FILES);
    setLiveDiffBaselineSource(null);
    latestRunningLiveDiffRef.current = null;
    setCompletedLiveDiffState(null);
    observedWorkspaceDiffSignatureRef.current = "";
    hasObservedWorkspaceDiffBaselineRef.current = false;
    observedLiveWorkspaceDiffSignatureRef.current = "";
    hasObservedLiveWorkspaceDiffBaselineRef.current = false;

    if (!activeWorkspaceRoot) {
      return;
    }

    setExpandedDirectoriesByPath({ [ROOT_DIRECTORY_KEY]: true });
    setSelectedEntry({ path: null, kind: "directory" });
    void loadDirectory(null);
  }, [activeWorkspaceRoot, loadDirectory, workspaceReviewStorageScopeKey]);

  const openFile = useCallback(
    (relativePath: string) => {
      setOpenTabs((current) =>
        current.includes(relativePath) ? current : [...current, relativePath],
      );
      setActiveFilePath(relativePath);
      setSelectedEntry({ path: relativePath, kind: "file" });
      if (!fileStateByPath[relativePath]) {
        void loadFile(relativePath);
      }
    },
    [fileStateByPath, loadFile],
  );

  const toggleDirectory = useCallback(
    (directoryPath: string) => {
      setExpandedDirectoriesByPath((current) => {
        const key = directoryKey(directoryPath);
        const nextExpanded = !(current[key] ?? false);
        const next = { ...current, [key]: nextExpanded };
        if (!nextExpanded) {
          delete next[key];
        }
        return next;
      });

      const key = directoryKey(directoryPath);
      if (!directoryEntriesByPath[key]) {
        void loadDirectory(directoryPath);
      }
    },
    [directoryEntriesByPath, loadDirectory],
  );

  /**
   * The one way the tree gets re-listed. The poll, the refresh button, a turn
   * boundary and every move of the diff signature all come through here, so
   * the gate can stop them fanning out over the same folders at once.
   */
  const refreshExpandedDirectories = useCallback(
    (options?: { silent?: boolean; immediate?: boolean }) => {
      const directoryKeys = Object.keys(expandedDirectoriesByPathRef.current);
      if (directoryKeys.length === 0) {
        return;
      }

      const gate = directoryRelistGateRef.current.gate;
      const claimedKeys = gate.claim(directoryKeys, {
        now: Date.now(),
        ...(options?.immediate ? { immediate: true } : {}),
      });
      if (claimedKeys.length === 0) {
        return;
      }

      void Promise.all(
        claimedKeys.map((directoryKeyValue) =>
          loadDirectory(directoryKeyValue === ROOT_DIRECTORY_KEY ? null : directoryKeyValue, {
            force: true,
            ...(options?.silent ? { silent: true } : {}),
          }),
        ),
      )
        .catch(() => undefined)
        .finally(() => gate.release(claimedKeys));
    },
    [loadDirectory],
  );

  useLayoutEffect(() => {
    if (activeRunningTurnKey === null) {
      if (liveDiffBaselineTurnKey !== null) {
        setLiveDiffBaselineTurnKey(null);
        setLiveDiffBaselineFiles(EMPTY_WORKSPACE_WORKING_TREE_FILES);
      }
      liveDiffBaselinePendingTurnKeyRef.current = null;
      return;
    }

    if (
      liveDiffBaselineTurnKey === activeRunningTurnKey ||
      liveDiffBaselinePendingTurnKeyRef.current === activeRunningTurnKey ||
      !activeEnvironmentId ||
      !activeWorkspaceRoot
    ) {
      return;
    }

    const committedBaselineSnapshot =
      previousRunningTurnKeyRef.current !== activeRunningTurnKey
        ? lastCommittedGitStatusSnapshotRef.current
        : null;
    const pendingDispatchBaseline =
      activeThread !== undefined
        ? takePendingWorkspaceLiveDiffBaselineForThread({
            environmentId: activeThread.environmentId,
            threadId: activeThread.id,
            cwd: activeWorkspaceRoot,
          })
        : null;
    const immediateBaselineFiles =
      pendingDispatchBaseline !== null
        ? pendingDispatchBaseline.isRepo
          ? pendingDispatchBaseline.files
          : EMPTY_WORKSPACE_WORKING_TREE_FILES
        : committedBaselineSnapshot !== null
          ? committedBaselineSnapshot.isRepo
            ? committedBaselineSnapshot.files
            : EMPTY_WORKSPACE_WORKING_TREE_FILES
          : hasCurrentGitStatusSnapshotRef.current
            ? gitStatusIsRepoRef.current
              ? currentWorkspaceWorkingTreeFilesRef.current
              : EMPTY_WORKSPACE_WORKING_TREE_FILES
            : null;
    const immediateBaselineSource: WorkspaceLiveDiffBaselineSource | null =
      pendingDispatchBaseline !== null
        ? "pending"
        : committedBaselineSnapshot !== null || hasCurrentGitStatusSnapshotRef.current
          ? "status"
          : null;

    if (immediateBaselineFiles !== null) {
      setLiveDiffBaselineFiles(immediateBaselineFiles);
      setLiveDiffBaselineSource(immediateBaselineSource ?? "status");
      setLiveDiffBaselineTurnKey(activeRunningTurnKey);
      liveDiffBaselinePendingTurnKeyRef.current = null;
    } else {
      setLiveDiffBaselineTurnKey(null);
      liveDiffBaselinePendingTurnKeyRef.current = activeRunningTurnKey;
      setLiveDiffBaselineFiles(EMPTY_WORKSPACE_WORKING_TREE_FILES);
      setLiveDiffBaselineSource(null);
    }

    let cancelled = false;

    void refreshGitStatus({
      environmentId: activeEnvironmentId,
      cwd: activeWorkspaceRoot,
    })
      .then((refreshedStatus) => {
        if (cancelled || immediateBaselineFiles !== null) {
          return;
        }

        const baselineFiles = refreshedStatus?.isRepo
          ? refreshedStatus.workingTree.files
          : gitStatusIsRepoRef.current
            ? currentWorkspaceWorkingTreeFilesRef.current
            : EMPTY_WORKSPACE_WORKING_TREE_FILES;
        setLiveDiffBaselineFiles(baselineFiles);
        setLiveDiffBaselineSource("status");
        setLiveDiffBaselineTurnKey(activeRunningTurnKey);
        if (liveDiffBaselinePendingTurnKeyRef.current === activeRunningTurnKey) {
          liveDiffBaselinePendingTurnKeyRef.current = null;
        }
      })
      .catch(() => {
        if (cancelled || immediateBaselineFiles !== null) {
          return;
        }

        const baselineFiles = gitStatusIsRepoRef.current
          ? currentWorkspaceWorkingTreeFilesRef.current
          : EMPTY_WORKSPACE_WORKING_TREE_FILES;
        setLiveDiffBaselineFiles(baselineFiles);
        setLiveDiffBaselineSource("status");
        setLiveDiffBaselineTurnKey(activeRunningTurnKey);
        if (liveDiffBaselinePendingTurnKeyRef.current === activeRunningTurnKey) {
          liveDiffBaselinePendingTurnKeyRef.current = null;
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeEnvironmentId,
    activeRunningTurnKey,
    activeThread,
    activeWorkspaceRoot,
    liveDiffBaselineTurnKey,
  ]);

  useLayoutEffect(() => {
    previousRunningTurnKeyRef.current = activeRunningTurnKey;
    if (gitStatus.data !== null) {
      lastCommittedGitStatusSnapshotRef.current = {
        isRepo: Boolean(gitStatus.data.isRepo),
        files: currentWorkspaceWorkingTreeFiles,
      };
    }
  }, [activeRunningTurnKey, currentWorkspaceWorkingTreeFiles, gitStatus.data]);

  const liveWorkspaceDiffStatByPath = useMemo(() => {
    if (
      activeRunningTurnKey === null ||
      liveDiffBaselineTurnKey !== activeRunningTurnKey ||
      !gitStatus.data?.isRepo
    ) {
      return EMPTY_WORKSPACE_DIFF_STAT_MAP;
    }

    return buildWorkspaceLiveTurnDiffStatByPath(
      currentWorkspaceWorkingTreeFiles,
      liveDiffBaselineFiles,
    );
  }, [
    activeRunningTurnKey,
    currentWorkspaceWorkingTreeFiles,
    gitStatus.data?.isRepo,
    liveDiffBaselineFiles,
    liveDiffBaselineTurnKey,
  ]);
  useEffect(() => {
    if (activeRunningTurnId !== null && activeRunningTurnKey !== null) {
      const runningLiveDiffState: WorkspaceCompletedLiveDiffState = {
        turnId: activeRunningTurnId,
        turnKey: activeRunningTurnKey,
        source: liveDiffBaselineSource ?? "status",
        statByPath: liveWorkspaceDiffStatByPath,
      };
      latestRunningLiveDiffRef.current = runningLiveDiffState;
      setCompletedLiveDiffState((current) => (current === null ? current : null));
      return;
    }

    const latestRunningLiveDiff = latestRunningLiveDiffRef.current;
    if (!latestRunningLiveDiff) {
      setCompletedLiveDiffState((current) => (current === null ? current : null));
      return;
    }

    if (latestRunningLiveDiff.statByPath.size === 0) {
      latestRunningLiveDiffRef.current = null;
      setCompletedLiveDiffState((current) => (current === null ? current : null));
      return;
    }

    setCompletedLiveDiffState((current) => {
      if (current?.turnKey === latestRunningLiveDiff.turnKey) {
        return current;
      }
      return latestRunningLiveDiff;
    });
  }, [
    activeRunningTurnId,
    activeRunningTurnKey,
    liveDiffBaselineSource,
    liveWorkspaceDiffStatByPath,
  ]);

  useEffect(() => {
    if (mode === "compact" && !activeFilePath) {
      setCompactExplorerOpen(true);
    }
  }, [activeFilePath, mode]);

  const dirtyFilePathSet = useMemo(() => {
    const dirtyPaths = new Set<string>();
    for (const tabPath of openTabs) {
      const fileState = fileStateByPath[tabPath];
      if (!fileState || fileState.isBinary || fileState.tooLarge) {
        continue;
      }
      const draft = draftByPath[tabPath];
      if (draft !== undefined && draft !== fileState.contents) {
        dirtyPaths.add(tabPath);
      }
    }
    return dirtyPaths;
  }, [draftByPath, fileStateByPath, openTabs]);
  const dirtyFilePathSetRef = useRef(dirtyFilePathSet);
  dirtyFilePathSetRef.current = dirtyFilePathSet;
  const refreshCleanOpenFiles = useCallback(
    (options?: { suppressErrorToast?: boolean }) => {
      for (const filePath of openTabsRef.current) {
        if (dirtyFilePathSetRef.current.has(filePath)) {
          continue;
        }

        const loadFileOptions =
          options?.suppressErrorToast === undefined
            ? { force: true }
            : { force: true, suppressErrorToast: options.suppressErrorToast };
        void loadFile(filePath, loadFileOptions);
      }
    },
    [loadFile],
  );
  const refreshWorkspace = useCallback(() => {
    if (!activeEnvironmentId || !activeWorkspaceRoot) {
      return;
    }

    void refreshGitStatus({
      environmentId: activeEnvironmentId,
      cwd: activeWorkspaceRoot,
    }).catch(() => undefined);
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.all,
    });
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
    });
    // Somebody pressed refresh: they get an answer, not the throttle.
    refreshExpandedDirectories({ immediate: true });
    refreshCleanOpenFiles();
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    queryClient,
    refreshCleanOpenFiles,
    refreshExpandedDirectories,
  ]);
  const pendingWorkspaceLiveDiffBaseline =
    activeThread && activeWorkspaceRoot
      ? peekPendingWorkspaceLiveDiffBaselineForThread({
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
          cwd: activeWorkspaceRoot,
        })
      : null;
  const hasPendingWorkspaceLiveDiffBaseline = pendingWorkspaceLiveDiffBaseline !== null;
  const pendingWorkspaceDiffStatByPath = useMemo(() => {
    if (
      activeRunningTurnKey !== null ||
      !pendingWorkspaceLiveDiffBaseline?.isRepo ||
      !gitStatus.data?.isRepo
    ) {
      return EMPTY_WORKSPACE_DIFF_STAT_MAP;
    }

    return buildWorkspaceLiveTurnDiffStatByPath(
      currentWorkspaceWorkingTreeFiles,
      pendingWorkspaceLiveDiffBaseline.files,
    );
  }, [
    activeRunningTurnKey,
    currentWorkspaceWorkingTreeFiles,
    gitStatus.data?.isRepo,
    pendingWorkspaceLiveDiffBaseline,
  ]);
  const shouldUsePendingWorkspaceReview =
    activeRunningTurnKey === null && hasPendingWorkspaceLiveDiffBaseline;
  const activeLatestTurnId = activeThread?.latestTurn?.turnId ?? null;
  const activeLatestTurnKey =
    activeLatestTurnId !== null && activeThread
      ? `${activeThread.environmentId}:${activeThread.id}:${activeLatestTurnId}`
      : null;
  useEffect(() => {
    if (
      activeRunningTurnKey !== null ||
      !activeEnvironmentId ||
      !activeWorkspaceRoot ||
      !hasPendingWorkspaceLiveDiffBaseline ||
      !activeThread?.latestTurn?.completedAt
    ) {
      return;
    }

    void refreshGitStatus({
      environmentId: activeEnvironmentId,
      cwd: activeWorkspaceRoot,
    }).catch(() => undefined);
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.all,
    });
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
    });
  }, [
    activeEnvironmentId,
    activeRunningTurnKey,
    activeThread?.latestTurn?.completedAt,
    activeWorkspaceRoot,
    hasPendingWorkspaceLiveDiffBaseline,
    queryClient,
  ]);
  const activeFileDiffHistory = activeFilePath
    ? (workspaceAgentDiffHistoryByPath.get(activeFilePath) ?? EMPTY_WORKSPACE_FILE_DIFF_HISTORY)
    : EMPTY_WORKSPACE_FILE_DIFF_HISTORY;
  const activeFilePendingWorkspaceDiffStat =
    activeFilePath !== null ? (pendingWorkspaceDiffStatByPath.get(activeFilePath) ?? null) : null;
  const activeFileCompletedLiveDiffStat =
    activeFilePath !== null
      ? (completedLiveDiffState?.statByPath.get(activeFilePath) ?? null)
      : null;
  const activeFileReviewCompletedLiveDiffStat = shouldUsePendingWorkspaceReview
    ? null
    : completedLiveDiffState?.source === "pending"
      ? activeFileCompletedLiveDiffStat
      : null;
  const activeFileDirty = activeFilePath ? dirtyFilePathSet.has(activeFilePath) : false;
  const activeFileStatOnlyLiveDiffStat =
    activeFilePath !== null ? (liveWorkspaceDiffStatByPath.get(activeFilePath) ?? null) : null;
  const activeFileBaselineDiffSignature =
    activeFilePath !== null
      ? (liveDiffBaselineFiles.find((file) => file.path.replaceAll("\\", "/") === activeFilePath)
          ?.diffSignature ??
        pendingWorkspaceLiveDiffBaseline?.files.find(
          (file) => file.path.replaceAll("\\", "/") === activeFilePath,
        )?.diffSignature ??
        null)
      : null;
  const activeFileMayHavePatchOnlyLiveDiff = activeFileBaselineDiffSignature !== null;
  const {
    activeDiffQuery: activeWorkingTreeDiffQuery,
    diffError: activeWorkingTreeDiffError,
    renderableFile: activeWorkingTreeRenderableFile,
    renderablePatch: activeWorkingTreeRenderablePatch,
  } = useWorkspaceWorkingTreeDiff({
    environmentId: activeEnvironmentId,
    cwd: activeWorkspaceRoot,
    relativePath: activeFilePath,
    resolvedTheme,
    cacheScope: "workspace-working-tree",
    enabled:
      activeFilePath !== null &&
      !activeFileDirty &&
      (activeFileStatOnlyLiveDiffStat !== null ||
        activeFileReviewCompletedLiveDiffStat !== null ||
        activeFileMayHavePatchOnlyLiveDiff),
  });
  useEffect(() => {
    if (
      !activeFileMayHavePatchOnlyLiveDiff ||
      !activeEnvironmentId ||
      !activeWorkspaceRoot ||
      !activeFilePath
    ) {
      return;
    }

    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiff(
        activeEnvironmentId,
        activeWorkspaceRoot,
        activeFilePath,
      ),
    });
  }, [
    activeEnvironmentId,
    activeFileMayHavePatchOnlyLiveDiff,
    activeFilePath,
    activeWorkspaceRoot,
    currentWorkspaceWorkingTreeFiles,
    queryClient,
  ]);
  const activeFilePatchOnlyLiveDiffStat = useMemo(() => {
    if (activeFilePath === null || activeFileBaselineDiffSignature === null) {
      return null;
    }

    const currentDiff = activeWorkingTreeDiffQuery.data?.diff;
    if (currentDiff === undefined) {
      return null;
    }

    const currentDiffSignature = hashWorkspaceChangeText(currentDiff);
    if (currentDiffSignature === activeFileBaselineDiffSignature) {
      return null;
    }

    const currentFile = currentWorkspaceWorkingTreeFiles.find(
      (file) => file.path.replaceAll("\\", "/") === activeFilePath,
    );
    return {
      additions: currentFile?.insertions ?? 0,
      deletions: currentFile?.deletions ?? 0,
      diffSignature: currentDiffSignature,
    };
  }, [
    activeFileBaselineDiffSignature,
    activeFilePath,
    activeWorkingTreeDiffQuery.data?.diff,
    currentWorkspaceWorkingTreeFiles,
  ]);
  const activeFileLiveDiffStat =
    activeFilePatchOnlyLiveDiffStat ??
    activeFileStatOnlyLiveDiffStat ??
    activeFilePendingWorkspaceDiffStat ??
    activeFileReviewCompletedLiveDiffStat;
  const activeFileLiveDiffTurnId =
    activeRunningTurnId ??
    (activeFilePendingWorkspaceDiffStat || activeFilePatchOnlyLiveDiffStat
      ? activeLatestTurnId
      : null) ??
    (activeFileReviewCompletedLiveDiffStat ? (completedLiveDiffState?.turnId ?? null) : null) ??
    null;
  const activeFileLiveDiffTurnKey =
    activeRunningTurnKey ??
    (activeFilePendingWorkspaceDiffStat || activeFilePatchOnlyLiveDiffStat
      ? activeLatestTurnKey
      : null) ??
    (activeFileReviewCompletedLiveDiffStat ? (completedLiveDiffState?.turnKey ?? null) : null) ??
    (activeFilePath !== null && activeFileLiveDiffStat !== null
      ? `current:${workspaceReviewStorageScopeKey}`
      : null);
  const activeFileLiveDiffSessionKey =
    activeFilePath === null || !activeFileLiveDiffStat
      ? null
      : activeFileLiveDiffTurnId
        ? buildWorkspaceReviewSessionKey(activeFileLiveDiffTurnId, activeFilePath)
        : buildWorkspaceCurrentReviewSessionKey(workspaceReviewStorageScopeKey, activeFilePath);
  const activeFileHasLiveDiff = activeFileLiveDiffStat !== null;
  const selectedActiveDiffEntry =
    (selectedDiffTurnId
      ? activeFileDiffHistory.find((entry) => entry.turnId === selectedDiffTurnId)
      : undefined) ??
    activeFileDiffHistory[0] ??
    null;
  const activeVisibleDiffKey =
    activeFilePath === null
      ? null
      : activeFileHasLiveDiff && activeFileLiveDiffStat && activeFileLiveDiffTurnKey
        ? buildWorkspaceLiveDiffKey(
            activeFileLiveDiffTurnKey,
            activeFilePath,
            activeFileLiveDiffStat,
          )
        : selectedActiveDiffEntry
          ? buildWorkspaceCheckpointDiffKey(selectedActiveDiffEntry)
          : null;
  const activeVisibleDiffSessionKey =
    activeFilePath === null
      ? null
      : activeFileHasLiveDiff
        ? activeFileLiveDiffSessionKey
        : selectedActiveDiffEntry
          ? buildWorkspaceReviewSessionKey(selectedActiveDiffEntry.turnId, activeFilePath)
          : null;
  const {
    activeDiffQuery: activeInlineDiffQuery,
    diffError: activeInlineDiffError,
    renderableFile: activeInlineRenderableFile,
    renderablePatch: activeInlineRenderablePatch,
  } = useWorkspaceAgentTurnDiff({
    environmentId: activeThread?.environmentId ?? null,
    threadId: activeThread?.id ?? null,
    selectedHistoryEntry: selectedActiveDiffEntry,
    targetFilePath: activeFilePath,
    resolvedTheme,
    cacheScope: "workspace-inline",
    enabled: !activeFileHasLiveDiff,
  });
  const activeInlineDiffSource = activeFileHasLiveDiff
    ? "working-tree"
    : activeFileDiffHistory.length > 0
      ? "checkpoint"
      : null;
  const activeRenderableInlineFile =
    activeInlineDiffSource === "working-tree"
      ? activeWorkingTreeRenderableFile
      : activeInlineRenderableFile;
  const activeRenderableInlinePatch =
    activeInlineDiffSource === "working-tree"
      ? activeWorkingTreeRenderablePatch
      : activeInlineRenderablePatch;
  const activeInlineDiffErrorMessage =
    activeInlineDiffSource === "working-tree" ? activeWorkingTreeDiffError : activeInlineDiffError;
  const activeInlineDiffLoading =
    activeInlineDiffSource === "working-tree"
      ? activeWorkingTreeDiffQuery.isLoading
      : activeInlineDiffQuery.isLoading;
  const activeVisibleDiffReviewKey =
    activeInlineDiffSource === "working-tree"
      ? activeVisibleDiffKey
      : (activeVisibleDiffSessionKey ??
        (activeRenderableInlineFile !== null
          ? buildFileDiffRenderKey(activeRenderableInlineFile)
          : activeVisibleDiffKey));
  const activeReviewItems = useMemo(
    () =>
      activeRenderableInlineFile
        ? buildWorkspaceDiffReviewItems(
            activeRenderableInlineFile,
            activeVisibleDiffReviewKey ?? buildFileDiffRenderKey(activeRenderableInlineFile),
          )
        : EMPTY_WORKSPACE_DIFF_REVIEW_ITEMS,
    [activeRenderableInlineFile, activeVisibleDiffReviewKey],
  );
  const activeReviewState =
    activeVisibleDiffReviewKey !== null ? diffReviewStateByKey[activeVisibleDiffReviewKey] : null;
  const activeAcceptedHunkIdSet = useMemo(
    () => new Set(activeReviewState?.acceptedHunkIds ?? EMPTY_WORKSPACE_DIFF_REVIEW_IDS),
    [activeReviewState?.acceptedHunkIds],
  );
  const activeRemainingReviewItems = useMemo(
    () => activeReviewItems.filter((reviewItem) => !activeAcceptedHunkIdSet.has(reviewItem.id)),
    [activeAcceptedHunkIdSet, activeReviewItems],
  );
  const activeSelectedReviewItem = useMemo(() => {
    if (activeRemainingReviewItems.length === 0) {
      return null;
    }

    const selectedHunkId = activeReviewState?.selectedHunkId;
    if (selectedHunkId) {
      const selectedReviewItem =
        activeRemainingReviewItems.find((reviewItem) => reviewItem.id === selectedHunkId) ?? null;
      if (selectedReviewItem !== null) {
        return selectedReviewItem;
      }
    }

    return activeRemainingReviewItems[0] ?? null;
  }, [activeRemainingReviewItems, activeReviewState?.selectedHunkId]);
  const activeSelectedReviewPosition = activeSelectedReviewItem
    ? activeRemainingReviewItems.findIndex(
        (reviewItem) => reviewItem.id === activeSelectedReviewItem.id,
      ) + 1
    : 0;
  const activeVisibleDiffAccepted =
    activeFilePath !== null &&
    activeVisibleDiffKey !== null &&
    activeVisibleDiffSessionKey !== null &&
    activeInlineDiffSource !== null &&
    isWorkspaceDiffAccepted(acceptedDiffStateByPath[activeFilePath], {
      source: activeInlineDiffSource,
      sessionKey: activeVisibleDiffSessionKey,
      visibilityKey: activeVisibleDiffKey,
    });
  const activeVisibleDiffFullyAccepted =
    activeVisibleDiffAccepted ||
    (activeReviewItems.length > 0 && activeRemainingReviewItems.length === 0);
  const canShowActiveInlineDiff =
    activeFilePath !== null &&
    !activeFileDirty &&
    (activeFileHasLiveDiff || activeFileDiffHistory.length > 0) &&
    !activeVisibleDiffFullyAccepted;
  const activeFileViewMode =
    activeFilePath &&
    !activeFileDirty &&
    (activeFileHasLiveDiff || activeFileDiffHistory.length > 0) &&
    !activeVisibleDiffFullyAccepted
      ? (fileViewModeByPath[activeFilePath] ?? "diff")
      : "editor";
  const activeFocusedInlineFile =
    activeRenderableInlineFile !== null && activeSelectedReviewItem !== null
      ? buildWorkspaceFocusedFileDiff(activeRenderableInlineFile, activeSelectedReviewItem)
      : activeRenderableInlineFile;
  const currentWorkspaceReviewSessionFiles = useMemo<
    ReadonlyArray<WorkspaceReviewFileEntry>
  >(() => {
    if (activeRunningTurnKey !== null) {
      return Array.from(liveWorkspaceDiffStatByPath.entries())
        .filter(([pathValue]) => isWorkspaceRelativePath(pathValue))
        .map(([pathValue, stat]) => ({
          path: pathValue,
          source: "working-tree" as const,
          sessionKey:
            activeRunningTurnId !== null
              ? buildWorkspaceReviewSessionKey(activeRunningTurnId, pathValue)
              : "",
          visibilityKey: buildWorkspaceLiveDiffKey(activeRunningTurnKey, pathValue, stat),
          stat,
        }))
        .filter(
          (entry) =>
            activeRunningTurnId !== null &&
            !isWorkspaceDiffAccepted(acceptedDiffStateByPath[entry.path], entry),
        )
        .toSorted((left, right) =>
          left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
        );
    }

    if (shouldUsePendingWorkspaceReview) {
      const pendingTurnKey =
        activeLatestTurnKey ?? `current:${workspaceReviewStorageScopeKey}:pending`;
      return Array.from(pendingWorkspaceDiffStatByPath.entries())
        .filter(([pathValue]) => isWorkspaceRelativePath(pathValue))
        .map(([pathValue, stat]) => ({
          path: pathValue,
          source: "working-tree" as const,
          sessionKey:
            activeLatestTurnId !== null
              ? buildWorkspaceReviewSessionKey(activeLatestTurnId, pathValue)
              : buildWorkspaceCurrentReviewSessionKey(workspaceReviewStorageScopeKey, pathValue),
          visibilityKey: buildWorkspaceLiveDiffKey(pendingTurnKey, pathValue, stat),
          stat,
        }))
        .filter((entry) => !isWorkspaceDiffAccepted(acceptedDiffStateByPath[entry.path], entry))
        .toSorted((left, right) =>
          left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
        );
    }

    if (completedLiveDiffState?.source === "pending") {
      return Array.from(completedLiveDiffState.statByPath.entries())
        .filter(([pathValue]) => isWorkspaceRelativePath(pathValue))
        .map(([pathValue, stat]) => ({
          path: pathValue,
          source: "working-tree" as const,
          sessionKey: buildWorkspaceReviewSessionKey(completedLiveDiffState.turnId, pathValue),
          visibilityKey: buildWorkspaceLiveDiffKey(completedLiveDiffState.turnKey, pathValue, stat),
          stat,
        }))
        .filter((entry) => !isWorkspaceDiffAccepted(acceptedDiffStateByPath[entry.path], entry))
        .toSorted((left, right) =>
          left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: "base" }),
        );
    }

    return [];
  }, [
    acceptedDiffStateByPath,
    activeLatestTurnId,
    activeLatestTurnKey,
    activeRunningTurnId,
    activeRunningTurnKey,
    completedLiveDiffState,
    liveWorkspaceDiffStatByPath,
    pendingWorkspaceDiffStatByPath,
    shouldUsePendingWorkspaceReview,
    workspaceReviewStorageScopeKey,
  ]);
  const visibleWorkspaceReviewSessionFiles = useMemo(
    () =>
      currentWorkspaceReviewSessionFiles.filter(
        (entry) => !(entry.path === activeFilePath && activeVisibleDiffFullyAccepted),
      ),
    [activeFilePath, activeVisibleDiffFullyAccepted, currentWorkspaceReviewSessionFiles],
  );

  const activeReviewSessionFiles = useMemo<ReadonlyArray<WorkspaceReviewFileEntry>>(() => {
    if (activeInlineDiffSource === "working-tree") {
      return visibleWorkspaceReviewSessionFiles;
    }

    if (activeInlineDiffSource === "checkpoint" && selectedActiveDiffEntry) {
      return (workspaceAgentDiffTurnFilesByTurnId.get(selectedActiveDiffEntry.turnId) ?? [])
        .map((entry) => ({
          path: entry.path,
          source: "checkpoint" as const,
          sessionKey: buildWorkspaceReviewSessionKey(entry.turnId, entry.path),
          visibilityKey: buildWorkspaceCheckpointDiffKey(entry),
          stat: entry.stat,
        }))
        .filter((entry) => !isWorkspaceDiffAccepted(acceptedDiffStateByPath[entry.path], entry));
    }

    return [];
  }, [
    acceptedDiffStateByPath,
    activeInlineDiffSource,
    selectedActiveDiffEntry,
    visibleWorkspaceReviewSessionFiles,
    workspaceAgentDiffTurnFilesByTurnId,
  ]);
  const activeReviewFileIndex =
    activeFilePath !== null
      ? activeReviewSessionFiles.findIndex((entry) => entry.path === activeFilePath)
      : -1;
  const activeReviewFileCount = activeReviewSessionFiles.length;
  const activeInlineDiffSubtitle =
    activeFileViewMode === "diff" && canShowActiveInlineDiff
      ? activeInlineDiffSource === "working-tree"
        ? activeRemainingReviewItems.length > 0
          ? `Live workspace diff · ${activeRemainingReviewItems.length} change${activeRemainingReviewItems.length === 1 ? "" : "s"} remaining`
          : "Live workspace diff"
        : selectedActiveDiffEntry
          ? activeRemainingReviewItems.length > 0
            ? `Turn ${selectedActiveDiffEntry.checkpointTurnCount ?? "?"} agent diff · ${activeRemainingReviewItems.length} change${activeRemainingReviewItems.length === 1 ? "" : "s"} remaining`
            : `Turn ${selectedActiveDiffEntry.checkpointTurnCount ?? "?"} agent diff`
          : (activeFilePath ?? "")
      : activeFileDirty
        ? `${activeFilePath ?? ""} · local edits active`
        : (activeFilePath ?? "");
  const workspaceDiffSignature = useMemo(
    () =>
      turnDiffSummaries
        .filter((summary) => summary.files.length > 0)
        .map(
          (summary) =>
            `${summary.turnId}:${summary.completedAt}:${summary.files
              .map(
                (file) =>
                  `${file.path.replaceAll("\\", "/")}:${file.kind ?? ""}:${file.additions ?? 0}:${file.deletions ?? 0}`,
              )
              .join("|")}`,
        )
        .join("||"),
    [turnDiffSummaries],
  );
  const liveWorkspaceDiffSignature = useMemo(
    () =>
      Array.from(liveWorkspaceDiffStatByPath.entries())
        .toSorted(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
        .map(
          ([pathValue, stat]) =>
            `${pathValue.replaceAll("\\", "/")}:${stat.additions}:${stat.deletions}:${
              stat.diffSignature ?? ""
            }`,
        )
        .join("||"),
    [liveWorkspaceDiffStatByPath],
  );

  const actionDirectoryPath =
    selectedEntry.kind === "directory"
      ? selectedEntry.path
      : selectedEntry.kind === "file"
        ? parentDirectoryOf(selectedEntry.path)
        : activeFilePath
          ? parentDirectoryOf(activeFilePath)
          : null;
  const resolveLatestVisibleDiffState = useCallback(
    (
      pathValue: string,
      options?: {
        includeAccepted?: boolean;
      },
    ): WorkspaceResolvedFileDiffState | null => {
      const includeAccepted = options?.includeAccepted ?? false;
      const normalizedPath = pathValue.replaceAll("\\", "/");
      const liveDiffStat = liveWorkspaceDiffStatByPath.get(normalizedPath) ?? null;
      if (liveDiffStat !== null && activeRunningTurnKey !== null) {
        const visibilityKey = buildWorkspaceLiveDiffKey(
          activeRunningTurnKey,
          normalizedPath,
          liveDiffStat,
        );
        const liveDiffState: WorkspaceResolvedFileDiffState = {
          source: "working-tree",
          sessionKey:
            activeRunningTurnId !== null
              ? buildWorkspaceReviewSessionKey(activeRunningTurnId, normalizedPath)
              : "",
          visibilityKey,
          stat: liveDiffStat,
        };
        if (
          !includeAccepted &&
          activeRunningTurnId !== null &&
          isWorkspaceDiffAccepted(acceptedDiffStateByPath[normalizedPath], liveDiffState)
        ) {
          return null;
        }
        return liveDiffState;
      }

      const latestCheckpointDiff = workspaceAgentDiffHistoryByPath.get(normalizedPath)?.[0] ?? null;
      if (latestCheckpointDiff) {
        const checkpointDiffState: WorkspaceResolvedFileDiffState = {
          source: "checkpoint",
          sessionKey: buildWorkspaceReviewSessionKey(latestCheckpointDiff.turnId, normalizedPath),
          visibilityKey: buildWorkspaceCheckpointDiffKey(latestCheckpointDiff),
          stat: latestCheckpointDiff.stat,
        };
        if (
          !includeAccepted &&
          !isWorkspaceDiffAccepted(acceptedDiffStateByPath[normalizedPath], checkpointDiffState)
        ) {
          return checkpointDiffState;
        }
        if (includeAccepted) {
          return checkpointDiffState;
        }
      }

      const completedLiveDiffStat = completedLiveDiffState?.statByPath.get(normalizedPath) ?? null;
      if (!completedLiveDiffStat || !completedLiveDiffState) {
        return null;
      }

      const completedLiveDiffResolvedState: WorkspaceResolvedFileDiffState = {
        source: "working-tree",
        sessionKey: buildWorkspaceReviewSessionKey(completedLiveDiffState.turnId, normalizedPath),
        visibilityKey: buildWorkspaceLiveDiffKey(
          completedLiveDiffState.turnKey,
          normalizedPath,
          completedLiveDiffStat,
        ),
        stat: completedLiveDiffStat,
      };
      if (
        !includeAccepted &&
        isWorkspaceDiffAccepted(
          acceptedDiffStateByPath[normalizedPath],
          completedLiveDiffResolvedState,
        )
      ) {
        return null;
      }

      return completedLiveDiffResolvedState;
    },
    [
      acceptedDiffStateByPath,
      activeRunningTurnId,
      activeRunningTurnKey,
      completedLiveDiffState,
      liveWorkspaceDiffStatByPath,
      workspaceAgentDiffHistoryByPath,
    ],
  );
  const showFileViewForPath = useCallback((relativePath: string, mode: WorkspaceFileViewMode) => {
    setFileViewModeByPath((current) => ({
      ...current,
      [relativePath]: mode,
    }));
  }, []);
  const showActiveFileContents = useCallback(() => {
    if (!activeFilePath) {
      return;
    }

    showFileViewForPath(activeFilePath, "editor");
  }, [activeFilePath, showFileViewForPath]);
  const showActiveFileDiff = useCallback(() => {
    if (!activeFilePath) {
      return;
    }

    showFileViewForPath(activeFilePath, "diff");
  }, [activeFilePath, showFileViewForPath]);
  const openReviewFile = useCallback(
    (relativePath: string) => {
      openFile(relativePath);
      showFileViewForPath(relativePath, "diff");
    },
    [openFile, showFileViewForPath],
  );
  const openSelectedTurnInDiffPanel = useCallback(
    (turnId: TurnId, filePath: string) => {
      if (!activeThread) {
        return;
      }

      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId: activeThread.environmentId,
          threadId: activeThread.id,
        },
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath };
        },
      });
    },
    [activeThread, navigate],
  );
  const markActiveVisibleDiffAccepted = useCallback(() => {
    if (
      !activeFilePath ||
      !activeVisibleDiffKey ||
      !activeVisibleDiffSessionKey ||
      !activeInlineDiffSource
    ) {
      return;
    }

    setAcceptedDiffStateByPath((current) => ({
      ...current,
      [activeFilePath]: {
        source: activeInlineDiffSource,
        sessionKey: activeVisibleDiffSessionKey,
        visibilityKey: activeVisibleDiffKey,
      },
    }));
    showFileViewForPath(activeFilePath, "editor");
  }, [
    activeFilePath,
    activeInlineDiffSource,
    activeVisibleDiffKey,
    activeVisibleDiffSessionKey,
    setAcceptedDiffStateByPath,
    showFileViewForPath,
  ]);
  const selectActiveReviewItem = useCallback(
    (reviewItemId: string) => {
      if (!activeVisibleDiffReviewKey) {
        return;
      }

      setDiffReviewStateByKey((current) => ({
        ...current,
        [activeVisibleDiffReviewKey]: {
          acceptedHunkIds:
            current[activeVisibleDiffReviewKey]?.acceptedHunkIds ?? EMPTY_WORKSPACE_DIFF_REVIEW_IDS,
          selectedHunkId: reviewItemId,
        },
      }));
    },
    [activeVisibleDiffReviewKey, setDiffReviewStateByKey],
  );
  const moveActiveReviewSelection = useCallback(
    (direction: -1 | 1) => {
      if (!activeVisibleDiffReviewKey || activeRemainingReviewItems.length <= 1) {
        return;
      }

      const currentIndex = activeSelectedReviewItem
        ? activeRemainingReviewItems.findIndex(
            (reviewItem) => reviewItem.id === activeSelectedReviewItem.id,
          )
        : -1;
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex = Math.min(
        activeRemainingReviewItems.length - 1,
        Math.max(0, baseIndex + direction),
      );
      const nextReviewItem = activeRemainingReviewItems[nextIndex] ?? null;
      if (nextReviewItem !== null) {
        selectActiveReviewItem(nextReviewItem.id);
      }
    },
    [
      activeRemainingReviewItems,
      activeSelectedReviewItem,
      activeVisibleDiffReviewKey,
      selectActiveReviewItem,
    ],
  );
  const acceptActiveReviewSelection = useCallback(() => {
    if (!activeFilePath || !activeVisibleDiffKey) {
      return;
    }

    if (activeReviewItems.length === 0) {
      markActiveVisibleDiffAccepted();
      return;
    }

    if (!activeVisibleDiffReviewKey || !activeSelectedReviewItem) {
      return;
    }

    const currentIndex = activeRemainingReviewItems.findIndex(
      (reviewItem) => reviewItem.id === activeSelectedReviewItem.id,
    );
    const nextReviewItem =
      activeRemainingReviewItems[currentIndex + 1] ??
      activeRemainingReviewItems[currentIndex - 1] ??
      null;
    const nextReviewFile =
      activeReviewFileIndex >= 0
        ? (activeReviewSessionFiles[activeReviewFileIndex + 1] ??
          activeReviewSessionFiles[activeReviewFileIndex - 1] ??
          null)
        : null;

    setDiffReviewStateByKey((current) => ({
      ...current,
      [activeVisibleDiffReviewKey]: {
        acceptedHunkIds: [
          ...(current[activeVisibleDiffReviewKey]?.acceptedHunkIds ??
            EMPTY_WORKSPACE_DIFF_REVIEW_IDS),
          activeSelectedReviewItem.id,
        ],
        selectedHunkId: nextReviewItem?.id ?? null,
      },
    }));

    if (activeRemainingReviewItems.length === 1) {
      markActiveVisibleDiffAccepted();
      if (nextReviewFile && nextReviewFile.path !== activeFilePath) {
        openReviewFile(nextReviewFile.path);
      }
    }
  }, [
    activeFilePath,
    activeReviewFileIndex,
    activeReviewSessionFiles,
    activeRemainingReviewItems,
    activeReviewItems.length,
    activeSelectedReviewItem,
    activeVisibleDiffKey,
    activeVisibleDiffReviewKey,
    markActiveVisibleDiffAccepted,
    openReviewFile,
    setDiffReviewStateByKey,
  ]);
  const handleActiveDiffReviewKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (activeRemainingReviewItems.length === 0) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        ["BUTTON", "INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)
      ) {
        return;
      }

      switch (event.key) {
        case "ArrowDown":
        case "PageDown":
        case "j":
          event.preventDefault();
          moveActiveReviewSelection(1);
          return;
        case "ArrowUp":
        case "PageUp":
        case "k":
          event.preventDefault();
          moveActiveReviewSelection(-1);
          return;
        case "Home":
          event.preventDefault();
          if (activeRemainingReviewItems[0]) {
            selectActiveReviewItem(activeRemainingReviewItems[0].id);
          }
          return;
        case "End":
          event.preventDefault();
          {
            const lastReviewItem =
              activeRemainingReviewItems[activeRemainingReviewItems.length - 1] ?? null;
            if (lastReviewItem) {
              selectActiveReviewItem(lastReviewItem.id);
            }
          }
          return;
        case "Enter":
        case " ":
          event.preventDefault();
          acceptActiveReviewSelection();
          return;
        default:
          return;
      }
    },
    [
      acceptActiveReviewSelection,
      activeRemainingReviewItems,
      moveActiveReviewSelection,
      selectActiveReviewItem,
    ],
  );

  useEffect(() => {
    if (activeFileDiffHistory.length === 0) {
      setSelectedDiffTurnId(null);
      return;
    }

    const selectedStillExists = activeFileDiffHistory.some(
      (entry) => entry.turnId === selectedDiffTurnId,
    );
    if (!selectedStillExists) {
      setSelectedDiffTurnId(activeFileDiffHistory[0]?.turnId ?? null);
    }
  }, [activeFileDiffHistory, selectedDiffTurnId]);

  useEffect(() => {
    const latestVisibleDiff =
      activeFilePath !== null ? resolveLatestVisibleDiffState(activeFilePath) : null;
    if (!activeFilePath || activeFileDirty || !latestVisibleDiff) {
      return;
    }

    setFileViewModeByPath((current) => {
      if (current[activeFilePath] === "diff") {
        return current;
      }

      return { ...current, [activeFilePath]: "diff" };
    });
  }, [activeFileDirty, activeFilePath, resolveLatestVisibleDiffState]);

  useEffect(() => {
    if (activeRunningTurnId === null || activeRunningTurnKey === null) {
      return;
    }

    setAcceptedDiffStateByPath((current) => {
      let next: Record<string, WorkspaceAcceptedDiffState> | null = null;

      for (const [pathValue, acceptedState] of Object.entries(current)) {
        if (
          acceptedState.source !== "working-tree" ||
          acceptedState.sessionKey !==
            buildWorkspaceReviewSessionKey(activeRunningTurnId, pathValue)
        ) {
          continue;
        }

        const liveDiffStat = liveWorkspaceDiffStatByPath.get(pathValue) ?? null;
        if (liveDiffStat === null) {
          continue;
        }

        const currentVisibilityKey = buildWorkspaceLiveDiffKey(
          activeRunningTurnKey,
          pathValue,
          liveDiffStat,
        );
        if (acceptedState.visibilityKey === currentVisibilityKey) {
          continue;
        }

        if (next === null) {
          next = { ...current };
        }
        delete next[pathValue];
      }

      return next ?? current;
    });
  }, [
    activeRunningTurnId,
    activeRunningTurnKey,
    liveWorkspaceDiffStatByPath,
    setAcceptedDiffStateByPath,
  ]);

  useEffect(() => {
    if (!activeEnvironmentId || !activeWorkspaceRoot) {
      return;
    }

    void refreshGitStatus({
      environmentId: activeEnvironmentId,
      cwd: activeWorkspaceRoot,
    }).catch(() => undefined);
    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
    });
    refreshExpandedDirectories();
    refreshCleanOpenFiles({ suppressErrorToast: true });
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    activeThread?.session?.activeTurnId,
    activeThread?.session?.orchestrationStatus,
    queryClient,
    refreshCleanOpenFiles,
    refreshExpandedDirectories,
  ]);

  useEffect(() => {
    if (!activeEnvironmentId || !activeWorkspaceRoot) {
      return;
    }

    const refreshTreeOnVisibilityChange = () => {
      // A hidden tab has nobody looking at the tree; catch up when it comes back.
      if (document.visibilityState === "hidden") {
        return;
      }
      refreshExpandedDirectories({ silent: true });
    };

    const refreshTreeOnTimer = () => {
      if (document.visibilityState === "hidden") {
        return;
      }
      // While a turn runs, the 2s git poll below is already watching this
      // workspace, and every change it sees moves the diff signature, which
      // re-lists the tree. Polling on top of that only spends the request
      // budget at the moment it is scarcest — someone watching an agent work.
      if (workspaceTurnIsRunningRef.current) {
        return;
      }
      refreshExpandedDirectories({ silent: true });
    };

    const intervalId = window.setInterval(refreshTreeOnTimer, WORKSPACE_TREE_POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", refreshTreeOnVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", refreshTreeOnVisibilityChange);
    };
  }, [activeEnvironmentId, activeWorkspaceRoot, refreshExpandedDirectories]);

  useEffect(() => {
    if (
      !activeEnvironmentId ||
      !activeWorkspaceRoot ||
      activeThread?.session?.orchestrationStatus !== "running"
    ) {
      return;
    }

    // The status refresh is cheap to ask for often: it de-dupes what is in
    // flight and debounces itself at 1s. The diff invalidation had no such
    // guard, so it re-fetched the same bytes 30 times a minute while an agent
    // was only thinking. The server publishes a status only when it has
    // actually changed, so follow that instead of the clock.
    let lastInvalidatedGitStatus: GitStatusResult | null = null;

    const intervalId = window.setInterval(() => {
      void refreshGitStatus({
        environmentId: activeEnvironmentId,
        cwd: activeWorkspaceRoot,
      }).catch(() => undefined);

      const gitStatusData = gitStatusDataRef.current;
      if (gitStatusData === lastInvalidatedGitStatus) {
        return;
      }
      lastInvalidatedGitStatus = gitStatusData;
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
      });
    }, 2_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    activeThread?.session?.orchestrationStatus,
    queryClient,
  ]);

  useEffect(() => {
    if (!activeWorkspaceRoot) {
      observedWorkspaceDiffSignatureRef.current = "";
      hasObservedWorkspaceDiffBaselineRef.current = false;
      return;
    }

    if (!hasObservedWorkspaceDiffBaselineRef.current) {
      observedWorkspaceDiffSignatureRef.current = workspaceDiffSignature;
      hasObservedWorkspaceDiffBaselineRef.current = true;
      return;
    }

    if (observedWorkspaceDiffSignatureRef.current === workspaceDiffSignature) {
      return;
    }
    observedWorkspaceDiffSignatureRef.current = workspaceDiffSignature;

    if (workspaceDiffSignature.length === 0) {
      return;
    }

    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.all,
    });

    // Through the one gated path, so a run of checkpoints does not fan out over
    // the same folders faster than the answers come back.
    refreshExpandedDirectories();

    for (const filePath of openTabs) {
      if (dirtyFilePathSet.has(filePath)) {
        continue;
      }
      void loadFile(filePath, { force: true, suppressErrorToast: true });
    }

    setFileViewModeByPath((current) => {
      let next = current;

      for (const filePath of openTabs) {
        if (dirtyFilePathSet.has(filePath)) {
          continue;
        }
        if (resolveLatestVisibleDiffState(filePath) === null) {
          continue;
        }
        if ((next[filePath] ?? null) === "diff") {
          continue;
        }
        if (next === current) {
          next = { ...current };
        }
        next[filePath] = "diff";
      }

      return next;
    });

    if (activeFilePath && !dirtyFilePathSet.has(activeFilePath)) {
      setSelectedDiffTurnId(
        workspaceAgentDiffHistoryByPath.get(activeFilePath)?.[0]?.turnId ?? null,
      );
    }
  }, [
    activeFilePath,
    activeWorkspaceRoot,
    dirtyFilePathSet,
    loadFile,
    openTabs,
    queryClient,
    refreshExpandedDirectories,
    resolveLatestVisibleDiffState,
    workspaceAgentDiffHistoryByPath,
    workspaceDiffSignature,
  ]);

  useEffect(() => {
    if (!activeWorkspaceRoot) {
      observedLiveWorkspaceDiffSignatureRef.current = "";
      hasObservedLiveWorkspaceDiffBaselineRef.current = false;
      return;
    }

    if (!hasObservedLiveWorkspaceDiffBaselineRef.current) {
      observedLiveWorkspaceDiffSignatureRef.current = liveWorkspaceDiffSignature;
      hasObservedLiveWorkspaceDiffBaselineRef.current = true;
      return;
    }

    if (observedLiveWorkspaceDiffSignatureRef.current === liveWorkspaceDiffSignature) {
      return;
    }
    observedLiveWorkspaceDiffSignatureRef.current = liveWorkspaceDiffSignature;

    void queryClient.invalidateQueries({
      queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
    });
    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.all,
    });

    // Same gated path as the poll: a live turn moves this signature every time
    // the agent writes, which is exactly when the budget is tightest.
    refreshExpandedDirectories();

    for (const filePath of openTabs) {
      if (dirtyFilePathSet.has(filePath)) {
        continue;
      }
      void loadFile(filePath, { force: true, suppressErrorToast: true });
    }

    setFileViewModeByPath((current) => {
      let next = current;

      for (const filePath of openTabs) {
        if (dirtyFilePathSet.has(filePath) || resolveLatestVisibleDiffState(filePath) === null) {
          continue;
        }
        if ((next[filePath] ?? null) === "diff") {
          continue;
        }
        if (next === current) {
          next = { ...current };
        }
        next[filePath] = "diff";
      }

      return next;
    });
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    dirtyFilePathSet,
    liveWorkspaceDiffSignature,
    liveWorkspaceDiffStatByPath,
    loadFile,
    openTabs,
    queryClient,
    refreshExpandedDirectories,
    resolveLatestVisibleDiffState,
  ]);

  const collaborationScope = activeProject?.ownership ?? null;
  /** Claims authorship of paths this person just wrote, for the tree's colouring. */
  const recordFileTouches = useCallback(
    (paths: readonly string[]) => {
      if (!activeEnvironmentId || !collaborationScope || paths.length === 0) {
        return;
      }
      const api = readEnvironmentApi(activeEnvironmentId);
      if (!api) {
        return;
      }
      void api.collaboration
        .touchFiles({
          tenantId: collaborationScope.tenantId,
          workspaceId: collaborationScope.workspaceId,
          paths,
        })
        // Authorship marks are decoration; never fail a save over one.
        .catch(() => undefined);
    },
    [activeEnvironmentId, collaborationScope],
  );

  const shareProjectId = activeProject?.id ?? null;
  /**
   * The tree's one-click share. Minting and copying are the same act because
   * the token is in the creation reply and in no other, so this resolves only
   * once the URL is on the clipboard.
   */
  const copyFileShareLink = useCallback(
    async (relativePath: string) => {
      if (!activeEnvironmentId || !collaborationScope || !shareProjectId) {
        return;
      }
      await mintAndCopyShareLink({
        environmentId: activeEnvironmentId,
        failureTitle: "Could not share that file",
        create: {
          tenantId: collaborationScope.tenantId,
          workspaceId: collaborationScope.workspaceId,
          scope: "file",
          projectId: shareProjectId,
          filePath: relativePath,
          // A file link is served to a browser with no session, so there is
          // nobody it could be addressed to. Said here rather than defaulted,
          // because the contract makes every caller say it.
          audience: { kind: "public" },
        },
      });
    },
    [activeEnvironmentId, collaborationScope, shareProjectId],
  );
  /** Off unless this workspace has a tenancy a public link could come out of. */
  const canShareLinks = activeEnvironmentId !== null && collaborationScope !== null;

  const saveActiveFile = useCallback(async () => {
    if (!activeEnvironmentId || !activeWorkspaceRoot || !activeFilePath || !activeFileState) {
      return;
    }

    if (activeFileState.isBinary || activeFileState.tooLarge || !activeFileDirty) {
      return;
    }

    const nextContents = draftByPath[activeFilePath] ?? activeFileState.contents;
    setSavingFilePath(activeFilePath);

    try {
      const api = ensureEnvironmentApi(activeEnvironmentId);
      await api.projects.writeFile({
        cwd: activeWorkspaceRoot,
        relativePath: activeFilePath,
        contents: nextContents,
      });

      recordFileTouches([activeFilePath]);

      const nextFileState: ProjectReadFileResult = {
        relativePath: activeFilePath,
        contents: nextContents,
        isBinary: false,
        tooLarge: false,
        sizeBytes: new TextEncoder().encode(nextContents).length,
      };
      setFileStateByPath((current) => ({
        ...current,
        [activeFilePath]: nextFileState,
      }));
      setAcceptedDiffStateByPath((current) => {
        if (!current[activeFilePath]) {
          return current;
        }

        const next = { ...current };
        delete next[activeFilePath];
        return next;
      });
      setDiffReviewStateByKey((current) => {
        const normalizedActiveFilePath = activeFilePath.replaceAll("\\", "/");
        let next: Record<string, WorkspaceDiffReviewState> | null = null;

        for (const key of Object.keys(current)) {
          if (!key.startsWith("working-tree:") || !key.includes(`:${normalizedActiveFilePath}:`)) {
            continue;
          }

          if (next === null) {
            next = { ...current };
          }
          delete next[key];
        }

        return next ?? current;
      });
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(activeEnvironmentId, activeWorkspaceRoot, activeFilePath),
      });
      await queryClient.invalidateQueries({
        queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
      });
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.all,
      });
      void refreshGitStatus({
        environmentId: activeEnvironmentId,
        cwd: activeWorkspaceRoot,
      }).catch(() => undefined);
      toastManager.add({
        type: "success",
        title: "File saved",
        description: activeFilePath,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not save file",
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    } finally {
      setSavingFilePath((current) => (current === activeFilePath ? null : current));
    }
  }, [
    activeEnvironmentId,
    activeFileDirty,
    activeFilePath,
    activeFileState,
    activeWorkspaceRoot,
    draftByPath,
    queryClient,
    recordFileTouches,
    setAcceptedDiffStateByPath,
    setDiffReviewStateByKey,
  ]);

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") {
        return;
      }

      event.preventDefault();
      void saveActiveFile();
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
    };
  }, [saveActiveFile]);

  const closeTab = useCallback(
    (relativePath: string) => {
      const isDirty = dirtyFilePathSet.has(relativePath);
      if (isDirty && !window.confirm(`Discard unsaved changes in "${relativePath}"?`)) {
        return;
      }

      setOpenTabs((current) => {
        const next = current.filter((pathValue) => pathValue !== relativePath);
        setActiveFilePath((currentActivePath) => {
          if (currentActivePath !== relativePath) {
            return currentActivePath;
          }
          const closedIndex = current.indexOf(relativePath);
          return next[closedIndex] ?? next[closedIndex - 1] ?? null;
        });
        return next;
      });
    },
    [dirtyFilePathSet],
  );

  const openCreateEntryDialog = useCallback((kind: ProjectCreateEntryInput["kind"]) => {
    setCreateDialogState({
      open: true,
      kind,
      name: "",
    });
  }, []);

  const closeCreateEntryDialog = useCallback(() => {
    setCreateDialogState((current) => ({
      ...current,
      open: false,
      name: "",
    }));
  }, []);

  const submitCreateEntry = useCallback(async () => {
    const trimmedName = createDialogState.name.trim();
    if (!activeEnvironmentId || !activeWorkspaceRoot || !trimmedName) {
      return;
    }

    const relativePath = joinRelativePath(actionDirectoryPath, trimmedName);
    try {
      const api = ensureEnvironmentApi(activeEnvironmentId);
      await api.projects.createEntry({
        cwd: activeWorkspaceRoot,
        relativePath,
        kind: createDialogState.kind,
      });

      if (createDialogState.kind === "file") {
        recordFileTouches([relativePath]);
      }
      await loadDirectory(actionDirectoryPath);
      if (createDialogState.kind === "directory") {
        setExpandedDirectoriesByPath((current) => ({
          ...current,
          [relativePath]: true,
        }));
        await loadDirectory(relativePath);
        setSelectedEntry({ path: relativePath, kind: "directory" });
      } else {
        openFile(relativePath);
      }

      closeCreateEntryDialog();
      toastManager.add({
        type: "success",
        title: createDialogState.kind === "directory" ? "Folder created" : "File created",
        description: relativePath,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not create ${createDialogState.kind}`,
        description: error instanceof Error ? error.message : "An unexpected error occurred.",
      });
    }
  }, [
    actionDirectoryPath,
    activeEnvironmentId,
    activeWorkspaceRoot,
    closeCreateEntryDialog,
    createDialogState.kind,
    createDialogState.name,
    loadDirectory,
    openFile,
    recordFileTouches,
  ]);

  const uploadFilesToDirectory = useCallback(
    async (files: readonly File[], directoryPath: string | null) => {
      if (!activeEnvironmentId || !activeWorkspaceRoot || files.length === 0) {
        return;
      }

      setUploadingDirectoryPath(directoryPath);

      try {
        const api = ensureEnvironmentApi(activeEnvironmentId);

        for (const file of files) {
          const relativePath = joinRelativePath(directoryPath, file.name);
          await api.projects.writeFile({
            cwd: activeWorkspaceRoot,
            relativePath,
            contents: arrayBufferToBase64(await file.arrayBuffer()),
            encoding: "base64",
          });
        }

        await loadDirectory(directoryPath);
        toastManager.add({
          type: "success",
          title: files.length === 1 ? "File uploaded" : "Files uploaded",
          description:
            files.length === 1 ? (files[0]?.name ?? "Upload complete") : `${files.length} files`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not upload files",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        setUploadingDirectoryPath(null);
      }
    },
    [activeEnvironmentId, activeWorkspaceRoot, loadDirectory],
  );

  const handleUploadInputChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const files = event.target.files ? [...event.target.files] : [];
      void uploadFilesToDirectory(files, actionDirectoryPath);
      event.target.value = "";
    },
    [actionDirectoryPath, uploadFilesToDirectory],
  );

  const handleDirectoryDragOver = useCallback(
    (event: DragEvent<HTMLButtonElement>, directoryPath: string) => {
      if (!hasDraggedFiles(event)) {
        return;
      }

      event.preventDefault();
      setDropTargetDirectoryPath(directoryPath);
    },
    [],
  );

  const handleDirectoryDragLeave = useCallback(
    (_event: DragEvent<HTMLButtonElement>, directoryPath: string) => {
      setDropTargetDirectoryPath((current) => (current === directoryPath ? null : current));
    },
    [],
  );

  const handleDirectoryDrop = useCallback(
    (event: DragEvent<HTMLButtonElement>, directoryPath: string) => {
      if (!hasDraggedFiles(event)) {
        return;
      }

      event.preventDefault();
      setDropTargetDirectoryPath(null);
      void uploadFilesToDirectory([...event.dataTransfer.files], directoryPath);
    },
    [uploadFilesToDirectory],
  );

  const renderExplorerEntries = useCallback(
    (entries: ReadonlyArray<ProjectDirectoryEntry>, depth: number): React.ReactNode =>
      entries.map((entry) => {
        const entryPath = entry.path.replaceAll("\\", "/");
        const isDirectoryExpanded = Boolean(expandedDirectoriesByPath[directoryKey(entryPath)]);
        const childEntries = directoryEntriesByPath[directoryKey(entryPath)] ?? [];
        const visibleDiffState = resolveLatestVisibleDiffState(entryPath);
        const acceptedDiffState = resolveLatestVisibleDiffState(entryPath, {
          includeAccepted: true,
        });
        const status =
          entry.kind === "file" && !(visibleDiffState === null && acceptedDiffState !== null)
            ? (workingTreeStatusByPath.get(entryPath) ?? null)
            : null;
        return (
          <WorkspaceExplorerRow
            key={entry.path}
            depth={depth}
            entry={entry}
            expanded={isDirectoryExpanded}
            loading={Boolean(loadingDirectoriesByPath[directoryKey(entryPath)])}
            selected={selectedEntry.path === entry.path}
            dropTarget={dropTargetDirectoryPath === entry.path}
            resolvedTheme={resolvedTheme}
            changed={visibleDiffState !== null}
            diffStat={visibleDiffState?.stat ?? null}
            status={status}
            author={entry.kind === "file" ? (workspaceAuthorByPath.get(entryPath) ?? null) : null}
            authorColorValue={
              entry.kind === "file"
                ? (workspaceAuthorColors.get(workspaceAuthorByPath.get(entryPath)?.userId ?? "") ??
                  null)
                : null
            }
            onToggleDirectory={toggleDirectory}
            onOpenFile={openFile}
            onCopyShareLink={
              entry.kind === "file" && canShareLinks && shareProjectId
                ? copyFileShareLink
                : undefined
            }
            onSelectEntry={setSelectedEntry}
            onDirectoryDrop={handleDirectoryDrop}
            onDirectoryDragOver={handleDirectoryDragOver}
            onDirectoryDragLeave={handleDirectoryDragLeave}
          >
            {entry.kind === "directory" && isDirectoryExpanded
              ? renderExplorerEntries(childEntries, depth + 1)
              : null}
          </WorkspaceExplorerRow>
        );
      }),
    [
      canShareLinks,
      copyFileShareLink,
      directoryEntriesByPath,
      dropTargetDirectoryPath,
      expandedDirectoriesByPath,
      handleDirectoryDragLeave,
      handleDirectoryDragOver,
      handleDirectoryDrop,
      loadingDirectoriesByPath,
      openFile,
      resolvedTheme,
      resolveLatestVisibleDiffState,
      selectedEntry.path,
      shareProjectId,
      toggleDirectory,
      workingTreeStatusByPath,
      workspaceAuthorByPath,
      workspaceAuthorColors,
    ],
  );

  const header = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {mode === "inline" ? (
          <SidebarTrigger className="size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]" />
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-foreground">{workspaceLabel}</div>
          <div className="truncate text-[11px] text-muted-foreground/70">
            {activeWorkspaceRoot ?? "No active workspace"}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        {mode === "compact" ? (
          <Button
            type="button"
            variant={compactExplorerOpen ? "default" : "outline"}
            size="xs"
            onClick={() => setCompactExplorerOpen((open) => !open)}
            aria-label={compactExplorerOpen ? "Hide workspace files" : "Show workspace files"}
          >
            <FilesIcon className="size-3" />
            Files
          </Button>
        ) : null}
        {mode === "compact" && onOpenDiff ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  onClick={onOpenDiff}
                  aria-label="Open changes panel"
                />
              }
            >
              <GitCompareArrowsIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Open changes panel</TooltipPopup>
          </Tooltip>
        ) : null}
        <span
          className={cn(
            "rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70",
            mode === "compact" && "hidden min-[380px]:inline",
          )}
        >
          {workspaceScopeLabel}
        </span>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                onClick={refreshWorkspace}
                disabled={!activeWorkspaceRoot}
                aria-label="Refresh workspace"
              />
            }
          >
            <RefreshCcwIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Refresh workspace</TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="icon-xs"
                onClick={() => void saveActiveFile()}
                disabled={!activeFileDirty || savingFilePath !== null}
                aria-label="Save file"
              />
            }
          >
            {savingFilePath ? (
              <LoaderCircleIcon className="size-3 animate-spin" />
            ) : (
              <SaveIcon className="size-3" />
            )}
          </TooltipTrigger>
          <TooltipPopup side="bottom">Save active file</TooltipPopup>
        </Tooltip>
        {onClose ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="outline"
                  size="icon-xs"
                  onClick={onClose}
                  aria-label="Close workspace panel"
                />
              }
            >
              <XIcon className="size-3" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Close workspace panel</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </>
  );

  if (!activeWorkspaceRoot) {
    return (
      <WorkspacePanelShell mode={mode} header={header}>
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          {activeThread
            ? "This thread has no workspace configured."
            : "Select a project or thread to browse its workspace."}
        </div>
      </WorkspacePanelShell>
    );
  }

  const rootEntries = directoryEntriesByPath[ROOT_DIRECTORY_KEY];
  if (!rootEntries && loadingDirectoriesByPath[ROOT_DIRECTORY_KEY]) {
    return (
      <WorkspacePanelShell mode={mode} header={header}>
        <WorkspacePanelLoadingState label="Loading workspace files..." />
      </WorkspacePanelShell>
    );
  }

  return (
    <WorkspacePanelShell mode={mode} header={header}>
      <div
        className={cn(
          "grid min-h-0 flex-1",
          mode === "compact"
            ? compactExplorerOpen
              ? "grid-rows-[minmax(8rem,34%)_minmax(0,1fr)]"
              : "grid-rows-[0_minmax(0,1fr)]"
            : "grid-cols-[16rem_minmax(0,1fr)]",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-col overflow-hidden bg-card/15",
            mode === "compact" ? "border-b border-border/60" : "border-r border-border/60",
          )}
          aria-hidden={mode === "compact" && !compactExplorerOpen}
        >
          <div className="flex items-center justify-between border-b border-border/50 px-3 py-2">
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2 rounded-md px-1 py-0.5 text-left",
                selectedEntry.path === null && "bg-accent text-accent-foreground",
              )}
              onClick={() => setSelectedEntry({ path: null, kind: "directory" })}
            >
              <VscodeEntryIcon
                pathValue={workspaceLabel}
                kind="directory"
                theme={resolvedTheme}
                className="size-4"
              />
              <span className="truncate text-xs font-medium text-foreground">Files</span>
            </button>
            <div className="flex items-center gap-1">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => openCreateEntryDialog("file")}
                      aria-label="New file"
                    />
                  }
                >
                  <FilePlus2Icon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">New file</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => openCreateEntryDialog("directory")}
                      aria-label="New folder"
                    />
                  }
                >
                  <FolderPlusIcon className="size-3.5" />
                </TooltipTrigger>
                <TooltipPopup side="bottom">New folder</TooltipPopup>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => uploadInputRef.current?.click()}
                      disabled={uploadingDirectoryPath !== null}
                      aria-label="Upload files"
                    />
                  }
                >
                  {uploadingDirectoryPath !== null ? (
                    <LoaderCircleIcon className="size-3.5 animate-spin" />
                  ) : (
                    <HardDriveUploadIcon className="size-3.5" />
                  )}
                </TooltipTrigger>
                <TooltipPopup side="bottom">Upload files</TooltipPopup>
              </Tooltip>
              {canShareLinks ? (
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => setShareLinksOpen((current) => !current)}
                        aria-label="Share links"
                        aria-pressed={shareLinksOpen}
                      />
                    }
                  >
                    <Share2Icon className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipPopup side="bottom">Share links</TooltipPopup>
                </Tooltip>
              ) : null}
            </div>
          </div>
          {canShareLinks && shareLinksOpen ? (
            <ShareLinksPanel
              environmentId={activeEnvironmentId}
              tenantId={collaborationScope?.tenantId ?? null}
              workspaceId={collaborationScope?.workspaceId ?? null}
              projectId={shareProjectId}
              projectLabel={activeProject?.name ?? workspaceLabel}
              workspaceLabel={workspaceLabel}
              onClose={() => setShareLinksOpen(false)}
            />
          ) : null}
          <div
            className={cn(
              "min-h-0 flex-1 overflow-auto px-2 py-2",
              dropTargetDirectoryPath === null &&
                uploadingDirectoryPath === null &&
                "transition-colors",
            )}
            onDragOver={(event) => {
              if (!hasDraggedFiles(event)) {
                return;
              }
              event.preventDefault();
              setDropTargetDirectoryPath(null);
            }}
            onDragLeave={() =>
              setDropTargetDirectoryPath((current) => (current === null ? null : current))
            }
            onDrop={(event) => {
              if (!hasDraggedFiles(event)) {
                return;
              }
              event.preventDefault();
              setDropTargetDirectoryPath(null);
              void uploadFilesToDirectory([...event.dataTransfer.files], null);
            }}
          >
            {visibleWorkspaceReviewSessionFiles.length > 0 ? (
              <div className="mb-2 border-b border-border/50 pb-2">
                <div className="mb-1 px-1 text-[11px] font-medium text-muted-foreground/80">
                  Changes
                </div>
                <div className="space-y-0.5">
                  {visibleWorkspaceReviewSessionFiles.map((entry) => (
                    <button
                      key={`workspace-change:${entry.path}`}
                      type="button"
                      className={cn(
                        "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                        entry.path === activeFilePath
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground/85 hover:bg-accent/50 hover:text-foreground",
                      )}
                      onClick={() => openReviewFile(entry.path)}
                    >
                      <VscodeEntryIcon
                        pathValue={entry.path}
                        kind="file"
                        theme={resolvedTheme}
                        className="size-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.path}</span>
                      {hasNonZeroStat(entry.stat) ? (
                        <span className="shrink-0 font-mono text-[10px] tabular-nums">
                          <DiffStatLabel
                            additions={entry.stat.additions}
                            deletions={entry.stat.deletions}
                          />
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] text-muted-foreground/70">
                          changed
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
            {rootEntries && rootEntries.length > 0 ? (
              <div className="space-y-0.5">{renderExplorerEntries(rootEntries, 0)}</div>
            ) : (
              <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
                No files found in this workspace.
              </div>
            )}
          </div>
        </div>

        <div className="flex min-h-0 min-w-0 flex-col">
          <div className="flex min-h-10 items-center gap-1 border-b border-border/50 px-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-1">
              {openTabs.length === 0 ? (
                <span className="px-2 text-xs text-muted-foreground/70">No open files</span>
              ) : (
                openTabs.map((tabPath) => {
                  const dirty = dirtyFilePathSet.has(tabPath);
                  const active = tabPath === activeFilePath;
                  const visibleDiffState = resolveLatestVisibleDiffState(tabPath);
                  const acceptedDiffState = resolveLatestVisibleDiffState(tabPath, {
                    includeAccepted: true,
                  });
                  const tabStatus = workingTreeStatusByPath.get(tabPath) ?? null;
                  const hideTabStatus = visibleDiffState === null && acceptedDiffState !== null;
                  return (
                    <div
                      key={tabPath}
                      data-workspace-tab-path={tabPath}
                      className={cn(
                        "group flex items-center gap-1 rounded-md border px-2 py-1 text-xs",
                        active
                          ? "border-border bg-background text-foreground"
                          : "border-transparent bg-transparent text-muted-foreground/75 hover:border-border/60 hover:bg-accent/40 hover:text-foreground",
                      )}
                    >
                      <button
                        type="button"
                        className="flex min-w-0 items-center gap-1"
                        onClick={() => setActiveFilePath(tabPath)}
                      >
                        <VscodeEntryIcon
                          pathValue={tabPath}
                          kind="file"
                          theme={resolvedTheme}
                          className="size-3.5"
                        />
                        <span className="truncate">{basenameOfPath(tabPath)}</span>
                        {dirty ? (
                          <span className="rounded-full bg-primary/70 px-1 text-[9px] text-primary-foreground">
                            unsaved
                          </span>
                        ) : null}
                        {!dirty && visibleDiffState !== null ? (
                          <span
                            className="font-mono text-[9px] tabular-nums text-muted-foreground/80"
                            data-workspace-tab-diff-state={tabPath}
                          >
                            {hasNonZeroStat(visibleDiffState.stat) ? (
                              <DiffStatLabel
                                additions={visibleDiffState.stat.additions}
                                deletions={visibleDiffState.stat.deletions}
                              />
                            ) : (
                              "changed"
                            )}
                          </span>
                        ) : null}
                        {!dirty &&
                        !hideTabStatus &&
                        visibleDiffState === null &&
                        tabStatus !== null ? (
                          <span
                            className="font-mono text-[9px] tabular-nums text-muted-foreground/80"
                            data-workspace-tab-diff-state={tabPath}
                          >
                            <FileStatusBadge status={tabStatus} />
                          </span>
                        ) : null}
                      </button>
                      <button
                        type="button"
                        className="rounded-sm p-0.5 text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                        onClick={() => closeTab(tabPath)}
                        aria-label={`Close ${tabPath}`}
                      >
                        ×
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col">
            {activeFilePath &&
            ((activeFileState && !activeFileState.isBinary && !activeFileState.tooLarge) ||
              canShowActiveInlineDiff) ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-foreground">
                    {basenameOfPath(activeFilePath)}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground/70">
                    {activeInlineDiffSubtitle}
                  </div>
                </div>
                {canShowActiveInlineDiff ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    aria-label={
                      activeFileViewMode === "diff" ? "Edit file contents" : "Return to diff review"
                    }
                    onClick={
                      activeFileViewMode === "diff" ? showActiveFileContents : showActiveFileDiff
                    }
                  >
                    {activeFileViewMode === "diff" ? "Edit" : "Review diff"}
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="min-h-0 flex-1">
              {!activeFilePath ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <div className="rounded-full border border-border/70 bg-card/70 p-3">
                    <FilePlus2Icon className="size-5 text-muted-foreground/70" />
                  </div>
                  <div className="text-sm font-medium text-foreground">
                    Select a file to start editing
                  </div>
                  <div className="max-w-md text-xs text-muted-foreground/70">
                    Create a file, upload one into the explorer, or open an existing file from the
                    workspace tree.
                  </div>
                </div>
              ) : loadingFilePath === activeFilePath && !activeFileState ? (
                <div className="flex h-full items-center justify-center gap-2 text-xs text-muted-foreground/70">
                  <LoaderCircleIcon className="size-4 animate-spin" />
                  Loading file…
                </div>
              ) : activeFileState?.isBinary ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <FileWarningIcon className="size-5 text-muted-foreground/70" />
                  <div className="text-sm font-medium text-foreground">
                    Binary files aren&apos;t editable here yet
                  </div>
                  <div className="text-xs text-muted-foreground/70">{activeFilePath}</div>
                </div>
              ) : activeFileState?.tooLarge ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                  <FileWarningIcon className="size-5 text-muted-foreground/70" />
                  <div className="text-sm font-medium text-foreground">
                    This file is too large to open in the editor
                  </div>
                  <div className="text-xs text-muted-foreground/70">{activeFilePath}</div>
                </div>
              ) : activeFileViewMode === "diff" && canShowActiveInlineDiff ? (
                <div
                  className="h-full overflow-auto bg-background/70 p-2"
                  data-workspace-file-mode="diff"
                >
                  {activeReviewItems.length > 0 ? (
                    <div
                      className="sticky top-0 z-10 mb-2 rounded-md border border-border/60 bg-card/95 px-3 py-2 shadow-sm backdrop-blur"
                      role="region"
                      tabIndex={0}
                      aria-label="Workspace diff review controls"
                      data-workspace-diff-review="controls"
                      onKeyDown={handleActiveDiffReviewKeyDown}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div
                          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/85"
                          aria-live="polite"
                          data-workspace-diff-review-status
                        >
                          {activeSelectedReviewItem
                            ? `Change ${activeSelectedReviewPosition} of ${activeRemainingReviewItems.length}${activeReviewFileCount > 1 ? ` · File ${Math.max(activeReviewFileIndex, 0) + 1}/${activeReviewFileCount}` : ""} · ${activeSelectedReviewItem.lineLabel}`
                            : `${activeRemainingReviewItems.length} change${activeRemainingReviewItems.length === 1 ? "" : "s"} remaining`}
                        </div>
                        <div className="flex items-center gap-1">
                          {activeRemainingReviewItems.length > 1 ? (
                            <>
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                onClick={() => moveActiveReviewSelection(-1)}
                                disabled={activeSelectedReviewPosition <= 1}
                                aria-label="Review previous change"
                              >
                                Prev
                              </Button>
                              <Button
                                type="button"
                                size="xs"
                                variant="outline"
                                onClick={() => moveActiveReviewSelection(1)}
                                disabled={
                                  activeSelectedReviewPosition === activeRemainingReviewItems.length
                                }
                                aria-label="Review next change"
                              >
                                Next
                              </Button>
                            </>
                          ) : null}
                          <Button
                            type="button"
                            size="xs"
                            onClick={acceptActiveReviewSelection}
                            aria-label="Accept the current change"
                          >
                            Accept
                          </Button>
                        </div>
                      </div>
                      {activeReviewFileCount > 1 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
                          {activeReviewSessionFiles.map((entry, index) => {
                            const active = entry.path === activeFilePath;
                            return (
                              <Button
                                key={entry.path}
                                type="button"
                                size="xs"
                                variant={active ? "default" : "outline"}
                                className="max-w-full"
                                onClick={() => openReviewFile(entry.path)}
                                aria-label={`Review file ${index + 1}, ${entry.path}`}
                              >
                                <span className="truncate">{basenameOfPath(entry.path)}</span>
                              </Button>
                            );
                          })}
                        </div>
                      ) : null}
                      {activeRemainingReviewItems.length > 1 ? (
                        <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-border/50 pt-2">
                          {activeRemainingReviewItems.map((reviewItem, index) => {
                            const active = reviewItem.id === activeSelectedReviewItem?.id;
                            return (
                              <Button
                                key={reviewItem.id}
                                type="button"
                                size="xs"
                                variant={active ? "default" : "outline"}
                                onClick={() => selectActiveReviewItem(reviewItem.id)}
                                aria-label={`Jump to change ${index + 1}, ${reviewItem.lineLabel}`}
                              >
                                {index + 1}
                              </Button>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/60 bg-card/80 px-3 py-2">
                      <div className="text-[11px] text-muted-foreground/80">
                        Review this diff, then accept it to return to the file.
                      </div>
                      <Button
                        type="button"
                        size="xs"
                        onClick={acceptActiveReviewSelection}
                        aria-label="Accept this diff"
                      >
                        Accept diff
                      </Button>
                    </div>
                  )}
                  {activeInlineDiffErrorMessage && !activeRenderableInlinePatch ? (
                    <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive/80">
                      {activeInlineDiffErrorMessage}
                    </div>
                  ) : activeInlineDiffLoading && !activeRenderableInlinePatch ? (
                    <div className="flex h-full min-h-[10rem] items-center justify-center text-xs text-muted-foreground/70">
                      Loading inline diff…
                    </div>
                  ) : activeRenderableInlineFile ? (
                    <div className="overflow-hidden rounded-md border border-border/60 bg-card">
                      <FileDiff
                        fileDiff={activeFocusedInlineFile ?? activeRenderableInlineFile}
                        options={{
                          diffStyle: "unified",
                          lineDiffType: "none",
                          overflow: settings.diffWordWrap ? "wrap" : "scroll",
                          theme: resolveDiffThemeName(resolvedTheme),
                          themeType: resolvedTheme,
                          unsafeCSS: DIFF_VIEWER_UNSAFE_CSS,
                        }}
                      />
                    </div>
                  ) : activeRenderableInlinePatch?.kind === "raw" ? (
                    <div className="space-y-2">
                      <p className="text-[11px] text-muted-foreground/75">
                        {activeRenderableInlinePatch.reason}
                      </p>
                      <pre
                        className={cn(
                          "rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                          settings.diffWordWrap
                            ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                            : "overflow-auto",
                        )}
                      >
                        {activeRenderableInlinePatch.text}
                      </pre>
                    </div>
                  ) : (
                    <div className="flex h-full min-h-[10rem] items-center justify-center px-4 text-center text-xs text-muted-foreground/70">
                      No inline diff is available for this file yet.
                    </div>
                  )}
                  {activeInlineDiffSource === "checkpoint" &&
                  activeThread &&
                  activeFilePath &&
                  activeFileDiffHistory.length > 0 ? (
                    <WorkspaceAgentDiffPreview
                      environmentId={activeThread.environmentId}
                      threadId={activeThread.id}
                      filePath={activeFilePath}
                      fileHistory={activeFileDiffHistory}
                      turnFilesByTurnId={workspaceAgentDiffTurnFilesByTurnId}
                      selectedTurnId={selectedActiveDiffEntry?.turnId ?? null}
                      resolvedTheme={resolvedTheme}
                      onSelectTurnId={setSelectedDiffTurnId}
                      onOpenFile={openReviewFile}
                      onOpenFullDiff={openSelectedTurnInDiffPanel}
                    />
                  ) : null}
                </div>
              ) : activeFileState ? (
                <div className="h-full" data-workspace-file-mode="editor">
                  <Editor
                    height="100%"
                    path={activeFilePath}
                    theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
                    value={activeFileDraft}
                    onChange={(nextValue) => {
                      setDraftByPath((current) => ({
                        ...current,
                        [activeFilePath]: nextValue ?? "",
                      }));
                    }}
                    options={{
                      automaticLayout: true,
                      fontSize: 13,
                      minimap: { enabled: false },
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      wordWrap: "on",
                    }}
                  />
                </div>
              ) : (
                <div className="flex h-full items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
                  Select a file to start editing.
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <input
        ref={uploadInputRef}
        type="file"
        multiple
        className="sr-only"
        onChange={handleUploadInputChange}
      />

      <Dialog
        open={createDialogState.open}
        onOpenChange={(open) => {
          if (!open) {
            closeCreateEntryDialog();
          }
        }}
      >
        <DialogPopup className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {createDialogState.kind === "directory" ? "New folder" : "New file"}
            </DialogTitle>
            <DialogDescription>
              {actionDirectoryPath
                ? `Create this ${createDialogState.kind} inside ${actionDirectoryPath}.`
                : `Create this ${createDialogState.kind} at the workspace root.`}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Name</span>
              <Input
                value={createDialogState.name}
                onChange={(event) => {
                  setCreateDialogState((current) => ({
                    ...current,
                    name: event.target.value,
                  }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitCreateEntry();
                  }
                }}
                placeholder={createDialogState.kind === "directory" ? "src" : "src/app.tsx"}
              />
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={closeCreateEntryDialog}>
              Cancel
            </Button>
            <Button onClick={() => void submitCreateEntry()}>Create</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </WorkspacePanelShell>
  );
}
