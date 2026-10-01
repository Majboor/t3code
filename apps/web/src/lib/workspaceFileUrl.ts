/**
 * URLs for `GET /api/workspace/file` (apps/server/src/workspace/fileHttp.ts) and the
 * extension → viewer mapping shared by the workspace panel and chat file links.
 */
export type WorkspaceMediaKind = "image" | "video" | "audio" | "pdf" | "office";

/** Office formats the server renders to PDF with LibreOffice for the inline viewer. */
export const OFFICE_EXTENSIONS = new Set([
  "doc",
  "docx",
  "dot",
  "dotx",
  "odt",
  "ott",
  "rtf",
  "wps",
  "ppt",
  "pptx",
  "pps",
  "ppsx",
  "pot",
  "potx",
  "odp",
  "otp",
  "key",
  "xls",
  "xlsx",
  "xlsm",
  "ods",
  "ots",
  "numbers",
  "pages",
]);

export function fileExtension(path: string): string {
  return path.toLowerCase().split(".").pop() ?? "";
}

/** Which media element (if any) can preview a file by its extension. */
export function mediaKindForPath(path: string): WorkspaceMediaKind | null {
  const ext = fileExtension(path);
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif"].includes(ext))
    return "image";
  if (["mp4", "webm", "mov", "m4v", "ogv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "oga", "m4a", "flac", "aac"].includes(ext)) return "audio";
  if (ext === "pdf") return "pdf";
  if (OFFICE_EXTENSIONS.has(ext)) return "office";
  return null;
}

export function workspaceFileUrl(
  cwd: string,
  relativePath: string,
  options?: { readonly convert?: "pdf" | undefined; readonly download?: boolean | undefined },
): string {
  let url = `/api/workspace/file?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(relativePath)}`;
  if (options?.convert) url += `&convert=${options.convert}`;
  if (options?.download) url += "&download=1";
  return url;
}

/** The URL a browser tab can show for this file: Office → converted PDF, everything else raw. */
export function workspaceFileViewUrl(cwd: string, relativePath: string): string {
  return workspaceFileUrl(cwd, relativePath, {
    convert: mediaKindForPath(relativePath) === "office" ? "pdf" : undefined,
  });
}

/** Relative path of an absolute file inside `cwd`, or null when it lives elsewhere. */
export function relativeWorkspacePath(
  cwd: string | undefined,
  absolutePath: string,
): string | null {
  if (!cwd) return null;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return absolutePath.startsWith(root) ? absolutePath.slice(root.length) : null;
}
