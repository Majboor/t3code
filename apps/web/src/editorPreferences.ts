import { EDITORS, EditorId, LocalApi } from "@t3tools/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";

const LAST_EDITOR_KEY = "t3code:last-editor";

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export interface OpenInPreferredEditorOptions {
  /**
   * Where a browser can show the file when this machine has no desktop editor
   * (hosted/web deployments): the file is opened in a new tab instead of failing.
   */
  readonly fallbackUrl?: string | null | undefined;
}

export async function openInPreferredEditor(
  api: LocalApi,
  targetPath: string,
  options?: OpenInPreferredEditorOptions,
): Promise<EditorId | "browser"> {
  const { availableEditors } = await api.server.getConfig();
  const editor = resolveAndPersistPreferredEditor(availableEditors);
  if (!editor) {
    if (options?.fallbackUrl && typeof window !== "undefined") {
      window.open(options.fallbackUrl, "_blank", "noopener");
      return "browser";
    }
    throw new Error("No available editors found.");
  }
  await api.shell.openInEditor(targetPath, editor);
  return editor;
}
