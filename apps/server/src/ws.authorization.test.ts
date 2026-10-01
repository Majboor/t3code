import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  isOrchestrationEventVisible,
  isProjectOwnershipVisible,
  isThreadWorktreePathAllowed,
  isWorkspaceRootOffLimits,
  keepRowsInVisibleProjects,
  redactForeignService,
  resolveBrowseListingDirectory,
} from "./ws.ts";

/**
 * Each case here is one of the audited leaks, written as the actor and what
 * they reached. Every one of these calls answered the other way before the
 * decision existed at all: the list RPCs skipped their check when the optional
 * filter was absent, the replay returned the instance's whole event log, and
 * `worktreePath` was metadata rather than a path.
 */

describe("keepRowsInVisibleProjects", () => {
  const rows = [
    { id: "target-mine", projectId: "project-mine" },
    { id: "target-theirs", projectId: "project-theirs" },
  ];

  // deploy.listTargets / listRuns / listDeployments / analytics.listStreams
  // with no projectId: the repository's no-filter branch is every row on the
  // instance, so the answer has to be narrowed to what this caller may see.
  it("drops another tenant's rows when no project was named", () => {
    expect(keepRowsInVisibleProjects(rows, new Set(["project-mine"]))).toEqual([
      { id: "target-mine", projectId: "project-mine" },
    ]);
  });

  // A tenant with no projects of its own asked for every SSH host on the box.
  it("gives a caller who can see no project nothing at all", () => {
    expect(keepRowsInVisibleProjects(rows, new Set())).toEqual([]);
  });

  // The single-user desktop and the pre-tenancy paired client are scoped to
  // nothing on purpose: every project on that machine is genuinely theirs.
  it("leaves an unscoped session's rows alone", () => {
    expect(keepRowsInVisibleProjects(rows, null)).toEqual(rows);
  });

  // A row naming a project we cannot resolve is a row we cannot attribute.
  it("drops a row whose project is not in the visible set", () => {
    expect(
      keepRowsInVisibleProjects(
        [{ id: "orphan", projectId: "project-gone" }],
        new Set(["project-mine"]),
      ),
    ).toEqual([]);
  });
});

describe("isProjectOwnershipVisible", () => {
  const visibleTenantIds = new Set(["tenant-mine"]) as unknown as ReadonlySet<never>;

  it("hides another tenant's project", () => {
    expect(
      isProjectOwnershipVisible({
        ownership: { tenantId: "tenant-theirs" } as never,
        visibleTenantIds,
        unownedProjectsAreShared: true,
      }),
    ).toBe(false);
  });

  it("shows a project of a tenant the caller belongs to", () => {
    expect(
      isProjectOwnershipVisible({
        ownership: { tenantId: "tenant-mine" } as never,
        visibleTenantIds,
        unownedProjectsAreShared: false,
      }),
    ).toBe(true);
  });

  // On a published server an unowned project is the host's own; on a desktop
  // install it predates tenancy and must stay reachable by its owner.
  it("keeps a pre-tenancy project reachable locally and hidden once published", () => {
    expect(
      isProjectOwnershipVisible({
        ownership: undefined,
        visibleTenantIds,
        unownedProjectsAreShared: true,
      }),
    ).toBe(true);
    expect(
      isProjectOwnershipVisible({
        ownership: undefined,
        visibleTenantIds,
        unownedProjectsAreShared: false,
      }),
    ).toBe(false);
  });

  it("shows everything to a session scoped to nothing", () => {
    expect(
      isProjectOwnershipVisible({
        ownership: { tenantId: "tenant-theirs" } as never,
        visibleTenantIds: null,
        unownedProjectsAreShared: false,
      }),
    ).toBe(true);
  });
});

describe("isOrchestrationEventVisible", () => {
  const scope = {
    visibleProjectIds: new Set(["project-mine"]),
    projectIdByThreadId: new Map([
      ["thread-mine", "project-mine"],
      ["thread-theirs", "project-theirs"],
    ]),
  };

  // orchestration.replayEvents from sequence 0 used to hand back every
  // `project.created` payload on the instance, workspaceRoot and all.
  it("drops another tenant's project event", () => {
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "project", aggregateId: "project-theirs" as never },
        scope,
      ),
    ).toBe(false);
  });

  // ...and every `thread.message-sent` payload, which carries the full text of
  // a prompt and of the reply.
  it("drops another tenant's thread event", () => {
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "thread", aggregateId: "thread-theirs" as never },
        scope,
      ),
    ).toBe(false);
  });

  it("keeps the caller's own project and thread events", () => {
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "project", aggregateId: "project-mine" as never },
        scope,
      ),
    ).toBe(true);
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "thread", aggregateId: "thread-mine" as never },
        scope,
      ),
    ).toBe(true);
  });

  // Fail closed: an event we cannot attribute to a project is not an event we
  // can say belongs to the caller.
  it("drops a thread event whose thread cannot be placed", () => {
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "thread", aggregateId: "thread-unknown" as never },
        scope,
      ),
    ).toBe(false);
  });

  it("replays everything for a session scoped to nothing", () => {
    expect(
      isOrchestrationEventVisible(
        { aggregateKind: "thread", aggregateId: "thread-theirs" as never },
        { ...scope, visibleProjectIds: null },
      ),
    ).toBe(true);
  });
});

