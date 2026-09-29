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
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat as fsStat, unlink } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import type { TenantPermission, TenantRole } from "@t3tools/contracts";
import { Data, Effect, FileSystem, Option, Path, Stream } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import Mime from "@effect/platform-node/Mime";
import { evaluateProviderAccountAccess, hasTenantPermission } from "@t3tools/shared/tenancy";

import { respondToAuthError } from "../auth/http.ts";
import {
  isSoleOccupantSession,
  resolveAuthenticatedUserId,
  ServerAuth,
  type AuthenticatedSession,
} from "../auth/Services/ServerAuth.ts";
import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { TenancyRepository } from "../persistence/Services/Tenancy.ts";
import { WorkspaceEntries } from "./Services/WorkspaceEntries.ts";

export const WORKSPACE_FILE_PATH = "/api/workspace/file";

/**
 * Safety ceiling for `POST /api/workspace/file`, independent of the much
 * smaller limits the WS RPC `file.write` path enforces for hosted/public
 * tenants (`DEFAULT_PUBLIC_ACCESS_LIMITS.maxFileUploadBytes` in ws.ts). This
 * route exists so uploads don't have to go over the WS RPC envelope at all
 * (base64 inflation + RPC payload/rate limits were producing the "large file
 * upload disconnects" bug), so it only needs a generous disk-safety ceiling,
 * not the same per-tenant metering.
 */
const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;

/**
 * Same normalization ws.ts uses for the same question, so a path that the
 * socket calls "inside a workspace root" is one these routes call inside it
 * too. Trailing slashes and Windows separators are levelled first; the caller
 * has already resolved both sides, so no `..` survives to be re-interpreted.
 */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/** Media and text are safe to inline; anything else is sent as a download. */
const INLINE_TYPES =
  /^(image\/|video\/|audio\/|text\/|application\/(pdf|json|xml|javascript|x-yaml|yaml|toml|x-sh|sql)$)/;
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-sh|sql)$)/;

/** Extensions LibreOffice can turn into a PDF for the inline viewer. */
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

const CACHE_DIR = nodePath.join(os.tmpdir(), "t3-office-pdf");
const PROFILE_DIR = nodePath.join(os.tmpdir(), "t3-office-profile");
const CONVERT_TIMEOUT_MS = 120_000;

/** One conversion at a time: headless soffice refuses a second instance on the same profile. */
let conversionChain: Promise<unknown> = Promise.resolve();

