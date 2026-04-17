import Editor from "@monaco-editor/react";
import { FileDiff } from "@pierre/diffs/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  ProjectCreateEntryInput,
  ProjectDirectoryEntry,
  ProjectReadFileResult,
  TurnId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { createThreadSelectorByRef } from "~/storeSelectors";
import {
  ChevronRightIcon,
  FilePlus2Icon,
  FileWarningIcon,
  FolderClosedIcon,
  FolderPlusIcon,
  HardDriveUploadIcon,
  LoaderCircleIcon,
  RefreshCcwIcon,
  SaveIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import { useSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { useWorkspaceAgentTurnDiff } from "~/hooks/useWorkspaceAgentTurnDiff";
import { useWorkspaceWorkingTreeDiff } from "~/hooks/useWorkspaceWorkingTreeDiff";
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
import { buildWorkspaceLiveTurnDiffStatByPath } from "~/lib/workspaceLiveDiffs";
import {
  workspaceListDirectoryQueryOptions,
  workspaceQueryKeys,
  workspaceReadFileQueryOptions,
} from "~/lib/workspaceReactQuery";
import { cn } from "~/lib/utils";
import { selectProjectByRef, useStore } from "~/store";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";
import { basenameOfPath } from "~/vscode-icons";

import { DiffStatLabel, hasNonZeroStat } from "./chat/DiffStatLabel";
import { VscodeEntryIcon } from "./chat/VscodeEntryIcon";
import { WorkspaceAgentDiffPreview } from "./WorkspaceAgentDiffPreview";
import {
  WorkspacePanelLoadingState,
  WorkspacePanelShell,
  type WorkspacePanelMode,
} from "./WorkspacePanelShell";
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
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { toastManager } from "./ui/toast";

const ROOT_DIRECTORY_KEY = "";
const EMPTY_WORKSPACE_FILE_DIFF_HISTORY: ReadonlyArray<WorkspaceAgentFileDiff> = [];
const EMPTY_WORKSPACE_DIFF_STAT_MAP = new Map<string, { additions: number; deletions: number }>();
const EMPTY_WORKSPACE_DIFF_REVIEW_ITEMS: ReadonlyArray<WorkspaceDiffReviewItem> = [];
const EMPTY_WORKSPACE_DIFF_REVIEW_IDS: ReadonlyArray<string> = [];
const EMPTY_WORKSPACE_WORKING_TREE_FILES: ReadonlyArray<WorkspaceWorkingTreeFileStat> = [];

function buildWorkspaceLiveDiffKey(
  turnKey: string,
  pathValue: string,
  stat: { additions: number; deletions: number },
): string {
  return `working-tree:${turnKey}:${pathValue}:${stat.additions}:${stat.deletions}`;
}

function buildWorkspaceCheckpointDiffKey(entry: WorkspaceAgentFileDiff): string {
  return `checkpoint:${entry.turnId}`;
}

interface WorkspaceResolvedFileDiffState {
  source: "working-tree" | "checkpoint";
  visibilityKey: string;
  stat: {
    additions: number;
    deletions: number;
  };
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
  onToggleDirectory: (directoryPath: string) => void;
  onOpenFile: (relativePath: string) => void;
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
    <button
      type="button"
      className={cn(
        "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left transition-colors",
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
      {props.changed ? (
        <span
          className="ml-auto shrink-0 font-mono text-[10px] tabular-nums"
          data-workspace-entry-diff-state={entry.path}
        >
          {props.diffStat && hasNonZeroStat(props.diffStat) ? (
            <DiffStatLabel
              additions={props.diffStat.additions}
              deletions={props.diffStat.deletions}
            />
          ) : (
            <span className="text-primary/80">changed</span>
          )}
        </span>
      ) : null}
    </button>
  );
});

interface WorkspacePanelProps {
  mode?: WorkspacePanelMode;
}

type WorkspaceFileViewMode = "editor" | "diff";

interface WorkspaceDiffReviewState {
  acceptedHunkIds: ReadonlyArray<string>;
  selectedHunkId: string | null;
}

interface WorkspaceWorkingTreeFileStat {
  path: string;
  insertions: number;
  deletions: number;
}

export default function WorkspacePanel({ mode = "inline" }: WorkspacePanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const settings = useSettings();
  const { resolvedTheme } = useTheme();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThread = useStore(
    useMemo(() => createThreadSelectorByRef(routeThreadRef), [routeThreadRef]),
  );
  const activeProject = useStore((store) =>
    activeThread
      ? selectProjectByRef(store, {
          environmentId: activeThread.environmentId,
          projectId: activeThread.projectId,
        })
      : undefined,
  );
  const activeEnvironmentId = activeThread?.environmentId ?? null;
  const activeWorkspaceRoot = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const workspaceLabel = activeWorkspaceRoot ? basenameOfPath(activeWorkspaceRoot) : "Workspace";
  const workspaceScopeLabel = activeThread?.worktreePath ? "Thread workspace" : "Project workspace";
  const activeRunningTurnKey =
    activeThread?.session?.orchestrationStatus === "running" && activeThread.session.activeTurnId
      ? `${activeThread.environmentId}:${activeThread.id}:${activeThread.session.activeTurnId}`
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
  const currentWorkspaceWorkingTreeFiles = gitStatus.data?.isRepo
    ? gitStatus.data.workingTree.files
    : EMPTY_WORKSPACE_WORKING_TREE_FILES;
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
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [loadingFilePath, setLoadingFilePath] = useState<string | null>(null);
  const [savingFilePath, setSavingFilePath] = useState<string | null>(null);
  const [uploadingDirectoryPath, setUploadingDirectoryPath] = useState<string | null>(null);
  const [dropTargetDirectoryPath, setDropTargetDirectoryPath] = useState<string | null>(null);
  const [fileStateByPath, setFileStateByPath] = useState<Record<string, ProjectReadFileResult>>({});
  const [draftByPath, setDraftByPath] = useState<Record<string, string>>({});
  const [selectedDiffTurnId, setSelectedDiffTurnId] = useState<TurnId | null>(null);
  const [acceptedDiffKeyByPath, setAcceptedDiffKeyByPath] = useState<Record<string, string>>({});
  const [diffReviewStateByKey, setDiffReviewStateByKey] = useState<
    Record<string, WorkspaceDiffReviewState>
  >({});
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
  const observedWorkspaceDiffSignatureRef = useRef("");
  const hasObservedWorkspaceDiffBaselineRef = useRef(false);
  const observedLiveWorkspaceDiffSignatureRef = useRef("");
  const hasObservedLiveWorkspaceDiffBaselineRef = useRef(false);
  const [liveDiffBaselineTurnKey, setLiveDiffBaselineTurnKey] = useState<string | null>(null);
  const [liveDiffBaselineFiles, setLiveDiffBaselineFiles] = useState<
    ReadonlyArray<WorkspaceWorkingTreeFileStat>
  >(EMPTY_WORKSPACE_WORKING_TREE_FILES);

  const loadDirectory = useCallback(
    async (directoryPath: string | null, options?: { force?: boolean }) => {
      if (!activeEnvironmentId || !activeWorkspaceRoot) {
        return;
      }

      const key = directoryKey(directoryPath);
      setLoadingDirectoriesByPath((current) => ({ ...current, [key]: true }));

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

        setDirectoryEntriesByPath((current) => ({
          ...current,
          [key]: result.entries,
        }));
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not load workspace files",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      } finally {
        setLoadingDirectoriesByPath((current) => {
          const next = { ...current };
          delete next[key];
          return next;
        });
      }
    },
    [activeEnvironmentId, activeWorkspaceRoot, queryClient],
  );

  const loadFile = useCallback(
    async (relativePath: string, options?: { force?: boolean }) => {
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
        toastManager.add({
          type: "error",
          title: "Could not open file",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
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
    setOpenTabs([]);
    setActiveFilePath(null);
    setLoadingFilePath(null);
    setSavingFilePath(null);
    setUploadingDirectoryPath(null);
    setDropTargetDirectoryPath(null);
    setFileStateByPath({});
    setDraftByPath({});
    setSelectedDiffTurnId(null);
    setAcceptedDiffKeyByPath({});
    setDiffReviewStateByKey({});
    setFileViewModeByPath({});
    setLiveDiffBaselineTurnKey(null);
    setLiveDiffBaselineFiles(EMPTY_WORKSPACE_WORKING_TREE_FILES);
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
  }, [activeWorkspaceRoot, loadDirectory]);

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

    const directoryPaths = Object.keys(expandedDirectoriesByPath).map((pathValue) =>
      pathValue === ROOT_DIRECTORY_KEY ? null : pathValue,
    );
    void Promise.all(
      directoryPaths.map((directoryPath) => loadDirectory(directoryPath, { force: true })),
    ).catch(() => undefined);

    if (activeFilePath) {
      void loadFile(activeFilePath, { force: true });
    }
  }, [
    activeFilePath,
    activeEnvironmentId,
    activeWorkspaceRoot,
    expandedDirectoriesByPath,
    queryClient,
    loadDirectory,
    loadFile,
  ]);

  useEffect(() => {
    if (activeRunningTurnKey === null) {
      if (liveDiffBaselineTurnKey !== null) {
        setLiveDiffBaselineTurnKey(null);
        setLiveDiffBaselineFiles(EMPTY_WORKSPACE_WORKING_TREE_FILES);
      }
      return;
    }

    if (liveDiffBaselineTurnKey === activeRunningTurnKey) {
      return;
    }

    if (!gitStatus.data?.isRepo) {
      return;
    }

    setLiveDiffBaselineTurnKey(activeRunningTurnKey);
    setLiveDiffBaselineFiles(currentWorkspaceWorkingTreeFiles);
  }, [
    activeRunningTurnKey,
    currentWorkspaceWorkingTreeFiles,
    gitStatus.data?.isRepo,
    liveDiffBaselineTurnKey,
  ]);

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

  const activeFileState = activeFilePath ? (fileStateByPath[activeFilePath] ?? null) : null;
  const activeFileDraft =
    activeFilePath && activeFileState && !activeFileState.isBinary && !activeFileState.tooLarge
      ? (draftByPath[activeFilePath] ?? activeFileState.contents)
      : "";
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
  const activeFileDirty = activeFilePath ? dirtyFilePathSet.has(activeFilePath) : false;
  const activeFileLiveDiffStat =
    activeFilePath !== null ? (liveWorkspaceDiffStatByPath.get(activeFilePath) ?? null) : null;
  const activeFileHasLiveDiff = activeFileLiveDiffStat !== null;
  const activeFileDiffHistory = activeFilePath
    ? (workspaceAgentDiffHistoryByPath.get(activeFilePath) ?? EMPTY_WORKSPACE_FILE_DIFF_HISTORY)
    : EMPTY_WORKSPACE_FILE_DIFF_HISTORY;
  const selectedActiveDiffEntry =
    (selectedDiffTurnId
      ? activeFileDiffHistory.find((entry) => entry.turnId === selectedDiffTurnId)
      : undefined) ??
    activeFileDiffHistory[0] ??
    null;
  const activeVisibleDiffKey =
    activeFilePath === null
      ? null
      : activeFileHasLiveDiff && activeFileLiveDiffStat && activeRunningTurnKey
        ? buildWorkspaceLiveDiffKey(activeRunningTurnKey, activeFilePath, activeFileLiveDiffStat)
        : selectedActiveDiffEntry
          ? buildWorkspaceCheckpointDiffKey(selectedActiveDiffEntry)
          : null;
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
    enabled: activeFilePath !== null && !activeFileDirty && activeFileHasLiveDiff,
  });
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
    activeRenderableInlineFile !== null
      ? buildFileDiffRenderKey(activeRenderableInlineFile)
      : activeVisibleDiffKey;
  const activeReviewItems = useMemo(
    () =>
      activeRenderableInlineFile
        ? buildWorkspaceDiffReviewItems(activeRenderableInlineFile)
        : EMPTY_WORKSPACE_DIFF_REVIEW_ITEMS,
    [activeRenderableInlineFile],
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
    acceptedDiffKeyByPath[activeFilePath] === activeVisibleDiffKey;
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
            `${pathValue.replaceAll("\\", "/")}:${stat.additions}:${stat.deletions}`,
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
    (pathValue: string): WorkspaceResolvedFileDiffState | null => {
      const normalizedPath = pathValue.replaceAll("\\", "/");
      const liveDiffStat = liveWorkspaceDiffStatByPath.get(normalizedPath) ?? null;
      if (liveDiffStat !== null && activeRunningTurnKey !== null) {
        const visibilityKey = buildWorkspaceLiveDiffKey(
          activeRunningTurnKey,
          normalizedPath,
          liveDiffStat,
        );
        if (acceptedDiffKeyByPath[normalizedPath] === visibilityKey) {
          return null;
        }
        return {
          source: "working-tree",
          visibilityKey,
          stat: liveDiffStat,
        };
      }

      const latestCheckpointDiff = workspaceAgentDiffHistoryByPath.get(normalizedPath)?.[0] ?? null;
      if (!latestCheckpointDiff) {
        return null;
      }

      const visibilityKey = buildWorkspaceCheckpointDiffKey(latestCheckpointDiff);
      if (acceptedDiffKeyByPath[normalizedPath] === visibilityKey) {
        return null;
      }

      return {
        source: "checkpoint",
        visibilityKey,
        stat: latestCheckpointDiff.stat,
      };
    },
    [
      acceptedDiffKeyByPath,
      activeRunningTurnKey,
      liveWorkspaceDiffStatByPath,
      workspaceAgentDiffHistoryByPath,
    ],
  );
  const openFileDiff = useCallback(
    (turnId: TurnId, filePath: string) => {
      if (!activeThread) {
        return;
      }

      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, activeThread.id)),
        search: (previous) => {
          const rest = stripDiffSearchParams(previous);
          return { ...rest, diff: "1", diffTurnId: turnId, diffFilePath: filePath };
        },
      });
    },
    [activeThread, navigate],
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
  const openFileFromPreview = useCallback(
    (relativePath: string) => {
      openFile(relativePath);
      showFileViewForPath(relativePath, "diff");
    },
    [openFile, showFileViewForPath],
  );
  const selectDiffTurnFromPreview = useCallback(
    (turnId: TurnId) => {
      setSelectedDiffTurnId(turnId);
      if (activeFilePath) {
        showFileViewForPath(activeFilePath, "diff");
      }
    },
    [activeFilePath, showFileViewForPath],
  );
  const markActiveVisibleDiffAccepted = useCallback(() => {
    if (!activeFilePath || !activeVisibleDiffKey) {
      return;
    }

    setAcceptedDiffKeyByPath((current) => ({
      ...current,
      [activeFilePath]: activeVisibleDiffKey,
    }));
    showFileViewForPath(activeFilePath, "editor");
  }, [activeFilePath, activeVisibleDiffKey, showFileViewForPath]);
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
    [activeVisibleDiffReviewKey],
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
    }
  }, [
    activeFilePath,
    activeRemainingReviewItems,
    activeReviewItems.length,
    activeSelectedReviewItem,
    activeVisibleDiffKey,
    activeVisibleDiffReviewKey,
    markActiveVisibleDiffAccepted,
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
    if (
      !activeFilePath ||
      !activeVisibleDiffKey ||
      !activeVisibleDiffAccepted ||
      activeReviewItems.length === 0 ||
      activeRemainingReviewItems.length === 0
    ) {
      return;
    }

    setAcceptedDiffKeyByPath((current) => {
      if (current[activeFilePath] !== activeVisibleDiffKey) {
        return current;
      }

      const next = { ...current };
      delete next[activeFilePath];
      return next;
    });
  }, [
    acceptedDiffKeyByPath,
    activeFilePath,
    activeRemainingReviewItems.length,
    activeReviewItems.length,
    activeVisibleDiffAccepted,
    activeVisibleDiffKey,
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

    if (activeFilePath && !activeFileDirty && activeFileHasLiveDiff) {
      void loadFile(activeFilePath, { force: true });
    }
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    activeThread?.updatedAt,
    activeThread?.session?.activeTurnId,
    activeThread?.session?.orchestrationStatus,
    activeFileDirty,
    activeFileHasLiveDiff,
    activeFilePath,
    loadFile,
    queryClient,
  ]);

  useEffect(() => {
    if (
      !activeEnvironmentId ||
      !activeWorkspaceRoot ||
      activeThread?.session?.orchestrationStatus !== "running"
    ) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshGitStatus({
        environmentId: activeEnvironmentId,
        cwd: activeWorkspaceRoot,
      }).catch(() => undefined);
      void queryClient.invalidateQueries({
        queryKey: gitQueryKeys.workingTreeDiffs(activeEnvironmentId, activeWorkspaceRoot),
      });

      if (activeFilePath && !activeFileDirty && activeFileHasLiveDiff) {
        void loadFile(activeFilePath, { force: true });
      }
    }, 2_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [
    activeEnvironmentId,
    activeWorkspaceRoot,
    activeThread?.session?.orchestrationStatus,
    activeFileDirty,
    activeFileHasLiveDiff,
    activeFilePath,
    loadFile,
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

    const directoryPaths = Object.keys(expandedDirectoriesByPath).map((pathValue) =>
      pathValue === ROOT_DIRECTORY_KEY ? null : pathValue,
    );
    void Promise.all(
      directoryPaths.map((directoryPath) => loadDirectory(directoryPath, { force: true })),
    ).catch(() => undefined);

    for (const filePath of openTabs) {
      if (dirtyFilePathSet.has(filePath)) {
        continue;
      }
      void loadFile(filePath, { force: true });
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
    expandedDirectoriesByPath,
    loadDirectory,
    loadFile,
    openTabs,
    queryClient,
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

    const directoryPaths = Object.keys(expandedDirectoriesByPath).map((pathValue) =>
      pathValue === ROOT_DIRECTORY_KEY ? null : pathValue,
    );
    void Promise.all(
      directoryPaths.map((directoryPath) => loadDirectory(directoryPath, { force: true })),
    ).catch(() => undefined);

    for (const filePath of openTabs) {
      if (dirtyFilePathSet.has(filePath)) {
        continue;
      }
      void loadFile(filePath, { force: true });
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
    expandedDirectoriesByPath,
    liveWorkspaceDiffSignature,
    liveWorkspaceDiffStatByPath,
    loadDirectory,
    loadFile,
    openTabs,
    queryClient,
    resolveLatestVisibleDiffState,
  ]);

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
      await queryClient.invalidateQueries({
        queryKey: workspaceQueryKeys.file(activeEnvironmentId, activeWorkspaceRoot, activeFilePath),
      });
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
            onToggleDirectory={toggleDirectory}
            onOpenFile={openFile}
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
      toggleDirectory,
    ],
  );

  const header = (
    <>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-foreground">{workspaceLabel}</div>
        <div className="truncate text-[11px] text-muted-foreground/70">
          {activeWorkspaceRoot ?? "No active workspace"}
        </div>
      </div>
      <div className="flex items-center gap-1 [-webkit-app-region:no-drag]">
        <span className="rounded-full border border-border/70 bg-background/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
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
      </div>
    </>
  );

  if (!activeThread || !activeWorkspaceRoot) {
    return (
      <WorkspacePanelShell mode={mode} header={header}>
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Open a thread with a workspace to browse and edit files.
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
      <div className="grid min-h-0 flex-1 grid-cols-[16rem_minmax(0,1fr)]">
        <div className="flex min-h-0 min-w-0 flex-col border-r border-border/60 bg-card/15">
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
            </div>
          </div>
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
            activeFileState &&
            !activeFileState.isBinary &&
            !activeFileState.tooLarge ? (
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
                  <div className="flex items-center gap-1">
                    <Button
                      type="button"
                      size="xs"
                      variant={activeFileViewMode === "diff" ? "default" : "outline"}
                      disabled={!canShowActiveInlineDiff}
                      aria-label="Show agent diff inline"
                      onClick={showActiveFileDiff}
                    >
                      Diff
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant={activeFileViewMode === "editor" ? "default" : "outline"}
                      aria-label="Show file contents"
                      onClick={showActiveFileContents}
                    >
                      File
                    </Button>
                  </div>
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
              ) : activeFileState && activeFileViewMode === "diff" && canShowActiveInlineDiff ? (
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
                        <div className="min-w-0">
                          <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                            Review changes
                          </div>
                          <div
                            className="mt-0.5 text-[11px] text-muted-foreground/80"
                            aria-live="polite"
                            data-workspace-diff-review-status
                          >
                            {activeSelectedReviewItem
                              ? `Change ${activeSelectedReviewPosition} of ${activeRemainingReviewItems.length} · ${activeSelectedReviewItem.lineLabel}`
                              : `${activeRemainingReviewItems.length} changes remaining`}
                          </div>
                        </div>
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => moveActiveReviewSelection(-1)}
                            disabled={activeSelectedReviewPosition <= 1}
                            aria-label="Review previous change"
                          >
                            Previous
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() => moveActiveReviewSelection(1)}
                            disabled={
                              activeRemainingReviewItems.length <= 1 ||
                              activeSelectedReviewPosition === activeRemainingReviewItems.length
                            }
                            aria-label="Review next change"
                          >
                            Next
                          </Button>
                          <Button
                            type="button"
                            size="xs"
                            onClick={acceptActiveReviewSelection}
                            aria-label="Accept the current change"
                          >
                            Accept change
                          </Button>
                        </div>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {activeRemainingReviewItems.map((reviewItem, index) => {
                          const selected = reviewItem.id === activeSelectedReviewItem?.id;
                          return (
                            <Button
                              key={reviewItem.id}
                              type="button"
                              size="xs"
                              variant={selected ? "default" : "outline"}
                              aria-pressed={selected}
                              aria-label={`Jump to change ${index + 1}, ${reviewItem.lineLabel}`}
                              onClick={() => selectActiveReviewItem(reviewItem.id)}
                            >
                              {index + 1}. {reviewItem.lineLabel}
                            </Button>
                          );
                        })}
                      </div>
                      <div className="mt-1 text-[10px] text-muted-foreground/65">
                        Use arrow keys or J/K to move between changes, then press Enter to accept.
                      </div>
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

            {activeFilePath && activeFileDiffHistory.length > 0 ? (
              <WorkspaceAgentDiffPreview
                environmentId={activeThread.environmentId}
                threadId={activeThread.id}
                filePath={activeFilePath}
                fileHistory={activeFileDiffHistory}
                turnFilesByTurnId={workspaceAgentDiffTurnFilesByTurnId}
                selectedTurnId={selectedDiffTurnId}
                resolvedTheme={resolvedTheme}
                onSelectTurnId={selectDiffTurnFromPreview}
                onOpenFile={openFileFromPreview}
                onOpenFullDiff={openFileDiff}
              />
            ) : null}
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
