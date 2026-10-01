/**
 * Parse and serialize Jupyter notebooks (`.ipynb`, nbformat v4) for the
 * workspace notebook view. The workspace treats a file as a single string
 * draft, so this turns that string into editable cells and back without losing
 * the parts we do not touch (metadata, nbformat version, kernel spec).
 */

export type NotebookCellType = "code" | "markdown" | "raw";

export interface NotebookStreamOutput {
  readonly kind: "stream";
  readonly name: "stdout" | "stderr";
  readonly text: string;
}
export interface NotebookTextOutput {
  readonly kind: "text";
  readonly text: string;
}
export interface NotebookImageOutput {
  readonly kind: "image";
  readonly mime: string;
  readonly base64: string;
}
export interface NotebookHtmlOutput {
  readonly kind: "html";
  readonly html: string;
}
export interface NotebookErrorOutput {
  readonly kind: "error";
  readonly ename: string;
  readonly evalue: string;
  readonly traceback: string;
}
export type NotebookOutput =
  | NotebookStreamOutput
  | NotebookTextOutput
  | NotebookImageOutput
  | NotebookHtmlOutput
  | NotebookErrorOutput;

export interface NotebookCell {
  readonly id: string;
  readonly cellType: NotebookCellType;
  readonly source: string;
  readonly executionCount: number | null;
  readonly outputs: readonly NotebookOutput[];
}

export interface ParsedNotebook {
  readonly valid: boolean;
  readonly cells: readonly NotebookCell[];
  /** The original parsed JSON, kept so serialize can preserve untouched fields. */
  readonly raw: Record<string, unknown> | null;
  readonly error?: string;
}

/** nbformat stores source/text as a string or an array of line strings. */
function joinMultiline(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.map((line) => (typeof line === "string" ? line : "")).join("");
  return "";
}

/** Strip ANSI colour codes so a traceback reads cleanly in the browser. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control chars by definition
  return text.replace(/\[[0-9;]*m/g, "");
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export function normalizeNotebookOutput(raw: unknown): NotebookOutput | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  switch (o["output_type"]) {
    case "stream":
      return {
        kind: "stream",
        name: o["name"] === "stderr" ? "stderr" : "stdout",
        text: joinMultiline(o["text"]),
      };
    case "error":
      return {
        kind: "error",
        ename: typeof o["ename"] === "string" ? o["ename"] : "",
        evalue: typeof o["evalue"] === "string" ? o["evalue"] : "",
        // Traceback is a list of lines with no trailing newlines, so join on "\n"
        // (source/stream text, by contrast, carries its own newlines per line).
        traceback: stripAnsi(
          Array.isArray(o["traceback"])
            ? (o["traceback"] as unknown[]).map((l) => (typeof l === "string" ? l : "")).join("\n")
            : joinMultiline(o["traceback"]),
        ),
      };
    case "execute_result":
    case "display_data": {
      const data = (o["data"] ?? {}) as Record<string, unknown>;
      const imageMime = IMAGE_MIMES.find((mime) => data[mime] !== undefined);
      if (imageMime) {
        return {
          kind: "image",
          mime: imageMime,
          base64: joinMultiline(data[imageMime]).replace(/\s+/g, ""),
        };
      }
      if (data["text/html"] !== undefined) {
        return { kind: "html", html: joinMultiline(data["text/html"]) };
      }
      if (data["text/plain"] !== undefined) {
        return { kind: "text", text: joinMultiline(data["text/plain"]) };
      }
      return null;
    }
    default:
      return null;
  }
}

let cellIdCounter = 0;
export function nextCellId(): string {
  cellIdCounter += 1;
  return `cell-${Date.now().toString(36)}-${cellIdCounter}`;
}

/** True for a path the notebook view should handle. */
export function isNotebookPath(path: string | null | undefined): boolean {
  return typeof path === "string" && path.toLowerCase().endsWith(".ipynb");
}

export function parseNotebook(json: string): ParsedNotebook {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(json) as Record<string, unknown>;
  } catch (error) {
    return {
      valid: false,
      cells: [],
      raw: null,
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
  const rawCells = Array.isArray(raw["cells"]) ? (raw["cells"] as unknown[]) : null;
  if (!rawCells) {
    return { valid: false, cells: [], raw, error: "Not a notebook (no cells array)." };
  }
  const cells = rawCells.map((entry, index): NotebookCell => {
    const c = (entry ?? {}) as Record<string, unknown>;
    const cellType: NotebookCellType =
      c["cell_type"] === "markdown" ? "markdown" : c["cell_type"] === "raw" ? "raw" : "code";
    const outputs =
      cellType === "code" && Array.isArray(c["outputs"])
        ? (c["outputs"] as unknown[])
            .map(normalizeNotebookOutput)
            .filter((o): o is NotebookOutput => o !== null)
        : [];
    return {
      id: typeof c["id"] === "string" ? (c["id"] as string) : `cell-${index}`,
      cellType,
      source: joinMultiline(c["source"]),
      executionCount:
        typeof c["execution_count"] === "number" ? (c["execution_count"] as number) : null,
      outputs,
    };
  });
  return { valid: true, cells, raw };
}

/** nbformat prefers source as a list of lines, each keeping its trailing "\n". */
export function toSourceLines(source: string): string[] {
  if (source === "") return [];
  const parts = source.split("\n");
  return parts
    .map((line, index) => (index < parts.length - 1 ? `${line}\n` : line))
    .filter(
      (_, i, arr) =>
        // drop a trailing empty string produced by a final newline
        !(i === arr.length - 1 && arr[i] === ""),
    );
}

function outputToNbformat(output: NotebookOutput): Record<string, unknown> {
  switch (output.kind) {
    case "stream":
      return { output_type: "stream", name: output.name, text: output.text };
    case "error":
      return {
        output_type: "error",
        ename: output.ename,
        evalue: output.evalue,
        traceback: output.traceback.split("\n"),
      };
    case "image":
      return {
        output_type: "execute_result",
        data: { [output.mime]: output.base64 },
        metadata: {},
      };
    case "html":
      return { output_type: "execute_result", data: { "text/html": output.html }, metadata: {} };
    case "text":
      return { output_type: "execute_result", data: { "text/plain": output.text }, metadata: {} };
  }
}

/**
 * Rebuild the notebook JSON, keeping every top-level field the parse did not
 * touch and rewriting only the cells. Round-trips through the parsed `raw`.
 */
export function serializeNotebook(parsed: ParsedNotebook, cells: readonly NotebookCell[]): string {
  const base: Record<string, unknown> = parsed.raw ? { ...parsed.raw } : {};
  if (typeof base["nbformat"] !== "number") base["nbformat"] = 4;
  if (typeof base["nbformat_minor"] !== "number") base["nbformat_minor"] = 5;
  if (!base["metadata"] || typeof base["metadata"] !== "object") base["metadata"] = {};
  base["cells"] = cells.map((cell) => {
    const out: Record<string, unknown> = {
      cell_type: cell.cellType,
      id: cell.id,
      metadata: {},
      source: toSourceLines(cell.source),
    };
    if (cell.cellType === "code") {
      out["execution_count"] = cell.executionCount;
      out["outputs"] = cell.outputs.map(outputToNbformat);
    }
    return out;
  });
  return `${JSON.stringify(base, null, 1)}\n`;
}

export function makeEmptyCell(cellType: NotebookCellType): NotebookCell {
  return { id: nextCellId(), cellType, source: "", executionCount: null, outputs: [] };
}