function convertToPdf(source: string): Promise<string> {
  const run = async (): Promise<string> => {
    const info = await fsStat(source);
    const key = createHash("sha1").update(`${source}|${info.mtimeMs}|${info.size}`).digest("hex");
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

/**
 * Whether `session` may touch `cwd` at all, with `permission`.
 *
 * Authenticating a request says who is calling; it never said which
 * directories they may reach. `cwd` arrives from the caller, so pinning the
 * requested `path` inside `cwd` proves nothing on its own: `cwd=/` makes the
 * containment check vacuous and every file this process can open — other
 * tenants' projects, the server's own database, the provider credential files
 * under a tenant's provider home — becomes readable, and writable, by anyone
 * holding any session. The WS RPCs for the same two operations
 * (`projects.readFile` / `projects.writeFile`) have always run this chain;
 * these routes were added later to get uploads out of the RPC envelope's size
 * limits and inherited none of it.
 *
 * The chain below mirrors `ensureWorkspaceRoot` in ws.ts step for step, and
 * the allowances it makes are reproduced on purpose rather than tightened: a
 * machine owner owns every path on their own computer, an install whose read
 * model knows no roots yet has nothing to isolate, and a path no tenant claims
 * falls back to provider-session isolation. A rule that is stricter on one
 * transport than the other only moves the bug — the file viewer and the
 * uploader would start refusing work the socket still does.
 *
 * One deliberate divergence, marked again where it happens: when the path IS
 * owned by a tenant and the caller holds no role there, this refuses outright
 * instead of dropping through to the provider-session fallback. ws.ts reaches
 * that fallback because `resolveWorkspaceRootTenantRoles` returns null both
 * for "nobody owns this" and for "you are nobody here", and the fallback's
 * "no provider sessions exist, so there is nothing to isolate from" allowance
 * then lets a stranger through. Conflating those two answers is what this
 * whole function exists to stop.
 *
 * This lives in this module only because it is the route that needed it first.
 * Its real home is a service both transports call; ws.ts keeps its copy inside
 * a per-connection closure, which is why extracting it is a change to ws.ts.
 */
export const sessionMayReachWorkspacePath = (
  session: AuthenticatedSession,
  cwd: string,
  permission: TenantPermission,
): Effect.Effect<boolean, never, ServerConfig | OrchestrationEngineService | TenancyRepository> =>
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const engine = yield* OrchestrationEngineService;
    const readModel = yield* engine.getReadModel();

    const knownRoots = [
      ...readModel.projects.map((project) => project.workspaceRoot),
      ...readModel.threads.flatMap((thread) => (thread.worktreePath ? [thread.worktreePath] : [])),
    ];
    // An install with no roots at all is a fresh one, not a locked one — the
    // same first branch ws.ts takes, and what keeps a brand-new desktop app
    // able to open a file before it has registered a project.
    if (knownRoots.length > 0 && !knownRoots.some((root) => isPathInsideRoot(cwd, root))) {
      return false;
    }

    // Owning the install means owning every path on it: the quotas and the
    // isolation exist to keep strangers apart on a shared host, and the
    // machine's own owner is a guest of nobody.
    if (
      isSoleOccupantSession(session, {
        workspaceSource: config.workspaceSource,
        publishedBeyondLoopback: config.publishedBeyondLoopback,
      })
    ) {
      return true;
    }

    const tenantSession = session.tenantSessionContext;
    if (!tenantSession) {
      // A signed-up account with no tenant context cannot be placed in any
      // tenant, so it cannot be shown one's files. A session with neither is a
      // pre-tenancy local client, which ws.ts still lets through.
      return session.userId === undefined;
    }

    const tenancyRepository = yield* TenancyRepository;
    // A collaborator belongs to several tenants at once — their own personal
    // one plus every workspace they were invited into — so authorize against
    // the roles they hold in the tenant that actually owns the path, not the
    // one that happens to be active on the session.
    const owningTenantIds = new Set(
      readModel.projects
        .filter(
          (project) =>
            project.ownership !== undefined && isPathInsideRoot(cwd, project.workspaceRoot),
        )
        .map((project) => project.ownership!.tenantId),
    );

    if (owningTenantIds.size > 0) {
      const memberships = yield* Effect.all({
        organizations: tenancyRepository.loadOrganizations(),
        collaboration: tenancyRepository.loadCollaboration(),
      }).pipe(
        Effect.map(({ organizations, collaboration }) => [
          ...organizations.memberships,
          ...collaboration.memberships,
        ]),
        // Fail closed: if the membership tables cannot be read, nobody is a
        // member of anything.
        Effect.catch(() => Effect.succeed([])),
      );
      const actorUserId = resolveAuthenticatedUserId(session);
      const roles: TenantRole[] = memberships
        .filter(
          (membership) =>
            membership.userId === actorUserId &&
            membership.disabledAt === null &&
            owningTenantIds.has(membership.tenantId),
        )
        .flatMap((membership) => membership.roles);
      // The divergence from ws.ts described above: no membership in the owning
      // tenant is a refusal, not a reason to look somewhere more forgiving.
      return roles.length > 0 && hasTenantPermission({ roles, permission });
    }

    // Unowned path: fall back to provider-session isolation, exactly as ws.ts
    // does. A path registered before tenancy has no ownership stamp, and its
    // own owner must not be refused on their own project.
    if (!hasTenantPermission({ roles: tenantSession.roles, permission })) {
      return false;
    }
    const isolation = yield* tenancyRepository
      .loadProviderIsolation()
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (isolation === null) {
      return false;
    }
    const matchingProviderSession = isolation.providerSessions.find((providerSession) => {
      if (
        providerSession.endedAt !== null ||
        providerSession.tenantId !== tenantSession.tenantId ||
        !isPathInsideRoot(cwd, providerSession.cwd)
      ) {
        return false;
      }
      const providerAccount = isolation.providerAccounts.find(
        (account) => account.id === providerSession.providerAccountId,
      );
      return providerAccount
        ? evaluateProviderAccountAccess({
            account: providerAccount,
            providerSession,
            tenantSession,
          }).allowed
        : false;
    });
    if (matchingProviderSession) {
      return true;
    }
    // No provider sessions exist at all, so there is nothing to be isolated
    // from. The permission itself was already checked just above; this only
    // declines to add a second gate that cannot be satisfied.
    return isolation.providerSessions.length === 0;
  });

