import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  PlayIcon,
  PlusIcon,
  Trash2Icon,
  ChevronUpIcon,
  ChevronDownIcon,
  SquareIcon,
} from "lucide-react";

import ChatMarkdown from "../ChatMarkdown";
import { cn } from "~/lib/utils";
import {
  makeEmptyCell,
  type NotebookCell,
  type NotebookCellType,
  type NotebookOutput,
  parseNotebook,
  type ParsedNotebook,
  serializeNotebook,
} from "./notebookModel.logic";

/** One streamed kernel event, shaped for the view to append live outputs. */
export type NotebookExecuteEvent =
  | { readonly type: "output"; readonly output: NotebookOutput }
  | { readonly type: "execution_count"; readonly count: number }
  | { readonly type: "status"; readonly busy: boolean }
  | { readonly type: "error"; readonly message: string };

export interface NotebookExecuteHandle {
  readonly cancel: () => void;
  readonly done: Promise<void>;
}

export interface NotebookViewProps {
  readonly value: string;
  readonly onChange: (json: string) => void;
  readonly cwd?: string | undefined;
  /**
   * Runs a code cell and streams kernel events. Absent = no live kernel (the
   * view is render/edit only). Provided in the execution phase.
   */
  readonly execute?:
    | ((code: string, onEvent: (event: NotebookExecuteEvent) => void) => NotebookExecuteHandle)
    | undefined;
  readonly onRestartKernel?: (() => void) | undefined;
}

/** Drop <script>/<style> so a DataFrame's HTML output can render but not run. */
function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/ on[a-z]+="[^"]*"/gi, "")
    .replace(/ on[a-z]+='[^']*'/gi, "");
}

function OutputBlock({ output }: { output: NotebookOutput }) {
  switch (output.kind) {
    case "stream":
      return (
        <pre
          className={cn(
            "overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-1.5 font-mono text-[11px] leading-relaxed",
            output.name === "stderr" ? "text-destructive/90" : "text-foreground/85",
          )}
        >
          {output.text}
        </pre>
      );
    case "text":
      return (
        <pre className="overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-1.5 font-mono text-[11px] leading-relaxed text-foreground/85">
          {output.text}
        </pre>
      );
    case "image":
      return (
        <div className="px-3 py-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- data URI, no host */}
          <img
            alt="cell output"
            className="max-w-full rounded"
            src={`data:${output.mime};base64,${output.base64}`}
          />
        </div>
      );
    case "html":
      return (
        <div
          className="notebook-html-output overflow-auto px-3 py-2 text-[11px] text-foreground/85"
          // eslint-disable-next-line react/no-danger -- sanitized above; internal tool
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(output.html) }}
        />
      );
    case "error":
      return (
        <pre className="overflow-auto whitespace-pre-wrap wrap-break-word px-3 py-1.5 font-mono text-[11px] leading-relaxed text-destructive/90">
          {output.ename ? `${output.ename}: ${output.evalue}\n` : ""}
          {output.traceback}
        </pre>
      );
  }
}

function autoRows(source: string): number {
  const lines = source ? source.split("\n").length : 1;
  return Math.min(Math.max(lines, 1), 24);
}

