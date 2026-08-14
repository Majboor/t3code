/**
 * Points the editor at the copy of Monaco that ships with the app.
 *
 * `@monaco-editor/react` otherwise fetches Monaco from a CDN at runtime, which
 * is a strange dependency for a tool that runs on your own machine: no network,
 * no editor. monaco-editor is already a dependency here, so the files are on
 * disk either way — this just stops the browser going to jsdelivr for them.
 *
 * Importing this module for its side effect has to happen before the editor
 * first renders, so it lives next to the component that renders it rather than
 * in an entry point somebody might reorder.
 */
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

/**
 * Monaco asks for a worker per language. Anything unrecognised gets the plain
 * editor worker, which is what drives find, folding and diffing — returning
 * nothing there disables those quietly rather than loudly.
 */
function workerFor(label: string): Worker {
  switch (label) {
    case "json":
      return new jsonWorker();
    case "css":
    case "scss":
    case "less":
      return new cssWorker();
    case "html":
    case "handlebars":
    case "razor":
      return new htmlWorker();
    case "typescript":
    case "javascript":
      return new tsWorker();
    default:
      return new editorWorker();
  }
}

let configured = false;

export function useLocalMonaco(): void {
  if (configured || typeof window === "undefined") {
    return;
  }
  configured = true;

  (
    globalThis as { MonacoEnvironment?: { getWorker: (id: string, label: string) => Worker } }
  ).MonacoEnvironment = { getWorker: (_id, label) => workerFor(label) };

  loader.config({ monaco });
}
