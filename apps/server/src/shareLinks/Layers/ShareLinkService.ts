import * as Crypto from "node:crypto";
import * as fsPromises from "node:fs/promises";
import * as nodePath from "node:path";

import {
  ShareLinkError,
  type ProjectId,
  type ShareLink,
  type ShareLinkId,
  type ShareLinkScope,
  type ShareLinkToken,
  type TenantId,
  type UserId,
  type WorkspaceId,
} from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";

import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import {
  generateShareLinkToken,
  ShareLinkRepository,
  type ShareLinkRecord,
} from "../../persistence/Services/ShareLinks.ts";
import {
  ShareLinkService,
  type ShareLinkActor,
  type ShareLinkProjectEntry,
  type ShareLinkRedemption,
  type ShareLinkServiceShape,
} from "../Services/ShareLinkService.ts";

/** One workspace, as every authenticated read and write here is scoped. */
interface LinkScope {
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/**
 * What stands in for a token everywhere except the reply to `create`.
 *
 * The contract's `ShareLink` requires a token, so a listing cannot simply omit
 * the field; it can only refuse to put the real one there. A constant is used
 * rather than an empty string because the schema rejects one, and because a
 * client that renders this by mistake shows something a person can recognise as
 * deliberate rather than a plausible-looking secret.
 */
const WITHHELD_TOKEN = "«withheld»" as ShareLinkToken;

/**
 * Ceilings, all of them on the unauthenticated path.
 *
 * A share link is reachable by anyone who has the URL and by anyone the URL was
 * forwarded to, so every read it can trigger has to be bounded before it starts
 * rather than trusted to be small. The file cap matches the editor's, since a
 * file too large to open is also too large to publish; the walk caps stop a
 * link on a monorepo from turning one GET into a full-tree stat.
 */
const MAX_SHARED_FILE_BYTES = 512_000;
const MAX_LISTED_ENTRIES = 2_000;
const MAX_LISTING_DEPTH = 12;

/**
 * Path segments a share link may never reach, whoever wrote the path.
 *
 * Dot-directories are the whole of a project's secrets: `.git/config` carries
 * push credentials, `.env` carries everything else, `.ssh` carries keys. A
 * member picking a file to share has no reason to want one and every chance of
 * doing it by accident — and a `project` link lets an anonymous visitor name
 * the path outright, at which point `.git/config` is the first thing anyone
 * would try. `node_modules` is excluded for size rather than secrecy.
 */
function isForbiddenSegment(segment: string): boolean {
  return segment.startsWith(".") || segment === "node_modules";
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * A failed read of storage, in the only vocabulary this error has.
 *
 * `ShareLinkError` lists product outcomes and has no infrastructure member on
 * purpose. `not-found` is the right non-answer for a visitor either way, and it
 * is the same non-answer they get for a token that never existed — so a
 * database that is briefly unreachable cannot be told apart from a bad guess.
 * The cause travels with it for whoever reads the log.
 */
function storageFailure(message: string) {
  return (cause: unknown) => new ShareLinkError({ code: "not-found", message, cause });
}

/**
 * The single wording every dead end shares.
 *
 * Missing, expired, revoked, a project since deleted, a path that escapes the
 * root: one sentence and one code for all of them. Any difference between them
 * is an oracle — a caller who can tell "expired" from "no such link" can
 * confirm that a guessed token was once real, and one that can tell "no such
 * file" from "outside the root" can map the filesystem a byte at a time.
 */
function notFound(): ShareLinkError {
  return new ShareLinkError({
    code: "not-found",
    message: "This link is not available.",
  });
}

/**
 * Storage keeps primitives, so the scope has to be re-narrowed on the way out.
 * A row naming a scope this build has never heard of resolves to nothing rather
 * than being decoded optimistically: an unknown scope is an unknown grant, and
 * the safe reading of an unknown grant is no grant at all.
 */
function toScope(value: string): ShareLinkScope | null {
  return value === "file" || value === "project" || value === "workspace" ? value : null;
}

/**
 * Ids are cast rather than re-parsed, the same trade `ProviderSharingService`
 * makes: they were branded when they were written, and re-validating a stored
 * id would turn one malformed row into a failed read of the whole panel.
 */
function toShareLinkFields(record: ShareLinkRecord, scope: ShareLinkScope) {
  return {
    id: record.linkId as ShareLinkId,
    scope,
    tenantId: record.tenantId as TenantId,
    workspaceId: record.workspaceId as WorkspaceId,
    projectId: record.projectId === null ? null : (record.projectId as ProjectId),
    filePath: record.filePath,
    createdByUserId: record.createdByUserId as UserId,
    label: record.label,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastViewedAt: record.lastViewedAt,
    viewCount: record.viewCount,
  };
}

/** Everything about a link except the credential. Every read but `create`. */
function toRedactedShareLink(record: ShareLinkRecord): ShareLink | null {
  const scope = toScope(record.scope);
  return scope === null ? null : { ...toShareLinkFields(record, scope), token: WITHHELD_TOKEN };
}

/** The one reply that carries the secret, to the one person who just minted it. */
function toMintedShareLink(record: ShareLinkRecord): ShareLink | null {
  const scope = toScope(record.scope);
  return scope === null
    ? null
    : { ...toShareLinkFields(record, scope), token: record.token as ShareLinkToken };
}

/** Null means it never lapses; anything unparseable is treated as lapsed. */
function hasExpired(expiresAt: string | null, at: number): boolean {
  if (expiresAt === null) {
    return false;
  }
  const lapsesAt = Date.parse(expiresAt);
  return Number.isNaN(lapsesAt) || lapsesAt <= at;
}

/**
 * Splits a path into segments this service is willing to walk, or refuses.
 *
 * No decoding happens here, deliberately. The URL parser has already
 * percent-decoded the query, and a second pass would turn a filename that
 * genuinely contains `%2e%2e` into a traversal — the classic double-decode bug.
 * What arrives is taken as final and judged as-is.
 */
function safeSegments(requested: string): ReadonlyArray<string> | null {
  const candidate = requested.trim();
  if (candidate.length === 0 || candidate.includes("\0") || nodePath.isAbsolute(candidate)) {
    return null;
  }
  // Backslashes are separators too. On Windows they are the separator, and on
  // POSIX treating `..\..` as one opaque filename would let a link created on
  // one platform escape when it is read on the other.
  const segments = candidate.split(/[\\/]+/);
  return segments.length > 0 && segments.every((segment) => !isForbiddenSegment(segment))
    ? segments
    : null;
}

const makeShareLinkService = Effect.gen(function* () {
  const repository = yield* ShareLinkRepository;
  const collaboration = yield* CollaborationService;
  const projects = yield* ProjectionProjectRepository;

  /**
   * Membership, from the collaboration roster and nowhere else.
   *
   * A second definition of "who is in this workspace" would eventually disagree
   * with the panel the user is looking at, and this one decides who may hand
   * out access to files. Asking about a workspace you are not in is `forbidden`
   * rather than an empty list, so the panel can say why.
   */
  const requireMember = (actor: ShareLinkActor, scope: LinkScope) =>
    collaboration.listMembers(actor, scope).pipe(
      Effect.mapError(storageFailure("Could not read who belongs to this workspace.")),
      Effect.flatMap((members) =>
        members.members.some((member) => member.userId === actor.userId)
          ? Effect.void
          : Effect.fail(
              new ShareLinkError({
                code: "forbidden",
                message: "Only a member of this workspace can manage its share links.",
              }),
            ),
      ),
    );

  /**
   * Scope and target have to agree, and the check is exhaustive on purpose.
   *
   * A `file` link with no path would serve the project; a `workspace` link that
   * carried a project id would leave a row whose scope and columns tell two
   * different stories, and the next reader of that row gets to choose which one
   * to believe. Extra targeting is refused rather than ignored for the same
   * reason: silently dropping it stores something other than what was asked for.
   */
  const validateTarget = (input: {
    readonly scope: ShareLinkScope;
    readonly projectId: ProjectId | null;
    readonly filePath: string | null;
  }): Effect.Effect<void, ShareLinkError> => {
    const invalid = (message: string) =>
      Effect.fail(new ShareLinkError({ code: "invalid-target", message }));

    if (input.scope === "workspace") {
      return input.projectId === null && input.filePath === null
        ? Effect.void
        : invalid("A workspace link opens the whole workspace and cannot name a project or file.");
    }
    if (input.projectId === null) {
      return invalid(`A ${input.scope} link needs a project to point at.`);
    }
    if (input.scope === "project") {
      return input.filePath === null
        ? Effect.void
        : invalid("A project link opens the whole project and cannot also name a file.");
    }
    if (input.filePath === null) {
      return invalid("A file link needs a file path to point at.");
    }
    // Refused at creation as well as at redemption. Storing a path that can
    // never be served would make the link look minted and fail only later, in
    // front of whoever it was sent to.
    return safeSegments(input.filePath) === null
      ? invalid("That file path cannot be shared.")
      : Effect.void;
  };

  /**
   * The project's root on disk, and proof it is this workspace's to hand out.
   *
   * A project id arrives on the wire from a member of *some* workspace, and
   * project ids are global — without this, being in any workspace would be
   * enough to publish any project on the server. Ownership is re-checked on
   * every redemption rather than only at creation, so a project that moves to
   * another workspace takes its old links dead with it.
   *
   * A project with no ownership at all is a purely local one, created before
   * any tenancy existed and belonging to whoever is running the server. It is
   * allowed, because refusing it would break sharing on every single-user
   * install for the sake of a check that has nothing to compare against.
   */
  const readProject = (scope: LinkScope, projectId: ProjectId) =>
    projects.getById({ projectId }).pipe(
      Effect.mapError(storageFailure("Could not read the project this link points at.")),
      Effect.flatMap((project) => {
        if (Option.isNone(project) || project.value.deletedAt !== null) {
          return Effect.fail(notFound());
        }
        const ownership = project.value.ownership;
        return ownership !== null &&
          (ownership.tenantId !== scope.tenantId || ownership.workspaceId !== scope.workspaceId)
          ? Effect.fail(notFound())
          : Effect.succeed(project.value);
      }),
    );

  const tryFs = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: () => notFound() });

  /**
   * A project-relative path becomes an absolute one inside the root, or fails.
   *
   * Three separate guards, because each catches what the others cannot. The
   * segment check refuses `..` and dot-directories before anything touches the
   * disk. The lexical check catches whatever the first missed — a path that
   * still resolves outside once joined. The realpath check is the only one that
   * sees a symlink: `link -> /etc/passwd` inside the project is a perfectly
   * ordinary relative path with no `..` in it, and lexical resolution says yes.
   */
  const resolveWithinRoot = (workspaceRoot: string, requested: string) =>
    Effect.gen(function* () {
      const segments = safeSegments(requested);
      if (segments === null) {
        return yield* notFound();
      }

      const root = nodePath.resolve(workspaceRoot);
      const absolutePath = nodePath.resolve(root, segments.join(nodePath.sep));
      const relative = nodePath.relative(root, absolutePath);
      if (
        relative.length === 0 ||
        relative === ".." ||
        relative.startsWith(`..${nodePath.sep}`) ||
        nodePath.isAbsolute(relative)
      ) {
        return yield* notFound();
      }

      // The root is realpathed too. A project registered under a symlinked
      // parent — /tmp on macOS, a symlinked home, a symlinked checkout — would
      // otherwise compare a resolved file against an unresolved root and every
      // legitimate read would look like an escape.
      const realRoot = yield* tryFs(() => fsPromises.realpath(root));
      const realTarget = yield* tryFs(() => fsPromises.realpath(absolutePath));
      const realRelative = nodePath.relative(realRoot, realTarget);
      if (
        realRelative.length === 0 ||
        realRelative === ".." ||
        realRelative.startsWith(`..${nodePath.sep}`) ||
        nodePath.isAbsolute(realRelative)
      ) {
        return yield* notFound();
      }

      return { absolutePath: realTarget, relativePath: segments.join("/") };
    });

  const readSharedFile = (workspaceRoot: string, requested: string) =>
    Effect.gen(function* () {
      const target = yield* resolveWithinRoot(workspaceRoot, requested);
      const stats = yield* tryFs(() => fsPromises.stat(target.absolutePath));
      // A directory reached through a file link is not a file, and saying so
      // would confirm the path exists; it joins every other dead end instead.
      if (!stats.isFile()) {
        return yield* notFound();
      }
      if (stats.size > MAX_SHARED_FILE_BYTES) {
        return yield* new ShareLinkError({
          code: "invalid-target",
          message: "That file is too large to share.",
        });
      }
      const contents = yield* tryFs(() => fsPromises.readFile(target.absolutePath));
      return {
        filePath: target.relativePath,
        contents: Uint8Array.from(contents),
        sizeBytes: contents.length,
      };
    });

  /**
   * Every file in the project, breadth-first and hard-capped.
   *
   * Symlinks are skipped rather than followed. A followed link would let the
   * listing describe files outside the project, and — since the visitor then
   * asks for them by the path the listing gave — read them too, defeating the
   * guard in `resolveWithinRoot` by going around it.
   */
  const listProjectEntries = (workspaceRoot: string) =>
    Effect.tryPromise({
      try: async () => {
        const root = nodePath.resolve(workspaceRoot);
        const entries: ShareLinkProjectEntry[] = [];
        const queue: Array<{ readonly absolutePath: string; readonly depth: number }> = [
          { absolutePath: root, depth: 0 },
        ];
        let truncated = false;

        while (queue.length > 0) {
          const next = queue.shift();
          if (!next) {
            break;
          }
          const children = await fsPromises
            .readdir(next.absolutePath, { withFileTypes: true })
            // An unreadable directory costs its own subtree and not the listing.
            .catch(() => []);
          for (const child of children) {
            if (isForbiddenSegment(child.name) || child.isSymbolicLink()) {
              continue;
            }
            const absolutePath = nodePath.join(next.absolutePath, child.name);
            if (child.isDirectory()) {
              if (next.depth + 1 <= MAX_LISTING_DEPTH) {
                queue.push({ absolutePath, depth: next.depth + 1 });
              }
              continue;
            }
            if (!child.isFile()) {
              continue;
            }
            if (entries.length >= MAX_LISTED_ENTRIES) {
              truncated = true;
              queue.length = 0;
              break;
            }
            const stats = await fsPromises.stat(absolutePath).catch(() => null);
            entries.push({
              path: nodePath.relative(root, absolutePath).split(nodePath.sep).join("/"),
              sizeBytes: stats?.size ?? 0,
            });
          }
        }

        entries.sort((left, right) => left.path.localeCompare(right.path));
        return { entries: entries as ReadonlyArray<ShareLinkProjectEntry>, truncated };
      },
      catch: () => notFound(),
    });

  /**
   * Counts the visit, and never fails the visit.
   *
   * The person on the other end asked to read a file, not to be measured. A
   * failed write here is logged and swallowed: refusing the content because the
   * analytics row would not go in would break the feature to protect a counter.
   */
  const recordView = (linkId: string, viewerFingerprint: string | null) =>
    repository
      .recordView({
        viewId: Crypto.randomUUID(),
        linkId,
        viewedAt: nowIso(),
        // Always null. A share link is redeemed with no session, and the route
        // is mounted where there is none to read — recording a viewer here
        // would mean inventing one.
        viewerUserId: null,
        viewerFingerprint,
      })
      .pipe(
        Effect.catch((error) =>
          // The link id, never the token: this line is written on an
          // unauthenticated request, and a token in a log is a credential in a
          // log.
          Effect.logWarning("failed to record a share link view", {
            linkId,
            operation: error.operation,
            detail: error.detail,
          }),
        ),
      );

  const create: ShareLinkServiceShape["create"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: LinkScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      yield* requireMember(actor, scope);

      const projectId = input.projectId ?? null;
      const filePath = input.filePath ?? null;
      yield* validateTarget({ scope: input.scope, projectId, filePath });
      if (projectId !== null) {
        // A project that is missing and a project belonging to somebody else
        // give the same answer, so this cannot be used to discover which
        // project ids exist on the server.
        yield* readProject(scope, projectId).pipe(
          Effect.mapError(
            () =>
              new ShareLinkError({
                code: "invalid-target",
                message: "That project is not one this workspace can share.",
              }),
          ),
        );
      }

      const record = yield* repository
        .createLink({
          linkId: Crypto.randomUUID(),
          // The repository's generator and nothing else: it is the one line of
          // this feature where the strength of every link is decided.
          token: generateShareLinkToken(),
          scope: input.scope,
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          projectId,
          filePath,
          // From the session, never the payload — otherwise anyone could mint
          // links in somebody else's name.
          createdByUserId: actor.userId,
          label: input.label ?? null,
          createdAt: nowIso(),
          expiresAt: input.expiresAt ?? null,
        })
        .pipe(Effect.mapError(storageFailure("Could not create that share link.")));

      const link = toMintedShareLink(record);
      return link === null ? yield* notFound() : { link };
    });

