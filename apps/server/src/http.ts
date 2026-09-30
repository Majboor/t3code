import Mime from "@effect/platform-node/Mime";
import { gzipSync } from "node:zlib";
import { Data, Effect, FileSystem, Option, Path } from "effect";
import { cast } from "effect/Function";
import {
  HttpBody,
  HttpClient,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
  HttpServerRequest,
} from "effect/unstable/http";
import { OtlpTracer } from "effect/unstable/observability";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import {
  parseAttachmentIdFromRelativePath,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toSafeThreadAttachmentSegment,
} from "./attachmentStore.ts";
import { resolveStaticDir, ServerConfig } from "./config.ts";
import { decodeOtlpTraceRecords } from "./observability/TraceRecord.ts";
import { BrowserTraceCollector } from "./observability/Services/BrowserTraceCollector.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { LocalAuthAccountRepository } from "./persistence/Services/LocalAuthAccounts.ts";
import { TenancyRepository } from "./persistence/Services/Tenancy.ts";
import { ProjectFaviconResolver } from "./project/Services/ProjectFaviconResolver.ts";
import {
  isSoleOccupantSession,
  ServerAuth,
  type AuthenticatedSession,
} from "./auth/Services/ServerAuth.ts";
import { respondToAuthError } from "./auth/http.ts";
import { quickLoginNameFromSearch, readQuickLogins } from "./auth/quickLogin.ts";
import { ServerEnvironment } from "./environment/Services/ServerEnvironment.ts";
import { sessionMayReachWorkspacePath } from "./workspace/fileHttp.ts";

/**
 * Assets are served straight from disk, which sent 3.7 MB of JavaScript
 * uncompressed on every first load and told the browser nothing about caching.
 * Gzip the text types once per file (keyed by path and mtime) and let hashed
 * `/assets/*` files be cached for good; `index.html` must stay fresh.
 */
const COMPRESSIBLE_TYPES = /^(text\/|application\/(javascript|json|xml)|image\/svg)/;
const compressedAssetCache = new Map<
  string,
  { readonly mtimeMs: number; readonly gz: Uint8Array }
>();

function compressedAsset(filePath: string, mtimeMs: number, data: Uint8Array): Uint8Array {
  const cached = compressedAssetCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.gz;
  const gz = new Uint8Array(gzipSync(data, { level: 6 }));
  compressedAssetCache.set(filePath, { mtimeMs, gz });
  return gz;
}

function staticCacheControl(relativePath: string): string {
  return relativePath.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
}

/**
 * `private`, because this response is now decided per session.
 *
 * It was `public` when the route served any directory to anybody — wrong then
 * too, but harmless in the sense that everyone got the same thing. Now that the
 * icon is only served to sessions that may read the project, a shared cache
 * holding one tenant's icon and handing it to the next requester would put the
 * disclosure back through the proxy.
 */
const PROJECT_FAVICON_CACHE_CONTROL = "private, max-age=3600";
const FALLBACK_PROJECT_FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#6b728080" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-fallback="project-favicon"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2Z"/></svg>`;
const OTLP_TRACES_PROXY_PATH = "/api/observability/v1/traces";
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);

export const browserApiCorsLayer = HttpRouter.cors({
  allowedMethods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["authorization", "b3", "traceparent", "content-type"],
  maxAge: 600,
});

export function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return LOOPBACK_HOSTNAMES.has(normalizedHostname);
}

export function resolveDevRedirectUrl(devUrl: URL, requestUrl: URL): string {
  const redirectUrl = new URL(devUrl.toString());
  redirectUrl.pathname = requestUrl.pathname;
  redirectUrl.search = requestUrl.search;
  redirectUrl.hash = requestUrl.hash;
  return redirectUrl.toString();
}

/**
 * Who is calling. Never which of this server's bytes they may have.
 *
 * It returns the session now rather than discarding it, because every route
 * below it that serves a file has to go on and ask the second question.
 */
const requireAuthenticatedRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const serverAuth = yield* ServerAuth;
  return yield* serverAuth.authenticateHttpRequest(request);
});

/**
 * Whether this session owns the whole machine.
 *
 * Asked before any path or id is examined, which is what ws.ts does too: its
 * `ensureAnyTenantWorkspacePermission` returns immediately for a machine owner,
 * before it has looked at a single root. `sessionMayReachWorkspacePath` makes
 * the same allowance but only after its known-roots gate, so a route that
 * leaned on it alone would refuse the one person on a laptop a file sitting in
 * a directory no project has been registered for — their own screenshots, their
 * own project icons. Asking here first keeps the desktop case exactly as it was
 * while leaving a published host with no allowance at all.
 *
 * The account count is read the same fail-closed way the file routes read it: a
 * count we could not read must not promote a guest to the owner of every file
 * on the box.
 */
