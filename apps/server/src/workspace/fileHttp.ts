/**
 * Serve a workspace file's raw bytes so the file viewer can show media
 * (images, GIFs, video, audio, PDFs) and plain text that the code editor
 * cannot, and render Office documents (docx/pptx/xlsx/odt/odp/ods/rtf) by
 * converting them to PDF with LibreOffice on the server. Same guard as every
 * other `/api` read (`authenticateHttpRequest`), and the path is pinned inside
 * the requested project directory so it cannot walk out of it.
 *
 * `GET /api/workspace/file?cwd=<project root>&path=<relative path>[&convert=pdf][&download=1]`
 *
 *  - Office documents are converted to PDF when `convert=pdf` is passed (the
 *    web viewer does this for its inline preview); the result is cached by
 *    path + mtime + size under the OS temp dir. Conversions are serialised
 *    because a headless `soffice` cannot share one profile between processes.
 *  - Text-like files are sent inline with a UTF-8 charset so a browser tab
 *    shows them instead of downloading.
 *  - `download=1` forces an attachment.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, stat as fsStat } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { Effect, FileSystem, Option, Path } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import Mime from "@effect/platform-node/Mime";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";

export const WORKSPACE_FILE_PATH = "/api/workspace/file";

/** Media and text are safe to inline; anything else is sent as a download. */
const INLINE_TYPES =
  /^(image\/|video\/|audio\/|text\/|application\/(pdf|json|xml|javascript|x-yaml|yaml|toml|x-sh|sql)$)/;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql)$)/;

/** Extensions LibreOffice can turn into a PDF for the inline viewer. */
export const OFFICE_EXTENSIONS = new Set([
  "doc", "docx", "dot", "dotx", "odt", "ott", "rtf", "wps",
  "ppt", "pptx", "pps", "ppsx", "pot", "potx", "odp", "otp", "key",
  "xls", "xlsx", "xlsm", "ods", "ots", "numbers", "pages",
]);

const CACHE_DIR = nodePath.join(os.tmpdir(), "t3-office-pdf");
const PROFILE_DIR = nodePath.join(os.tmpdir(), "t3-office-profile");
const CONVERT_TIMEOUT_MS = 120_000;

/** One conversion at a time: headless soffice refuses a second instance on the same profile. */
let conversionChain: Promise<unknown> = Promise.resolve();

function convertToPdf(source: string): Promise<string> {
  const run = async (): Promise<string> => {
    const info = await fsStat(source);
    const key = createHash("sha1")
      .update(`${source}|${info.mtimeMs}|${info.size}`)
      .digest("hex");
    const outDir = nodePath.join(CACHE_DIR, key);
    const outFile = nodePath.join(
      outDir,
      `${nodePath.basename(source, nodePath.extname(source))}.pdf`,
    );
    try {
      await fsStat(outFile);
      return outFile;
    } catch {
      // not cached yet
    }
    await mkdir(outDir, { recursive: true });
    await mkdir(PROFILE_DIR, { recursive: true });
    await new Promise<void>((resolve, reject) => {
      execFile(
        "soffice",
        [
          `-env:UserInstallation=file://${PROFILE_DIR}`,
          "--headless",
          "--norestore",
          "--nologo",
          "--convert-to",
          "pdf",
          "--outdir",
          outDir,
          source,
        ],
        { timeout: CONVERT_TIMEOUT_MS, env: { ...process.env, HOME: PROFILE_DIR } },
        (error, _stdout, stderr) => {
          if (error) {
            reject(new Error(`soffice failed: ${error.message} ${String(stderr).slice(0, 300)}`));
          } else {
            resolve();
          }
        },
      );
    });
    await fsStat(outFile);
    return outFile;
  };
  const next = conversionChain.then(run, run);
  conversionChain = next.catch(() => undefined);
  return next;
}

export const workspaceFileRouteLayer = HttpRouter.add(
  "GET",
  WORKSPACE_FILE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    yield* serverAuth.authenticateHttpRequest(request);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const url = HttpServerRequest.toURL(request);
    const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    const cwd = params.get("cwd") ?? "";
    const relativePath = params.get("path") ?? "";
    const wantsPdf = params.get("convert") === "pdf";
    const forceDownload = params.get("download") === "1";
    if (!cwd.startsWith("/") || cwd.split("/").includes("..") || !relativePath) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const root = path.resolve(cwd);
    const target = path.resolve(root, relativePath);
    // The resolved path must stay within the project root.
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    const info = yield* fileSystem.stat(target).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!info || info.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const extension = path.extname(target).slice(1).toLowerCase();
    let servePath = target;
    let contentType = Mime.getType(target) ?? "application/octet-stream";
    if (wantsPdf && OFFICE_EXTENSIONS.has(extension)) {
      const converted = yield* Effect.tryPromise({
        try: () => convertToPdf(target),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(Effect.catch((error) => Effect.succeed(error)));
      if (converted instanceof Error) {
        return HttpServerResponse.text(
          `Could not convert this document for preview: ${converted.message}`,
          { status: 502 },
        );
      }
      servePath = converted;
      contentType = "application/pdf";
    }

    const data = yield* fileSystem.readFile(servePath).pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }
    if (TEXT_TYPES.test(contentType) && !contentType.includes("charset")) {
      contentType = `${contentType}; charset=utf-8`;
    }
    const inline = !forceDownload && INLINE_TYPES.test(contentType);
    const downloadName =
      servePath === target ? path.basename(target) : path.basename(servePath);
    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: {
        "cache-control": "private, max-age=60",
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${downloadName}"`,
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