describe("isWorkspaceRootOffLimits", () => {
  const protectedRoots = ["/srv/t3/state", "/srv/t3", "/root/.ssh"];

  // project.create accepted any absolute directory nobody had claimed yet, and
  // the project it handed back made that directory readable and writable
  // through every cwd-gated RPC.
  it("refuses the server's own base and state directories", () => {
    expect(isWorkspaceRootOffLimits({ workspaceRoot: "/srv/t3/state", protectedRoots })).toBe(true);
    expect(
      isWorkspaceRootOffLimits({ workspaceRoot: "/srv/t3/tenant-runtimes/t1", protectedRoots }),
    ).toBe(true);
  });

  it("refuses the provider credential homes and the ssh directory", () => {
    expect(isWorkspaceRootOffLimits({ workspaceRoot: "/root/.codex", protectedRoots })).toBe(true);
    expect(isWorkspaceRootOffLimits({ workspaceRoot: "/root/.claude", protectedRoots })).toBe(true);
    expect(isWorkspaceRootOffLimits({ workspaceRoot: "/root/.ssh", protectedRoots })).toBe(true);
    expect(
      isWorkspaceRootOffLimits({ workspaceRoot: "/home/dev/.config/t3/secrets", protectedRoots }),
    ).toBe(true);
  });

  it("still lets an ordinary project directory through", () => {
    expect(
      isWorkspaceRootOffLimits({ workspaceRoot: "/root/Desktop/my-app", protectedRoots }),
    ).toBe(false);
    expect(
      isWorkspaceRootOffLimits({ workspaceRoot: "/root/Desktop/my-app/", protectedRoots }),
    ).toBe(false);
  });
});

describe("isThreadWorktreePathAllowed", () => {
  const worktreesDir = "/srv/t3/worktrees";

  // A caller holding session.create on one project of their own sent
  // worktreePath: "/root" and got an agent with read and write over the box.
  it("refuses a path outside the project and outside the worktrees directory", () => {
    expect(
      isThreadWorktreePathAllowed({
        worktreePath: "/root",
        projectWorkspaceRoot: "/root/Desktop/my-app",
        worktreesDir,
      }),
    ).toBe(false);
    expect(
      isThreadWorktreePathAllowed({
        worktreePath: "/root/Desktop/their-app",
        projectWorkspaceRoot: "/root/Desktop/my-app",
        worktreesDir,
      }),
    ).toBe(false);
  });

  it("allows a worktree inside its own project", () => {
    expect(
      isThreadWorktreePathAllowed({
        worktreePath: "/root/Desktop/my-app/feature",
        projectWorkspaceRoot: "/root/Desktop/my-app",
        worktreesDir,
      }),
    ).toBe(true);
  });

  // What prepareWorktree actually creates.
  it("allows a worktree the server made for it", () => {
    expect(
      isThreadWorktreePathAllowed({
        worktreePath: "/srv/t3/worktrees/thread-1",
        projectWorkspaceRoot: "/root/Desktop/my-app",
        worktreesDir,
      }),
    ).toBe(true);
  });

  // Fail closed: a project we cannot resolve is a path we cannot measure.
  it("refuses when the project cannot be resolved", () => {
    expect(
      isThreadWorktreePathAllowed({
        worktreePath: "/root/Desktop/my-app",
        projectWorkspaceRoot: undefined,
        worktreesDir,
      }),
    ).toBe(false);
  });
});

describe("resolveBrowseListingDirectory", () => {
  // The guard checked the resolved target; browse lists the target's PARENT
  // whenever the typed text has no trailing separator, so one character walked
  // around the exact-match check and enumerated another tenant's project root.
  it("names the parent when the typed text is a name prefix", () => {
    expect(
      resolveBrowseListingDirectory({
        partialPath: "/root/victim-app/a",
        resolvedTarget: "/root/victim-app/a",
      }),
    ).toBe("/root/victim-app");
  });

  it("names the directory itself when the text ends in a separator", () => {
    expect(
      resolveBrowseListingDirectory({
        partialPath: "/root/victim-app/",
        resolvedTarget: "/root/victim-app",
      }),
    ).toBe("/root/victim-app");
    expect(resolveBrowseListingDirectory({ partialPath: "~", resolvedTarget: "/root" })).toBe(
      "/root",
    );
  });
});

