/**
 * The desktop installers, served by the portal itself.
 *
 * `/download` in the web app used to say "not published yet" because nothing
 * hosted the artifacts. This serves whatever the operator drops into the
 * downloads directory (`T3CODE_DESKTOP_DOWNLOAD_DIR`, default
 * `<baseDir>/downloads`): the `.dmg`, `.AppImage` and `.exe` builds plus a
 * `manifest.json` naming which file belongs to which platform. The web reads the
 * manifest at runtime, so publishing a build is a copy, not a deploy.
 *
 * Unauthenticated on purpose — a person downloading the app does not have an
 * account on it yet — and read-only over a flat directory: one path segment,
 * plain file names, nothing that could walk out of the root.
 *
 * @module Downloads
 */
import Mime from "@effect/platform-node/Mime";
import { Effect, FileSystem, Path } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ServerConfig } from "../config.ts";

export const DESKTOP_DOWNLOADS_PATH = "/downloads";
export const DESKTOP_DOWNLOADS_ROUTE = `${DESKTOP_DOWNLOADS_PATH}/:file`;
export const DESKTOP_DOWNLOADS_MANIFEST = "manifest.json";

/** A file name and nothing else: no separators, no leading dot, no surprises. */
const FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function resolveDesktopDownloadDir(config: {
  readonly baseDir: string;
  readonly desktopDownloadDir?: string | undefined;
}): string {
  return config.desktopDownloadDir?.trim() || `${config.baseDir}/downloads`;
}

const fileFromRoute = HttpRouter.params.pipe(
  Effect.map((params) => {
    const file = params["file"];
    return typeof file === "string" && FILE_NAME_PATTERN.test(file) ? file : null;
  }),
);

const downloadRoute = Effect.gen(function* () {
  const file = yield* fileFromRoute;
  if (file === null) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.resolve(resolveDesktopDownloadDir(config));
  const filePath = path.resolve(root, file);
  if (path.dirname(filePath) !== root) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const info = yield* fileSystem.stat(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!info || info.type !== "File") {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const data = yield* fileSystem.readFile(filePath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!data) {
    return HttpServerResponse.text("Internal Server Error", { status: 500 });
  }
  const isManifest = file === DESKTOP_DOWNLOADS_MANIFEST;
  return HttpServerResponse.uint8Array(data, {
    status: 200,
    contentType: isManifest
      ? "application/json; charset=utf-8"
      : (Mime.getType(filePath) ?? "application/octet-stream"),
    headers: isManifest
      ? { "cache-control": "no-store" }
      : { "content-disposition": `attachment; filename="${file}"` },
  });
});

export const desktopDownloadsRouteLayer = HttpRouter.add("GET", DESKTOP_DOWNLOADS_ROUTE, downloadRoute);