const sessionOwnsWholeMachine = (
  session: AuthenticatedSession,
): Effect.Effect<boolean, never, ServerConfig | LocalAuthAccountRepository> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const localAuthAccounts = yield* LocalAuthAccountRepository;
    const localAccountCount = yield* localAuthAccounts
      .countEnabled()
      .pipe(Effect.catch(() => Effect.succeed(Number.POSITIVE_INFINITY)));
    return isSoleOccupantSession(session, {
      workspaceSource: config.workspaceSource,
      publishedBeyondLoopback: config.publishedBeyondLoopback,
      localAccountCount,
    });
  });

/**
 * Whether this session may read the attachment behind `attachmentId`.
 *
 * `attachmentsDir` is one flat directory for the whole process, so the id is
 * the only thing that says who an attachment belongs to. `createAttachmentId`
 * prefixes every id with the sanitized id of the thread it was pasted into,
 * which is what makes the question answerable at all: recover that segment,
 * find the thread that produced it, and authorize the thread's own directories
 * exactly as `/api/workspace/file` authorizes a `cwd`.
 *
 * Every candidate thread has to be reachable, not merely one of them. The
 * segment is lossy (lowercased, truncated at 80 characters, every other
 * character folded to `-`), so two thread ids can in principle collapse onto
 * one segment; when they do, this cannot tell which of them the bytes came
 * from, and the only answer that cannot leak is the one that holds for all of
 * them. Within a single thread the roots are an any-of, which is what
 * `ensureThreadAccess` in ws.ts does with the same pair.
 */
const sessionMayReadAttachment = (
  session: AuthenticatedSession,
  attachmentId: string | null,
): Effect.Effect<
  boolean,
  never,
  ServerConfig | OrchestrationEngineService | TenancyRepository | LocalAuthAccountRepository
> =>
  Effect.gen(function* () {
    if (yield* sessionOwnsWholeMachine(session)) {
      return true;
    }

    // `null` is the pre-id layout: `<thread>/<message>/<file>`, a nested path
    // with no attachment id in it to recover a thread from. Those files predate
    // every tenant on a hosted box, so the one session that may still have them
    // is the machine's own owner, answered just above.
    if (attachmentId === null) {
      return false;
    }
    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    if (threadSegment === null) {
      return false;
    }

    const engine = yield* OrchestrationEngineService;
    const readModel = yield* engine.getReadModel();
    const owningThreads = readModel.threads.filter(
      (thread) => toSafeThreadAttachmentSegment(thread.id) === threadSegment,
    );
    // An id whose thread the read model has never heard of is not evidence of
    // innocence — it is an id we cannot attribute, which on a shared host is
    // the same as an id belonging to somebody else.
    if (owningThreads.length === 0) {
      return false;
    }

    for (const thread of owningThreads) {
      const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
      const roots = [thread.worktreePath, project?.workspaceRoot].filter(
        (root): root is string => typeof root === "string" && root.length > 0,
      );
      // A thread whose project has gone leaves nothing to authorize against.
      if (roots.length === 0) {
        return false;
      }
      let reachable = false;
      for (const root of roots) {
        if (yield* sessionMayReachWorkspacePath(session, root, "file.read")) {
          reachable = true;
          break;
        }
      }
      if (!reachable) {
        return false;
      }
    }
    return true;
  });

export const serverEnvironmentRouteLayer = HttpRouter.add(
  "GET",
  "/.well-known/t3/environment",
  Effect.gen(function* () {
    const descriptor = yield* Effect.service(ServerEnvironment).pipe(
      Effect.flatMap((serverEnvironment) => serverEnvironment.getDescriptor),
    );
    return HttpServerResponse.jsonUnsafe(descriptor, { status: 200 });
  }),
);

class DecodeOtlpTraceRecordsError extends Data.TaggedError("DecodeOtlpTraceRecordsError")<{
  readonly cause: unknown;
  readonly bodyJson: OtlpTracer.TraceData;
}> {}