describe("redactForeignService", () => {
  const foreign = {
    port: 5432,
    name: "postgres",
    state: "listening",
    ownership: "ours",
    pid: 4242,
    command: "postgres --password=hunter2",
    startedBy: "user-someone-else",
    ownershipReason: "matched /usr/lib/postgresql/16/bin/postgres -D /var/lib/postgresql",
    canManage: true,
  };

  // A service T3 started for a colleague. Blanking these was the first attempt
  // and it was the wrong axis: the leak is other people's processes on a shared
  // host, not a workspace-mate's dev server, and an anonymous row leaves a port
  // held by nobody. The command line still goes — it carries the password here,
  // which is exactly why.
  it("drops a colleague's command line but keeps their row legible", () => {
    const seen = redactForeignService(foreign, "user-me");
    expect(seen.port).toBe(5432);
    expect(seen.state).toBe("listening");
    expect(seen.command).toBeNull();
    expect(seen.pid).toBeNull();
    expect(seen.canManage).toBe(false);
    expect(seen.name).toBe("postgres");
    expect(seen.startedBy).toBe("user-someone-else");
  });

  it("leaves the caller's own service whole", () => {
    expect(redactForeignService({ ...foreign, startedBy: "user-me" }, "user-me")).toEqual({
      ...foreign,
      startedBy: "user-me",
    });
  });

  // A row T3 did not start has no owner to compare against, so it is foreign.
  it("redacts a process T3 never started", () => {
    const seen = redactForeignService(
      { ...foreign, ownership: "unknown", startedBy: null },
      "user-me",
    );
    expect(seen.command).toBeNull();
    expect(seen.pid).toBeNull();
  });
});

/**
 * A guard for the SHAPE rather than a line: four list RPCs authorized on an
 * optional `projectId` with `input.projectId === undefined ? Effect.void : …`,
 * so leaving the field out skipped the check and returned every tenant's rows.
 * Omitting a filter must narrow a result, never decide whether a check runs —
 * and the next list RPC somebody adds must not copy the pattern back in.
 */
describe("ws.ts authorization shape", () => {
  const source = readFileSync(path.join(import.meta.dirname, "ws.ts"), "utf8");
  const handlerBody = (method: string): string => {
    const start = source.indexOf(`[WS_METHODS.${method}]:`);
    expect(start, `${method} handler not found`).toBeGreaterThan(-1);
    const next = source.indexOf("[WS_METHODS.", start + 1);
    return source.slice(start, next === -1 ? undefined : next);
  };

  for (const method of [
    "deployListTargets",
    "deployListRuns",
    "deployListDeployments",
    "analyticsListStreams",
  ]) {
    it(`${method} authorizes every id it was given and narrows the rest`, () => {
      const body = handlerBody(method);
      // The one chain that authorizes an explicit projectId AND an explicit
      // targetId, and resolves the caller's visible projects when neither was
      // named. The ternary it replaced returned Effect.void for "no filter".
      expect(body).toContain("resolveDeployListScope(input)");
      // ...and the rows themselves are filtered, so an unfiltered repository
      // query cannot leak past the scope.
      expect(body).toContain("keepRowsInVisibleProjects");
    });
  }
});

/**
 * The rest of these checks are on the WIRING, not on a decision.
 *
 * Every handler below lives inside `makeWsRpcLayer`'s per-connection closure,
 * which cannot be built without the whole server graph, so what is asserted
 * here is that the gate is present in the chain that serves the method. Each
 * one fails against the code as it was: the gates did not exist.
 */