export const workspaceFileRouteLayer = HttpRouter.add(
  "GET",
  WORKSPACE_FILE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
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
    // ...and the project root itself must be one this session is allowed to
    // see. The check above is about the `path` parameter; this one is about
    // the `cwd` parameter, which the caller also chose.
    if (!(yield* sessionMayReachWorkspacePath(session, root, "file.read"))) {
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

    const data = yield* fileSystem
      .readFile(servePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!data) {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }
    if (TEXT_TYPES.test(contentType) && !contentType.includes("charset")) {
      contentType = `${contentType}; charset=utf-8`;
    }
    const inline = !forceDownload && INLINE_TYPES.test(contentType);
    const downloadName = servePath === target ? path.basename(target) : path.basename(servePath);
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

/**
 * An upload that ran past the ceiling. Raised from inside the per-chunk write
 * so the stream stops at the first chunk over the line rather than after the
 * client has finished sending.
 */
class UploadLimitExceeded extends Data.TaggedError("UploadLimitExceeded")<{
  readonly bytes: number;
}> {}

/** Anything the disk or the socket did wrong while the body was being written. */
class UploadStreamFailed extends Data.TaggedError("UploadStreamFailed")<{
  readonly cause: unknown;
}> {}

/**
 * Hand one chunk to the file and wait for it to be taken.
 *
 * The callback form of `write` resolves once the chunk is flushed, which is
 * the backpressure: a client faster than the disk is made to wait rather than
 * filling the write stream's buffer with the body we just refused to hold in
 * an ArrayBuffer.
 */
const writeUploadChunk = (
  handle: WriteStream,
  chunk: Uint8Array,
): Effect.Effect<void, UploadStreamFailed> =>
  Effect.callback<void, UploadStreamFailed>((resume) => {
    handle.write(chunk, (error) => {
      resume(error ? Effect.fail(new UploadStreamFailed({ cause: error })) : Effect.void);
    });
  });

/** Close the file and wait for the last bytes to reach it. */
const finishUpload = (handle: WriteStream): Effect.Effect<void, UploadStreamFailed> =>
  Effect.callback<void, UploadStreamFailed>((resume) => {
    let settled = false;
    const settle = (effect: Effect.Effect<void, UploadStreamFailed>) => {
      if (settled) {
        return;
      }
      settled = true;
      resume(effect);
    };
    handle.once("error", (error) => settle(Effect.fail(new UploadStreamFailed({ cause: error }))));
    handle.end(() => settle(Effect.void));
  });

type UploadOutcome = "written" | "too-large" | "failed";

/**
 * Write the request body to `target`, counting as it goes.
 *
 * A partial file is removed on every unhappy path: a refused upload must not
 * leave a truncated file where the previous version of it used to be, and the
 * caller gets a status that says which of the two things went wrong.
 */
const streamUploadToDisk = <E>(
  body: Stream.Stream<Uint8Array, E>,
  target: string,
): Effect.Effect<UploadOutcome> =>
  Effect.gen(function* () {
    const handle = createWriteStream(target);
    // Attached before the first write, not at `end`. A stream error is
    // delivered twice — once to `write`'s callback, which `writeUploadChunk`
    // turns into a typed failure, and once as an `error` event. Node treats an
    // `error` event with no listener as an uncaught exception and takes the
    // process down, so the half that `finishUpload` handles is not the half
    // that kills the server: a disk filling up mid-body would end every
    // WebSocket session on the box. The failure is already carried by the
    // callback, so this listener only has to exist.
    handle.on("error", () => undefined);
    let received = 0;
    const outcome = yield* Stream.runForEach(
      body,
      (chunk: Uint8Array): Effect.Effect<void, UploadLimitExceeded | UploadStreamFailed> => {
        received += chunk.byteLength;
        return received > UPLOAD_MAX_BYTES
          ? Effect.fail(new UploadLimitExceeded({ bytes: received }))
          : writeUploadChunk(handle, chunk);
      },
    ).pipe(
      Effect.flatMap(() => finishUpload(handle)),
      Effect.as<UploadOutcome>("written"),
      Effect.catch((error) =>
        Effect.succeed<UploadOutcome>(
          error instanceof UploadLimitExceeded ? "too-large" : "failed",
        ),
      ),
    );
    if (outcome !== "written") {
      handle.destroy();
      yield* Effect.promise(() => unlink(target).catch(() => undefined));
    }
    return outcome;
  });

/**
 * `POST /api/workspace/file?cwd=<project root>&path=<relative path>` — upload
 * a file's raw bytes (any format, e.g. `.glb`) straight to disk.
 *
 * Uploads used to only be reachable over the WS RPC `file.write` method,
 * base64-encoded inside the `{_tag:"Request"}` envelope. That inflates the
 * payload ~33%, competes with the WS RPC per-request/per-minute size and rate
 * limits meant for control-plane calls, and for anything more than a few MB
 * would make the whole socket appear to hang or drop ("upload for large files
 * just doesn't work / says disconnected"). This route streams the request
 * body straight to a file instead, with no format restriction.
 *
 * "Streams" is load-bearing and used not to be. Reading the body into one
 * `ArrayBuffer` and only then comparing its length to the ceiling means the
 * ceiling is enforced by whatever survives allocating the body: a 3GB POST
 * takes the process out past V8's buffer limit before any 413 can be written,
 * and every WebSocket session on the server drops with it — the very symptom
 * this route was added to cure. The limit is counted as chunks arrive now, so
 * nothing bigger than one chunk is ever resident.
 */
export const workspaceFileUploadRouteLayer = HttpRouter.add(
  "POST",
  WORKSPACE_FILE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const session = yield* serverAuth.authenticateHttpRequest(request);
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const workspaceEntries = yield* WorkspaceEntries;

    const url = HttpServerRequest.toURL(request);
    const params = Option.isSome(url) ? url.value.searchParams : new URLSearchParams();
    const cwd = params.get("cwd") ?? "";
    const relativePath = params.get("path") ?? "";
    if (!cwd.startsWith("/") || cwd.split("/").includes("..") || !relativePath) {
      return HttpServerResponse.text("Bad Request", { status: 400 });
    }
    const root = path.resolve(cwd);
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }
    // Writing is the same question as reading with a higher bar: the caller
    // chose `cwd`, so without this a viewer-role member of some other tenant
    // can replace any file this process can open.
    if (!(yield* sessionMayReachWorkspacePath(session, root, "file.write"))) {
      return HttpServerResponse.text("Forbidden", { status: 403 });
    }

    const tooLargeResponse = HttpServerResponse.text(
      `File exceeds the ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))}MB upload limit.`,
      { status: 413 },
    );
    // Refuse on the declared length before a byte of the body is read. A
    // client that lies about it is still caught while streaming below; this
    // just means the honest, common case costs nothing.
    const declaredLength = Number(request.headers["content-length"] ?? "");
    if (Number.isFinite(declaredLength) && declaredLength > UPLOAD_MAX_BYTES) {
      return tooLargeResponse;
    }

    yield* fileSystem
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.catch(() => Effect.void));
    const outcome = yield* streamUploadToDisk(request.stream, target);
    if (outcome === "too-large") {
      return tooLargeResponse;
    }
    if (outcome === "failed") {
      return HttpServerResponse.text("Internal Server Error", { status: 500 });
    }

    yield* workspaceEntries.invalidate(cwd);

    return HttpServerResponse.jsonUnsafe({ relativePath: path.relative(root, target) || "." });
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