function CodeCell({
  cell,
  running,
  canRun,
  onChange,
  onRun,
  onStop,
}: {
  cell: NotebookCell;
  running: boolean;
  canRun: boolean;
  onChange: (source: string) => void;
  onRun: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex gap-2">
      <div className="flex w-10 shrink-0 flex-col items-center gap-1 pt-1.5">
        {canRun ? (
          <button
            type="button"
            aria-label={running ? "Stop cell" : "Run cell"}
            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-secondary hover:text-foreground"
            onClick={running ? onStop : onRun}
          >
            {running ? <SquareIcon className="size-3.5" /> : <PlayIcon className="size-3.5" />}
          </button>
        ) : null}
        <span className="font-mono text-[10px] text-muted-foreground/60">
          {running ? "[*]" : cell.executionCount !== null ? `[${cell.executionCount}]` : "[ ]"}
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <textarea
          spellCheck={false}
          value={cell.source}
          rows={autoRows(cell.source)}
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (canRun && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              onRun();
            }
          }}
          className="w-full resize-y rounded-md border border-border/60 bg-background/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:border-ring"
        />
        {cell.outputs.length > 0 ? (
          <div className="mt-1 divide-y divide-border/40 rounded-md border border-border/40 bg-card/60">
            {cell.outputs.map((output, index) => (
              <OutputBlock key={index} output={output} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MarkdownCell({
  cell,
  cwd,
  onChange,
}: {
  cell: NotebookCell;
  cwd: string | undefined;
  onChange: (source: string) => void;
}) {
  const [editing, setEditing] = useState(cell.source.trim().length === 0);
  return (
    <div className="flex gap-2">
      <div className="w-10 shrink-0 pt-1.5 text-center font-mono text-[10px] text-muted-foreground/50">
        md
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <textarea
            autoFocus
            spellCheck={false}
            value={cell.source}
            rows={autoRows(cell.source)}
            onChange={(event) => onChange(event.currentTarget.value)}
            onBlur={() => cell.source.trim().length > 0 && setEditing(false)}
            className="w-full resize-y rounded-md border border-border/60 bg-background/70 px-3 py-2 font-mono text-[12px] leading-relaxed text-foreground outline-none focus:border-ring"
          />
        ) : (
          <div
            className="prose-notebook cursor-text rounded-md px-1 py-1 text-sm hover:bg-secondary/30"
            onDoubleClick={() => setEditing(true)}
            title="Double-click to edit"
          >
            <ChatMarkdown text={cell.source} cwd={cwd ?? ""} isStreaming={false} />
          </div>
        )}
      </div>
    </div>
  );
}

function NotebookView({ value, onChange, cwd, execute, onRestartKernel }: NotebookViewProps) {
  const parsedRef = useRef<ParsedNotebook>(parseNotebook(value));
  const lastEmittedRef = useRef<string>(value);
  const [cells, setCells] = useState<readonly NotebookCell[]>(() => parsedRef.current.cells);
  const [runningCellId, setRunningCellId] = useState<string | null>(null);
  const runHandleRef = useRef<NotebookExecuteHandle | null>(null);

  // Re-parse only when the file changes underneath us (reload/agent edit),
  // never in response to our own serialized output.
  useEffect(() => {
    if (value === lastEmittedRef.current) return;
    const parsed = parseNotebook(value);
    parsedRef.current = parsed;
    lastEmittedRef.current = value;
    setCells(parsed.cells);
  }, [value]);

  const commit = useCallback(
    (nextCells: readonly NotebookCell[]) => {
      setCells(nextCells);
      const json = serializeNotebook(parsedRef.current, nextCells);
      lastEmittedRef.current = json;
      onChange(json);
    },
    [onChange],
  );

  const updateCell = useCallback(
    (id: string, patch: Partial<NotebookCell>) =>
      commit(cells.map((cell) => (cell.id === id ? { ...cell, ...patch } : cell))),
    [cells, commit],
  );
  const addCell = useCallback(
    (type: NotebookCellType) => commit([...cells, makeEmptyCell(type)]),
    [cells, commit],
  );
  const deleteCell = useCallback(
    (id: string) => commit(cells.filter((c) => c.id !== id)),
    [cells, commit],
  );
  const moveCell = useCallback(
    (id: string, delta: number) => {
      const index = cells.findIndex((c) => c.id === id);
      const target = index + delta;
      if (index < 0 || target < 0 || target >= cells.length) return;
      const next = [...cells];
      const [moved] = next.splice(index, 1);
      if (!moved) return;
      next.splice(target, 0, moved);
      commit(next);
    },
    [cells, commit],
  );

  const runCell = useCallback(
    (cell: NotebookCell) => {
      if (!execute || runningCellId) return;
      setRunningCellId(cell.id);
      // clear this cell's outputs, then stream new ones in
      let live: readonly NotebookCell[] = cells.map((c) =>
        c.id === cell.id ? { ...c, outputs: [], executionCount: null } : c,
      );
      commit(live);
      const handle = execute(cell.source, (event) => {
        if (event.type === "output") {
          live = live.map((c) =>
            c.id === cell.id ? { ...c, outputs: [...c.outputs, event.output] } : c,
          );
          commit(live);
        } else if (event.type === "execution_count") {
          live = live.map((c) => (c.id === cell.id ? { ...c, executionCount: event.count } : c));
          commit(live);
        } else if (event.type === "error") {
          live = live.map((c) =>
            c.id === cell.id
              ? {
                  ...c,
                  outputs: [
                    ...c.outputs,
                    {
                      kind: "error",
                      ename: "KernelError",
                      evalue: event.message,
                      traceback: event.message,
                    },
                  ],
                }
              : c,
          );
          commit(live);
        }
      });
      runHandleRef.current = handle;
      void handle.done.finally(() => {
        setRunningCellId((current) => (current === cell.id ? null : current));
        runHandleRef.current = null;
      });
    },
    [cells, commit, execute, runningCellId],
  );

  const stopCell = useCallback(() => {
    runHandleRef.current?.cancel();
    setRunningCellId(null);
  }, []);

  const runAll = useCallback(async () => {
    if (!execute) return;
    for (const cell of cells) {
      if (cell.cellType !== "code" || cell.source.trim().length === 0) continue;
      runCell(cell);
      // wait for the current run to settle before the next
      // eslint-disable-next-line no-await-in-loop -- notebooks run cells in order
      await runHandleRef.current?.done.catch(() => undefined);
    }
  }, [cells, execute, runCell]);

  if (!parsedRef.current.valid) {
    return (
      <div className="flex h-full flex-col gap-2 overflow-auto p-4">
        <p className="text-xs text-destructive/80">
          Couldn&rsquo;t read this notebook ({parsedRef.current.error ?? "invalid"}). Showing raw
          JSON.
        </p>
        <pre className="overflow-auto rounded-md border border-border/60 bg-background/70 p-3 font-mono text-[11px] text-muted-foreground/85">
          {value}
        </pre>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col" data-workspace-file-mode="notebook">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5 text-xs">
        <span className="font-medium text-muted-foreground/80">Notebook</span>
        <span className="text-muted-foreground/50">· {cells.length} cells</span>
        <div className="ms-auto flex items-center gap-1">
          {execute ? (
            <button
              type="button"
              className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
              disabled={runningCellId !== null}
              onClick={() => void runAll()}
            >
              <PlayIcon className="size-3" /> Run all
            </button>
          ) : null}
          {execute && onRestartKernel ? (
            <button
              type="button"
              className="inline-flex h-6 items-center rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onRestartKernel}
            >
              Restart
            </button>
          ) : null}
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => addCell("code")}
          >
            <PlusIcon className="size-3" /> Code
          </button>
          <button
            type="button"
            className="inline-flex h-6 items-center gap-1 rounded-md border border-border/60 px-2 text-[11px] text-muted-foreground hover:text-foreground"
            onClick={() => addCell("markdown")}
          >
            <PlusIcon className="size-3" /> Markdown
          </button>
        </div>
      </div>
      {!execute ? (
        <div className="border-b border-border/40 bg-secondary/20 px-3 py-1 text-[10px] text-muted-foreground/70">
          Read &amp; edit mode — live execution isn&rsquo;t enabled for this workspace yet.
        </div>
      ) : null}
      <div className="flex-1 space-y-3 overflow-auto p-3">
        {cells.map((cell) => (
          <div
            key={cell.id}
            className="group/cell rounded-lg border border-transparent hover:border-border/40"
          >
            <div className="flex items-start">
              <div className="min-w-0 flex-1">
                {cell.cellType === "code" ? (
                  <CodeCell
                    cell={cell}
                    running={runningCellId === cell.id}
                    canRun={Boolean(execute)}
                    onChange={(source) => updateCell(cell.id, { source })}
                    onRun={() => runCell(cell)}
                    onStop={stopCell}
                  />
                ) : (
                  <MarkdownCell
                    cell={cell}
                    cwd={cwd}
                    onChange={(source) => updateCell(cell.id, { source })}
                  />
                )}
              </div>
              <div className="flex shrink-0 gap-0.5 pt-1 pr-1 opacity-0 transition-opacity group-hover/cell:opacity-100">
                <button
                  type="button"
                  aria-label="Move cell up"
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
                  onClick={() => moveCell(cell.id, -1)}
                >
                  <ChevronUpIcon className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label="Move cell down"
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-secondary hover:text-foreground"
                  onClick={() => moveCell(cell.id, 1)}
                >
                  <ChevronDownIcon className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label="Delete cell"
                  className="inline-flex size-5 items-center justify-center rounded text-muted-foreground/60 hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => deleteCell(cell.id)}
                >
                  <Trash2Icon className="size-3" />
                </button>
              </div>
            </div>
          </div>
        ))}
        {cells.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground/60">
            Empty notebook — add a cell above.
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default memo(NotebookView);