describe("ws.ts gates that are wired rather than decided", () => {
  const source = readFileSync(path.join(import.meta.dirname, "ws.ts"), "utf8");
  const slice = (from: string, to: string): string => {
    const start = source.indexOf(from);
    expect(start, `${from} not found`).toBeGreaterThan(-1);
    const end = source.indexOf(to, start + from.length);
    return source.slice(start, end === -1 ? undefined : end);
  };

  // The replay handed back the instance's whole event log from sequence 0.
  it("scopes the orchestration replay to the caller's projects", () => {
    const body = slice(
      "[ORCHESTRATION_WS_METHODS.replayEvents]:",
      "[ORCHESTRATION_WS_METHODS.subscribeShell]:",
    );
    expect(body).toContain("sessionVisibleProjectIds()");
    expect(body).toContain("isOrchestrationEventVisible");
  });

  // Authorized once at subscribe, then streaming after removal or revocation.
  it("re-checks the thread and collaboration subscriptions while they run", () => {
    expect(
      slice("[ORCHESTRATION_WS_METHODS.subscribeThread]:", "[WS_METHODS.serverGetConfig]:"),
    ).toContain("withLiveAccessRecheck");
    expect(
      slice("[WS_METHODS.subscribeCollaboration]:", "[WS_METHODS.providerSharingOverviewGet]:"),
    ).toContain("withLiveAccessRecheck");
  });

  // A revoked credential kept the whole RPC surface on the socket it held.
  it("refuses every rate-limited call once this session has been revoked", () => {
    expect(slice("const checkRateLimit =", "const ensureHostedFileWriteLimit")).toContain(
      "ensureSessionNotRevoked(toError)",
    );
  });

  // Every active session on the instance, gated only by the settings panel.
  it("gates the auth-access subscription on the owner server-side", () => {
    expect(slice("[WS_METHODS.subscribeAuthAccess]:", "loadAuthAccessSnapshot()")).toContain(
      'session.role !== "owner"',
    );
  });

  // Any absolute directory on the box was claimable, and a caller-supplied
  // worktree became the agent's cwd.
  it("guards the paths a dispatched command can name", () => {
    const authorize = slice(
      "const ensureOrchestrationCommandAuthorized =",
      "const toBootstrapDispatchCommandCauseError",
    );
    expect(authorize).toContain("ensureWorkspaceRootClaimable");
    // thread.create, the turn bootstrap, and repointing an existing thread.
    expect(authorize.match(/ensureThreadWorktreePathAllowed\(/g)?.length).toBe(3);
  });

  // `project.create` checked the path it was claiming; `project.meta.update`
  // checked nothing about the path it was about to claim instead. So
  // `project.edit` on one project of your own repointed it at another tenant's
  // directory, the server's own home, or `/` — and a project root is what every
  // other check measures a path against.
  it("checks the new root a project edit names, not only the old one", () => {
    const authorize = slice(
      "const ensureOrchestrationCommandAuthorized =",
      "const toBootstrapDispatchCommandCauseError",
    );
    const start = authorize.indexOf('case "project.meta.update":');
    expect(start, "project.meta.update case not found").toBeGreaterThan(-1);
    const end = authorize.indexOf('case "project.delete":', start);
    expect(end, "project.delete case not found").toBeGreaterThan(start);
    const metaUpdate = authorize.slice(start, end);
    expect(metaUpdate).toContain("ensureWorkspaceRootClaimable");
    expect(metaUpdate).toContain("ensureWorkspaceRootNotClaimedByOtherTenant");
  });

  // `ownership` is the denormalized stamp every later check reads to decide
  // whose a project is, and on an edit it arrived from the client with nothing
  // re-deriving it from the session.
  it("re-derives a project's ownership stamp on an edit as well as a create", () => {
    const attach = slice("const attachProjectOwnership =", "const attachMessageAuthor");
    expect(attach).toContain('command.type !== "project.meta.update"');
  });

  // `isProjectOwnershipVisible` decides whether an unowned project is "the only
  // person's own" or "the host's", and the file routes, the attachment route
  // and cloud sync decide the identical question with `isSoleOccupantSession`,
  // which counts the local accounts that can sign in. Keyed on the publish flag
  // alone, a loopback install with two accounts listed those projects to both
  // of them and then refused both of them every file and every inline image
  // inside — offered on the dashboard, unopenable.
  it("shares an unowned project only with the session that owns the machine", () => {
    const sites = source.match(/const unownedProjectsAreShared = [^;]+;/g) ?? [];
    expect(sites.length, "both visibility sites").toBe(2);
    for (const site of sites) {
      expect(site).toContain("machineOwnerSession");
      expect(site).not.toContain("publishedBeyondLoopback");
    }
  });

  it("redacts other people's processes from the service list", () => {
    expect(
      slice("[WS_METHODS.environmentServicesList]:", "[WS_METHODS.environmentServicesRegister]:"),
    ).toContain("redactForeignService");
  });

  // acceptInvite refuses only on a positive email mismatch, and no hosted
  // actor ever carried an email for it to compare, so the check never ran.
  it("gives the collaboration actor the address its identity provider claims", () => {
    expect(slice("const resolveCollaborationActor =", "const withHubCredential")).toContain(
      "session.email",
    );
  });

  it("authorizes the directory a browse will actually read", () => {
    expect(slice("[WS_METHODS.filesystemBrowse]:", "[WS_METHODS.subscribeGitStatus]:")).toContain(
      "resolveBrowseListingDirectory",
    );
  });
});
