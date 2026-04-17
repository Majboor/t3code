import type {
  EnvironmentId,
  ProjectListDirectoryResult,
  ProjectReadFileResult,
} from "@t3tools/contracts";
import { queryOptions } from "@tanstack/react-query";
import { ensureEnvironmentApi } from "~/environmentApi";

const DEFAULT_DIRECTORY_STALE_TIME = 15_000;
const DEFAULT_FILE_STALE_TIME = 10_000;

const EMPTY_DIRECTORY_RESULT: ProjectListDirectoryResult = {
  entries: [],
};

export const workspaceQueryKeys = {
  all: ["workspace"] as const,
  directory: (
    environmentId: EnvironmentId | null,
    cwd: string | null,
    directoryPath: string | null,
  ) => ["workspace", "directory", environmentId ?? null, cwd, directoryPath ?? null] as const,
  file: (environmentId: EnvironmentId | null, cwd: string | null, relativePath: string | null) =>
    ["workspace", "file", environmentId ?? null, cwd, relativePath ?? null] as const,
};

export function workspaceListDirectoryQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  directoryPath?: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: workspaceQueryKeys.directory(
      input.environmentId,
      input.cwd,
      input.directoryPath ?? null,
    ),
    queryFn: async () => {
      if (!input.cwd || !input.environmentId) {
        throw new Error("Workspace directory listing is unavailable.");
      }

      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.listDirectory({
        cwd: input.cwd,
        ...(input.directoryPath ? { directoryPath: input.directoryPath } : {}),
      });
    },
    enabled: (input.enabled ?? true) && input.environmentId !== null && input.cwd !== null,
    staleTime: input.staleTime ?? DEFAULT_DIRECTORY_STALE_TIME,
    placeholderData: (previous) => previous ?? EMPTY_DIRECTORY_RESULT,
  });
}

export function workspaceReadFileQueryOptions(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  relativePath: string | null;
  enabled?: boolean;
  staleTime?: number;
}) {
  return queryOptions({
    queryKey: workspaceQueryKeys.file(input.environmentId, input.cwd, input.relativePath),
    queryFn: async (): Promise<ProjectReadFileResult> => {
      if (!input.cwd || !input.environmentId || !input.relativePath) {
        throw new Error("Workspace file reading is unavailable.");
      }

      const api = ensureEnvironmentApi(input.environmentId);
      return api.projects.readFile({
        cwd: input.cwd,
        relativePath: input.relativePath,
      });
    },
    enabled:
      (input.enabled ?? true) &&
      input.environmentId !== null &&
      input.cwd !== null &&
      input.relativePath !== null,
    staleTime: input.staleTime ?? DEFAULT_FILE_STALE_TIME,
  });
}
