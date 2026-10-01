import { describe, expect, it } from "vitest";

import {
  isNotebookPath,
  makeEmptyCell,
  parseNotebook,
  serializeNotebook,
  stripAnsi,
  toSourceLines,
} from "./notebookModel.logic";

const SAMPLE = JSON.stringify({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { kernelspec: { name: "python3" } },
  cells: [
    { cell_type: "markdown", source: ["# Title\n", "text"] },
    {
      cell_type: "code",
      execution_count: 2,
      source: "print('hi')",
      outputs: [
        { output_type: "stream", name: "stdout", text: ["hi\n"] },
        { output_type: "execute_result", data: { "text/plain": ["42"] } },
        { output_type: "display_data", data: { "image/png": "AAAA" } },
        {
          output_type: "error",
          ename: "ValueError",
          evalue: "bad",
          traceback: ["[31mTrace[0m", "line2"],
        },
      ],
    },
  ],
});

describe("isNotebookPath", () => {
  it("matches .ipynb only", () => {
    expect(isNotebookPath("a/b/Notes.IPYNB")).toBe(true);
    expect(isNotebookPath("a/b/notes.py")).toBe(false);
    expect(isNotebookPath(null)).toBe(false);
  });
});

describe("parseNotebook", () => {
  it("reads cells, sources, execution count and outputs", () => {
    const nb = parseNotebook(SAMPLE);
    expect(nb.valid).toBe(true);
    expect(nb.cells).toHaveLength(2);
    expect(nb.cells[0]).toMatchObject({ cellType: "markdown", source: "# Title\ntext" });
    const code = nb.cells[1]!;
    expect(code.cellType).toBe("code");
    expect(code.executionCount).toBe(2);
    expect(code.outputs.map((o) => o.kind)).toEqual(["stream", "text", "image", "error"]);
    const err = code.outputs[3];
    expect(err?.kind).toBe("error");
    if (err?.kind === "error") expect(err.traceback).toBe("Trace\nline2"); // ANSI stripped
  });

  it("reports invalid JSON and non-notebooks without throwing", () => {
    expect(parseNotebook("{not json").valid).toBe(false);
    expect(parseNotebook(JSON.stringify({ foo: 1 })).valid).toBe(false);
  });
});

describe("serializeNotebook round-trip", () => {
  it("preserves untouched top-level fields and re-parses equal", () => {
    const nb = parseNotebook(SAMPLE);
    const json = serializeNotebook(nb, nb.cells);
    const again = parseNotebook(json);
    expect(again.valid).toBe(true);
    expect(again.cells.map((c) => c.source)).toEqual(nb.cells.map((c) => c.source));
    expect((again.raw?.metadata as Record<string, unknown>)?.["kernelspec"]).toBeDefined();
    expect(again.cells[1]?.outputs.map((o) => o.kind)).toEqual([
      "stream",
      "text",
      "image",
      "error",
    ]);
  });

  it("writes an added cell", () => {
    const nb = parseNotebook(SAMPLE);
    const cells = [...nb.cells, makeEmptyCell("code")];
    const again = parseNotebook(serializeNotebook(nb, cells));
    expect(again.cells).toHaveLength(3);
  });
});

describe("toSourceLines", () => {
  it("keeps trailing newlines per line and drops a final empty", () => {
    expect(toSourceLines("a\nb")).toEqual(["a\n", "b"]);
    expect(toSourceLines("a\n")).toEqual(["a\n"]);
    expect(toSourceLines("")).toEqual([]);
  });
});

describe("stripAnsi", () => {
  it("removes colour codes", () => {
    expect(stripAnsi("[31mred[0m")).toBe("red");
  });
});