export const otlpTracesProxyRouteLayer = HttpRouter.add(
  "POST",
  OTLP_TRACES_PROXY_PATH,
  Effect.gen(function* () {
    yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const config = yield* ServerConfig;
    const otlpTracesUrl = config.otlpTracesUrl;
    const browserTraceCollector = yield* BrowserTraceCollector;
    const httpClient = yield* HttpClient.HttpClient;
    const bodyJson = cast<unknown, OtlpTracer.TraceData>(yield* request.json);

    yield* Effect.try({
      try: () => decodeOtlpTraceRecords(bodyJson),
      catch: (cause) => new DecodeOtlpTraceRecordsError({ cause, bodyJson }),
    }).pipe(
      Effect.flatMap((records) => browserTraceCollector.record(records)),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to decode browser OTLP traces", {
          cause,
          bodyJson,
        }),
      ),
    );

    if (otlpTracesUrl === undefined) {
      return HttpServerResponse.empty({ status: 204 });
    }

    return yield* httpClient
      .post(otlpTracesUrl, {
        body: HttpBody.jsonUnsafe(bodyJson),
      })
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.as(HttpServerResponse.empty({ status: 204 })),
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to export browser OTLP traces", {
            cause,
            otlpTracesUrl,
          }),
        ),
        Effect.catch(() =>
          Effect.succeed(HttpServerResponse.text("Trace export failed.", { status: 502 })),
        ),
      );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const attachmentsRouteLayer = HttpRouter.add(
  "GET",
  `${ATTACHMENTS_ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const session = yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    const rawRelativePath = url.value.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
    const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
    if (!normalizedRelativePath) {
      return HttpServerResponse.text("Invalid attachment path", { status: 400 });
    }

    const isIdLookup =
      !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
    // Being signed in said who is asking; it never said whose thread this
    // attachment was pasted into. Every id lives under one process-wide
    // `attachmentsDir`, so without this any hosted account that has seen an id
    // — and the replay feed hands them out — could pull down another tenant's
    // screenshots by asking for them. A refusal is a 404 rather than a 403 so
    // the route cannot be used to confirm that an id exists.
    const attachmentId = isIdLookup
      ? normalizedRelativePath
      : parseAttachmentIdFromRelativePath(normalizedRelativePath);
    if (!(yield* sessionMayReadAttachment(session, attachmentId))) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    const filePath = isIdLookup
      ? resolveAttachmentPathById({
          attachmentsDir: config.attachmentsDir,
          attachmentId: normalizedRelativePath,
        })
      : resolveAttachmentRelativePath({
          attachmentsDir: config.attachmentsDir,
          relativePath: normalizedRelativePath,
        });
    if (!filePath) {
      return HttpServerResponse.text(isIdLookup ? "Not Found" : "Invalid attachment path", {
        status: isIdLookup ? 404 : 400,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }

    return yield* HttpServerResponse.file(filePath, {
      status: 200,
      headers: {
        // `private`, because the bytes belong to one tenant: the id never
        // changes meaning, so it stays immutable, but a shared proxy must not
        // be allowed to hold one account's image and hand it to the next
        // request that asks for the same URL.
        "Cache-Control": "private, max-age=31536000, immutable",
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const projectFaviconRouteLayer = HttpRouter.add(
  "GET",
  "/api/project-favicon",
  Effect.gen(function* () {
    const session = yield* requireAuthenticatedRequest;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const projectCwd = url.value.searchParams.get("cwd");
    if (!projectCwd) {
      return HttpServerResponse.text("Missing cwd parameter", { status: 400 });
    }

    // `cwd` is chosen by the caller, so this route used to read a file out of
    // any directory on the host for anybody holding any session: the resolver
    // walks a fixed list of icon names, but it walks them wherever it is
    // pointed, and what comes back is served. The same authorization
    // `/api/workspace/file` runs on its own `cwd` answers the same question
    // here, and `file.read` is what every role that can see a project holds.
    const path = yield* Path.Path;
    // `path.isAbsolute`, not a leading "/": this server runs on Windows too,
    // where every real project path starts with a drive letter and the
    // stricter test rejected all of them. The traversal check has to look at
    // both separators for the same reason.
    if (!path.isAbsolute(projectCwd) || projectCwd.split(/[\\/]/).includes("..")) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const mayReadProjectIcon =
      (yield* sessionOwnsWholeMachine(session)) ||
      (yield* sessionMayReachWorkspacePath(session, path.resolve(projectCwd), "file.read"));
    if (!mayReadProjectIcon) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }

    const faviconResolver = yield* ProjectFaviconResolver;
    const faviconFilePath = yield* faviconResolver.resolvePath(projectCwd);
    if (!faviconFilePath) {
      return HttpServerResponse.text(FALLBACK_PROJECT_FAVICON_SVG, {
        status: 200,
        contentType: "image/svg+xml",
        headers: {
          "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
        },
      });
    }

    return yield* HttpServerResponse.file(faviconFilePath, {
      status: 200,
      headers: {
        "Cache-Control": PROJECT_FAVICON_CACHE_CONTROL,
      },
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(HttpServerResponse.text("Internal Server Error", { status: 500 })),
      ),
    );
  }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
);

export const staticAndDevRouteLayer = HttpRouter.add(
  "GET",
  "*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);

    if (Option.isNone(url)) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }

    const config = yield* ServerConfig;
    if (config.devUrl && isLoopbackHostname(url.value.hostname)) {
      return HttpServerResponse.redirect(resolveDevRedirectUrl(config.devUrl, url.value), {
        status: 302,
      });
    }

    const staticDir = config.staticDir ?? (config.devUrl ? yield* resolveStaticDir() : undefined);
    if (!staticDir) {
      return HttpServerResponse.text("No static directory configured and no dev URL set.", {
        status: 503,
      });
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const staticRoot = path.resolve(staticDir);
    // Internal quick logins: `/?waleed` becomes a server-side sign-in and a
    // redirect back here with the session cookie set. See auth/quickLogin.ts.
    if (url.value.pathname === "/") {
      const quickName = quickLoginNameFromSearch(url.value.searchParams, readQuickLogins());
      if (quickName !== null) {
        return HttpServerResponse.redirect(
          `/api/auth/quick?name=${encodeURIComponent(quickName)}`,
          {
            status: 302,
          },
        );
      }
    }
    const staticRequestPath = url.value.pathname === "/" ? "/index.html" : url.value.pathname;
    const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
    const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
    const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
    const hasPathTraversalSegment = staticRelativePath.startsWith("..");
    if (
      staticRelativePath.length === 0 ||
      hasRawLeadingParentSegment ||
      hasPathTraversalSegment ||
      staticRelativePath.includes("\0")
    ) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const isWithinStaticRoot = (candidate: string) =>
      candidate === staticRoot ||
      candidate.startsWith(staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`);

    let filePath = path.resolve(staticRoot, staticRelativePath);
    if (!isWithinStaticRoot(filePath)) {
      return HttpServerResponse.text("Invalid static file path", { status: 400 });
    }

    const ext = path.extname(filePath);
    // A request that already names a real file extension (e.g. a hashed JS
    // chunk under /assets/) is asking for a specific static file, never a
    // client-side route — if it's missing, that's a real 404. Only an
    // extensionless path (a client-side route with no file of its own) falls
    // back to `index.html` so the SPA's own router can take over.
    const looksLikeStaticAsset = ext.length > 0;
    if (!looksLikeStaticAsset) {
      filePath = path.resolve(filePath, "index.html");
      if (!isWithinStaticRoot(filePath)) {
        return HttpServerResponse.text("Invalid static file path", { status: 400 });
      }
    }

    const fileInfo = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!fileInfo || fileInfo.type !== "File") {
      if (looksLikeStaticAsset) {
        // A missing asset must 404, not silently succeed as HTML — a stale
        // tab's `import()` of a chunk hash from before a redeploy needs a
        // real failure so the browser's module loader (and this app's own
        // `vite:preloadError` recovery) can react to it, rather than being
        // handed `text/html` for a `.js` request and rejecting it outright
        // with "'text/html' is not a valid JavaScript MIME type".
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      const indexPath = path.resolve(staticRoot, "index.html");
      const indexData = yield* fileSystem
        .readFile(indexPath)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!indexData) {
        return HttpServerResponse.text("Not Found", { status: 404 });
      }
      return HttpServerResponse.uint8Array(indexData, {
        status: 200,
        contentType: "text/html; charset=utf-8",
      });
    }

    const contentType = Mime.getType(filePath) ?? "application/octet-stream";
    const data = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    const acceptsGzip = /\bgzip\b/.test(request.headers["accept-encoding"] ?? "");
    const cacheControl = staticCacheControl(staticRelativePath);
    if (acceptsGzip && COMPRESSIBLE_TYPES.test(contentType) && data.byteLength > 1024) {
      const mtimeMs = Option.getOrElse(fileInfo.mtime, () => new Date(0)).getTime();
      return HttpServerResponse.uint8Array(compressedAsset(filePath, mtimeMs, data), {
        status: 200,
        contentType,
        headers: {
          "content-encoding": "gzip",
          vary: "Accept-Encoding",
          "cache-control": cacheControl,
        },
      });
    }

    return HttpServerResponse.uint8Array(data, {
      status: 200,
      contentType,
      headers: { "cache-control": cacheControl, vary: "Accept-Encoding" },
    });
  }),
);
