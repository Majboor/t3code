import Editor from "@monaco-editor/react";
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
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { ensureEnvironmentApi } from "~/environmentApi";
import { stripDiffSearchParams } from "~/diffRouteSearch";
import { useTheme } from "~/hooks/useTheme";
import { useTurnDiffSummaries } from "~/hooks/useTurnDiffSummaries";
import { buildWorkspaceAgentFileDiffHistory } from "~/lib/workspaceAgentDiffs";
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
  agentChanged: boolean;
  agentDiffStat?: { additions: number; deletions: number } | null;
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
        props.agentChanged && "text-foreground/90",
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
      {props.agentChanged ? (
        <span className="ml-auto shrink-0 font-mono text-[10px] tabular-nums">
          {props.agentDiffStat && hasNonZeroStat(props.agentDiffStat) ? (
            <DiffStatLabel
              additions={props.agentDiffStat.additions}
              deletions={props.agentDiffStat.deletions}
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

export default function WorkspacePanel({ mode = "inline" }: WorkspacePanelProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
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
  const activeWorkspaceRoot = activeThread?.worktreePath ?? activeProject?.cwd ?? null;
  const workspaceLabel = activeWorkspaceRoot ? basenameOfPath(activeWorkspaceRoot) : "Workspace";
  const workspaceScopeLabel = activeThread?.worktreePath ? "Thread workspace" : "Project workspace";
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const workspaceAgentDiffHistoryByPath = useMemo(
    () =>
      buildWorkspaceAgentFileDiffHistory(turnDiffSummaries, inferredCheckpointTurnCountByTurnId),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );
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

  const loadDirectory = useCallback(
    async (directoryPath: string | null) => {
      if (!activeThread || !activeWorkspaceRoot) {
        return;
      }

      const key = directoryKey(directoryPath);
      setLoadingDirectoriesByPath((current) => ({ ...current, [key]: true }));

      try {
        const result = await queryClient.fetchQuery(
          workspaceListDirectoryQueryOptions({
            environmentId: activeThread.environmentId,
            cwd: activeWorkspaceRoot,
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
    [activeThread, activeWorkspaceRoot, queryClient],
  );

  const loadFile = useCallback(
    async (relativePath: string) => {
      if (!activeThread || !activeWorkspaceRoot) {
        return;
      }

      setLoadingFilePath(relativePath);

      try {
        const result = await queryClient.fetchQuery(
          workspaceReadFileQueryOptions({
            environmentId: activeThread.environmentId,
            cwd: activeWorkspaceRoot,
            relativePath,
          }),
        );

        if (workspaceRootRef.current !== activeWorkspaceRoot) {
          return;
        }

        setFileStateByPath((current) => ({
          ...current,
          [relativePath]: result,
        }));
        setDraftByPath((current) => {
          if (current[relativePath] !== undefined || result.isBinary || result.tooLarge) {
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
    [activeThread, activeWorkspaceRoot, queryClient],
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
    if (!activeThread || !activeWorkspaceRoot) {
      return;
    }

    const directoryPaths = Object.keys(expandedDirectoriesByPath).map((pathValue) =>
      pathValue === ROOT_DIRECTORY_KEY ? null : pathValue,
    );
    void Promise.all(directoryPaths.map((directoryPath) => loadDirectory(directoryPath))).catch(
      () => undefined,
    );

    if (activeFilePath) {
      void loadFile(activeFilePath);
    }

    void queryClient.invalidateQueries({
      queryKey: workspaceQueryKeys.all,
    });
  }, [
    activeFilePath,
    activeThread,
    activeWorkspaceRoot,
    expandedDirectoriesByPath,
    loadDirectory,
    loadFile,
    queryClient,
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
  const activeFileDiffHistory = activeFilePath
    ? (workspaceAgentDiffHistoryByPath.get(activeFilePath) ?? [])
    : [];

  const actionDirectoryPath =
    selectedEntry.kind === "directory"
      ? selectedEntry.path
      : selectedEntry.kind === "file"
        ? parentDirectoryOf(selectedEntry.path)
        : activeFilePath
          ? parentDirectoryOf(activeFilePath)
          : null;
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

  const saveActiveFile = useCallback(async () => {
    if (!activeThread || !activeWorkspaceRoot || !activeFilePath || !activeFileState) {
      return;
    }

    if (activeFileState.isBinary || activeFileState.tooLarge || !activeFileDirty) {
      return;
    }

    const nextContents = draftByPath[activeFilePath] ?? activeFileState.contents;
    setSavingFilePath(activeFilePath);

    try {
      const api = ensureEnvironmentApi(activeThread.environmentId);
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
        queryKey: workspaceQueryKeys.file(
          activeThread.environmentId,
          activeWorkspaceRoot,
          activeFilePath,
        ),
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
    activeFileDirty,
    activeFilePath,
    activeFileState,
    activeThread,
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
    if (!activeThread || !activeWorkspaceRoot || !trimmedName) {
      return;
    }

    const relativePath = joinRelativePath(actionDirectoryPath, trimmedName);
    try {
      const api = ensureEnvironmentApi(activeThread.environmentId);
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
    activeThread,
    activeWorkspaceRoot,
    closeCreateEntryDialog,
    createDialogState.kind,
    createDialogState.name,
    loadDirectory,
    openFile,
  ]);

  const uploadFilesToDirectory = useCallback(
    async (files: readonly File[], directoryPath: string | null) => {
      if (!activeThread || !activeWorkspaceRoot || files.length === 0) {
        return;
      }

      setUploadingDirectoryPath(directoryPath);

      try {
        const api = ensureEnvironmentApi(activeThread.environmentId);

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
    [activeThread, activeWorkspaceRoot, loadDirectory],
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
        const isDirectoryExpanded = Boolean(expandedDirectoriesByPath[directoryKey(entry.path)]);
        const childEntries = directoryEntriesByPath[directoryKey(entry.path)] ?? [];
        const latestAgentDiff = workspaceAgentDiffHistoryByPath.get(entry.path)?.[0] ?? null;
        return (
          <WorkspaceExplorerRow
            key={entry.path}
            depth={depth}
            entry={entry}
            expanded={isDirectoryExpanded}
            loading={Boolean(loadingDirectoriesByPath[directoryKey(entry.path)])}
            selected={selectedEntry.path === entry.path}
            dropTarget={dropTargetDirectoryPath === entry.path}
            resolvedTheme={resolvedTheme}
            agentChanged={latestAgentDiff !== null}
            agentDiffStat={latestAgentDiff?.stat ?? null}
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
      selectedEntry.path,
      toggleDirectory,
      workspaceAgentDiffHistoryByPath,
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
                  const latestAgentDiff = workspaceAgentDiffHistoryByPath.get(tabPath)?.[0] ?? null;
                  return (
                    <div
                      key={tabPath}
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
                        {!dirty && latestAgentDiff ? (
                          <span className="font-mono text-[9px] tabular-nums text-muted-foreground/80">
                            {hasNonZeroStat(latestAgentDiff.stat) ? (
                              <DiffStatLabel
                                additions={latestAgentDiff.stat.additions}
                                deletions={latestAgentDiff.stat.deletions}
                              />
                            ) : (
                              "agent"
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
              ) : activeFileState ? (
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
                resolvedTheme={resolvedTheme}
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