  const list: ShareLinkServiceShape["list"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: LinkScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      yield* requireMember(actor, scope);

      const projectId = input.projectId ?? null;
      const records =
        projectId === null
          ? yield* repository
              .listLinksForWorkspace(scope)
              .pipe(Effect.mapError(storageFailure("Could not read this workspace's links.")))
          : yield* repository
              .listLinksForProject({ tenantId: input.tenantId, projectId })
              .pipe(Effect.mapError(storageFailure("Could not read this project's links.")));

      const links: ShareLink[] = [];
      for (const record of records) {
        // The project read is keyed by tenant and project, not by workspace, so
        // the workspace is re-checked here. The caller was only authorised for
        // one workspace, and a project shared into another one must not appear
        // in this answer because of how the index happens to be shaped.
        if (record.workspaceId !== input.workspaceId) {
          continue;
        }
        const link = toRedactedShareLink(record);
        if (link !== null) {
          links.push(link);
        }
      }
      return { links };
    });

  const revoke: ShareLinkServiceShape["revoke"] = (actor, input) =>
    Effect.gen(function* () {
      const scope: LinkScope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
      yield* requireMember(actor, scope);

      const revokedAt = nowIso();
      const record = yield* repository
        .revokeLink({ linkId: input.linkId, ...scope, revokedAt })
        .pipe(Effect.mapError(storageFailure("Could not revoke that share link.")));
      if (Option.isNone(record)) {
        return yield* new ShareLinkError({
          code: "not-found",
          message: "There is no such link in this workspace.",
        });
      }

      // Asked of the write itself rather than inferred from the timestamp it
      // returned: two revokes inside one millisecond carry the same string, and
      // the second used to report success.
      if (record.value.alreadyRevoked) {
        return yield* new ShareLinkError({
          code: "revoked",
          message: "That link was already revoked.",
        });
      }

      const link = toRedactedShareLink(record.value.record);
      return link === null ? yield* notFound() : { link };
    });

  const redeem: ShareLinkServiceShape["redeem"] = (input) =>
    Effect.gen(function* () {
      const found = yield* repository
        .getLinkByToken({ token: input.token })
        .pipe(Effect.mapError(storageFailure("Could not read that link.")));
      if (Option.isNone(found)) {
        return yield* notFound();
      }

      const record = found.value;
      const link = toRedactedShareLink(record);
      // The link is redacted before it is handed back even here. A visitor
      // holding the token in their URL bar gains nothing from being told it
      // again, and every place the token is not is a place it cannot leak from.
      if (link === null) {
        return yield* notFound();
      }
      // Both of these are real distinctions the owner's panel shows, and both
      // collapse to `not-found` out here: telling a stranger that their token
      // is expired confirms it was once issued.
      if (record.revokedAt !== null || hasExpired(record.expiresAt, Date.now())) {
        return yield* notFound();
      }

      const redemption: ShareLinkRedemption = yield* Effect.gen(function* () {
        if (link.scope === "workspace") {
          // A workspace link has nothing to resolve, and a `path` alongside one
          // is refused rather than dropped: it is an attempt to read files
          // through a link that grants none.
          return input.path === undefined || input.path === null
            ? ({ kind: "workspace", link } as const)
            : yield* notFound();
        }
        if (link.projectId === null) {
          return yield* notFound();
        }
        const project = yield* readProject(
          { tenantId: link.tenantId, workspaceId: link.workspaceId },
          link.projectId,
        );

        if (link.scope === "file") {
          // The stored path wins outright. A `file` link that honoured a
          // visitor's `path` would be a project link, which is the widening the
          // scopes exist to prevent.
          if (link.filePath === null) {
            return yield* notFound();
          }
          const file = yield* readSharedFile(project.workspaceRoot, link.filePath);
          return { kind: "file", link, ...file } as const;
        }

        if (input.path === undefined || input.path === null) {
          const listing = yield* listProjectEntries(project.workspaceRoot);
          return {
            kind: "project",
            link,
            projectTitle: project.title,
            entries: listing.entries,
            truncated: listing.truncated,
          } as const;
        }
        const file = yield* readSharedFile(project.workspaceRoot, input.path);
        return { kind: "file", link, ...file } as const;
      });

      // Only after the target resolved. Counting a refused request would let
      // anyone with the URL inflate a link's view count, and — worse — make the
      // owner's list report traffic that never saw anything.
      yield* recordView(record.linkId, input.viewerFingerprint ?? null);
      return redemption;
    });

  return { create, list, revoke, redeem } satisfies ShareLinkServiceShape;
});

export const ShareLinkServiceLive: Layer.Layer<
  ShareLinkService,
  never,
  ShareLinkRepository | CollaborationService | ProjectionProjectRepository
> = Layer.effect(ShareLinkService, makeShareLinkService);
