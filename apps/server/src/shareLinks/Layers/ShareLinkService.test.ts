import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ShareLinkId, TenantId, UserId, WorkspaceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { ShareLinkServiceLive } from "./ShareLinkService.ts";
import { ShareLinkService } from "../Services/ShareLinkService.ts";
import { CollaborationServiceLive } from "../../collaboration/Layers/CollaborationService.ts";
import { CollaborationService } from "../../collaboration/Services/CollaborationService.ts";
import { ServerConfig } from "../../config.ts";
import { ProjectionProjectRepositoryLive } from "../../persistence/Layers/ProjectionProjects.ts";
import { ProjectionProjectRepository } from "../../persistence/Services/ProjectionProjects.ts";
import { ShareLinkRepositoryLive } from "../../persistence/Layers/ShareLinks.ts";
import {
  generateShareLinkToken,
  ShareLinkRepository,
} from "../../persistence/Services/ShareLinks.ts";
import { makeSqlitePersistenceLive } from "../../persistence/Layers/Sqlite.ts";
import { TenancyRepositoryLive } from "../../persistence/Layers/Tenancy.ts";

const tenantId = TenantId.make("tenant-share-links");
const workspaceId = WorkspaceId.make("workspace-share-links");
const scope = { tenantId, workspaceId };
const projectId = ProjectId.make("project-share-links");

const member = { userId: UserId.make("user-member"), displayName: "Member" };
const stranger = { userId: UserId.make("user-stranger"), displayName: "Stranger" };

/**
 * A fresh database and a fresh directory per test. Nothing is written to the
 * workspace, so nobody is a member until they show up — which is how these
 * tests get a stranger for free.
 */
function makeLayer() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-share-links-"));
  return ShareLinkServiceLive.pipe(
    Layer.provideMerge(CollaborationServiceLive),
    Layer.provideMerge(ShareLinkRepositoryLive),
    Layer.provideMerge(ProjectionProjectRepositoryLive),
    Layer.provideMerge(TenancyRepositoryLive),
    Layer.provideMerge(makeSqlitePersistenceLive(path.join(tempDir, "state.sqlite"))),
    Layer.provideMerge(ServerConfig.layerTest(tempDir, tempDir)),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** Presence is enough to be on the roster, which is what membership means here. */
const beVisible = (actor: { userId: UserId; displayName: string }) =>
  Effect.gen(function* () {
    const collaboration = yield* CollaborationService;
    yield* collaboration.upsertPresence(actor, { ...scope, threadId: null, status: "active" });
  });

/**
 * A project with real files on disk, plus a secret next to it that nothing
 * inside the project is ever allowed to reach.
 */
const makeProject = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projects = yield* ProjectionProjectRepository;

  const outsideDir = path.join(config.stateDir, "outside");
  const workspaceRoot = path.join(config.stateDir, "project");
  fs.mkdirSync(path.join(workspaceRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspaceRoot, ".git"), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });

  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "hello from the project");
  fs.writeFileSync(path.join(workspaceRoot, "src", "index.ts"), "export const answer = 42;");
  fs.writeFileSync(path.join(workspaceRoot, ".env"), "API_KEY=super-secret");
  fs.writeFileSync(path.join(workspaceRoot, ".git", "config"), "[remote] url = https://token@x");
  fs.writeFileSync(path.join(outsideDir, "secret.txt"), "not yours");
  // An ordinary-looking name inside the project that is really a way out. No
  // `..`, nothing a lexical check would object to.
  fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(workspaceRoot, "innocent.txt"));

  yield* projects.upsert({
    projectId,
    title: "Share Links",
    workspaceRoot,
    ownership: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  });

  return { workspaceRoot, outsideDir };
});

/** The same project, but belonging to a workspace the caller is not in. */
const ownedElsewhere = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const projects = yield* ProjectionProjectRepository;
  const otherId = ProjectId.make("project-somebody-elses");
  const workspaceRoot = path.join(config.stateDir, "other-project");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, "README.md"), "another workspace's project");

  yield* projects.upsert({
    projectId: otherId,
    title: "Somebody Else's",
    workspaceRoot,
    ownership: {
      tenantId,
      tenantDisplayName: "Tenant",
      workspaceId: WorkspaceId.make("workspace-somebody-elses"),
      workspaceTitle: "Somebody Else's",
      organizationId: null,
      organizationDisplayName: null,
      ownerUserId: null,
      ownerDisplayName: null,
    },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    deletedAt: null,
  });

  return otherId;
});

it.effect("refuses everything to somebody who is not in the workspace", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);

    const minted = yield* shareLinks.create(member, { ...scope, scope: "workspace" });

    for (const refused of [
      yield* shareLinks.create(stranger, { ...scope, scope: "workspace" }).pipe(Effect.flip),
      yield* shareLinks.list(stranger, scope).pipe(Effect.flip),
      yield* shareLinks.revoke(stranger, { ...scope, linkId: minted.link.id }).pipe(Effect.flip),
    ]) {
      assert.strictEqual(refused.code, "forbidden");
    }

    // And the stranger's failed revoke really did leave the link alone.
    const stillLive = yield* shareLinks.redeem({ token: minted.link.token });
    assert.strictEqual(stillLive.kind, "workspace");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("holds every scope to the target it needs, and to no more", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);
    yield* makeProject;

    const invalid = [
      { scope: "file" as const },
      { scope: "file" as const, projectId },
      { scope: "file" as const, filePath: "README.md" },
      { scope: "project" as const },
      { scope: "project" as const, projectId, filePath: "README.md" },
      { scope: "workspace" as const, projectId },
      { scope: "workspace" as const, filePath: "README.md" },
      // A path that could never be served must not become a link that looks
      // minted and fails only in front of whoever it was sent to.
      { scope: "file" as const, projectId, filePath: "../outside/secret.txt" },
      { scope: "file" as const, projectId, filePath: ".env" },
    ];
    for (const input of invalid) {
      const refused = yield* shareLinks.create(member, { ...scope, ...input }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid-target", JSON.stringify(input));
    }

    const file = yield* shareLinks.create(member, {
      ...scope,
      scope: "file",
      projectId,
      filePath: "src/index.ts",
    });
    assert.strictEqual(file.link.scope, "file");
    const project = yield* shareLinks.create(member, { ...scope, scope: "project", projectId });
    assert.strictEqual(project.link.projectId, projectId);
    const workspace = yield* shareLinks.create(member, { ...scope, scope: "workspace" });
    assert.strictEqual(workspace.link.projectId, null);
    assert.strictEqual(workspace.link.filePath, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("hands the token back once, and never again", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);

    const minted = yield* shareLinks.create(member, {
      ...scope,
      scope: "workspace",
      label: "Onboarding",
    });
    assert.isAtLeast(minted.link.token.length, 40);

    // One leaked screenshot of the management panel must not be every link the
    // workspace has ever issued.
    const listed = yield* shareLinks.list(member, scope);
    assert.strictEqual(listed.links.length, 1);
    assert.strictEqual(listed.links[0]?.label, "Onboarding");
    assert.notStrictEqual(listed.links[0]?.token, minted.link.token);

    const revoked = yield* shareLinks.revoke(member, { ...scope, linkId: minted.link.id });
    assert.notStrictEqual(revoked.link.token, minted.link.token);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("reads a revoked link and an expired one as the same dead end", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);

    const revokedLink = yield* shareLinks.create(member, { ...scope, scope: "workspace" });
    const expiredLink = yield* shareLinks.create(member, {
      ...scope,
      scope: "workspace",
      expiresAt: "2020-01-01T00:00:00.000Z",
    });

    const firstRevoke = yield* shareLinks.revoke(member, {
      ...scope,
      linkId: revokedLink.link.id,
    });
    assert.isNotNull(firstRevoke.link.revokedAt);

    // The owner's panel tells the two apart, because the advice differs.
    const again = yield* shareLinks
      .revoke(member, { ...scope, linkId: revokedLink.link.id })
      .pipe(Effect.flip);
    assert.strictEqual(again.code, "revoked");
    const absent = yield* shareLinks
      .revoke(member, { ...scope, linkId: ShareLinkId.make("no-such-link") })
      .pipe(Effect.flip);
    assert.strictEqual(absent.code, "not-found");

    // The visitor is told nothing at all, so a guessed token cannot be
    // confirmed by how it is refused.
    const answers = [
      yield* shareLinks.redeem({ token: revokedLink.link.token }).pipe(Effect.flip),
      yield* shareLinks.redeem({ token: expiredLink.link.token }).pipe(Effect.flip),
      yield* shareLinks.redeem({ token: generateShareLinkToken() }).pipe(Effect.flip),
    ];
    for (const answer of answers) {
      assert.strictEqual(answer.code, "not-found");
      assert.strictEqual(answer.message, answers[0]?.message);
    }
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("refuses every shape of path that leaves the project", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);
    yield* makeProject;

    const projectLink = yield* shareLinks.create(member, { ...scope, scope: "project", projectId });
    const token = projectLink.link.token;

    const escapes = [
      "../outside/secret.txt",
      "src/../../outside/secret.txt",
      "..",
      "../../../../../../etc/passwd",
      "/etc/passwd",
      "/../outside/secret.txt",
      "..\\outside\\secret.txt",
      // A symlink is the one shape no amount of string handling can catch: an
      // ordinary name, no traversal in it, pointing straight out of the tree.
      "innocent.txt",
      // Dot-directories are where a project keeps its credentials.
      ".env",
      ".git/config",
      "./.env",
      "src/../.env",
      // A directory is not a file, and saying so would confirm it exists.
      "src",
      "",
    ];
    for (const escape of escapes) {
      const refused = yield* shareLinks.redeem({ token, path: escape }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "not-found", `served ${escape}`);
    }

    // The path inside the project still works, so the guards are not simply
    // refusing everything.
    const served = yield* shareLinks.redeem({ token, path: "src/index.ts" });
    assert.strictEqual(served.kind, "file");
    assert.strictEqual(
      served.kind === "file" ? Buffer.from(served.contents).toString("utf8") : null,
      "export const answer = 42;",
    );

    // And the listing never mentions what it would refuse to serve.
    const listing = yield* shareLinks.redeem({ token });
    assert.strictEqual(listing.kind, "project");
    const paths = listing.kind === "project" ? listing.entries.map((entry) => entry.path) : [];
    assert.deepStrictEqual(paths, ["README.md", "src/index.ts"]);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("treats a stored file path as untrusted, however it got there", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    const repository = yield* ShareLinkRepository;
    yield* beVisible(member);
    yield* makeProject;

    // Straight past `create`, as an older build or a hand-edited row would be.
    const token = generateShareLinkToken();
    yield* repository.createLink({
      linkId: "smuggled-link",
      token,
      scope: "file",
      tenantId,
      workspaceId,
      projectId,
      filePath: "../outside/secret.txt",
      createdByUserId: member.userId,
      label: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      expiresAt: null,
    });

    const refused = yield* shareLinks.redeem({ token }).pipe(Effect.flip);
    assert.strictEqual(refused.code, "not-found");

    // A file link is not widened into a project link by a query parameter.
    const fileLink = yield* shareLinks.create(member, {
      ...scope,
      scope: "file",
      projectId,
      filePath: "README.md",
    });
    const pinned = yield* shareLinks.redeem({
      token: fileLink.link.token,
      path: "src/index.ts",
    });
    assert.strictEqual(pinned.kind === "file" ? pinned.filePath : null, "README.md");

    // A workspace link grants no files at all, so asking it for one is refused
    // rather than quietly ignored.
    const workspaceLink = yield* shareLinks.create(member, { ...scope, scope: "workspace" });
    const overreach = yield* shareLinks
      .redeem({ token: workspaceLink.link.token, path: "README.md" })
      .pipe(Effect.flip);
    assert.strictEqual(overreach.code, "not-found");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("records a view when something was served, and not when it was refused", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    const repository = yield* ShareLinkRepository;
    yield* beVisible(member);
    yield* makeProject;

    const minted = yield* shareLinks.create(member, {
      ...scope,
      scope: "file",
      projectId,
      filePath: "README.md",
    });

    const probed = yield* shareLinks.create(member, { ...scope, scope: "project", projectId });

    yield* shareLinks.redeem({ token: minted.link.token, viewerFingerprint: "salted-digest" });
    yield* shareLinks.redeem({ token: minted.link.token, viewerFingerprint: "salted-digest" });
    // Refused, so it counts for nothing: anyone holding the URL could otherwise
    // inflate a link's traffic and make the owner's list report visitors who
    // never saw anything.
    yield* shareLinks
      .redeem({ token: probed.link.token, path: "../outside/secret.txt" })
      .pipe(Effect.flip);

    const listed = yield* shareLinks.list(member, scope);
    const served = listed.links.find((link) => link.id === minted.link.id);
    assert.strictEqual(served?.viewCount, 2);
    assert.isNotNull(served?.lastViewedAt);
    const refused = listed.links.find((link) => link.id === probed.link.id);
    assert.strictEqual(refused?.viewCount, 0);
    assert.strictEqual(refused?.lastViewedAt, null);

    const views = yield* repository.listViews({ linkId: minted.link.id, limit: 10 });
    assert.strictEqual(views.length, 2);
    // A salted digest, and no user: a public link is redeemed by nobody in
    // particular, and the address it came from is never written down.
    assert.strictEqual(views[0]?.viewerFingerprint, "salted-digest");
    assert.strictEqual(views[0]?.viewerUserId, null);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("will not share a project belonging to another workspace", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    const projects = yield* ProjectionProjectRepository;
    yield* beVisible(member);
    const project = yield* makeProject;
    const elsewhere = yield* ownedElsewhere;

    // Project ids are global, so being in *some* workspace must not be enough
    // to publish *any* project on the server.
    for (const target of [
      { scope: "project" as const, projectId: elsewhere },
      { scope: "file" as const, projectId: elsewhere, filePath: "README.md" },
      // A project that does not exist gives exactly the same answer, so this
      // cannot be used to find out which ids are real.
      { scope: "project" as const, projectId: ProjectId.make("no-such-project") },
    ]) {
      const refused = yield* shareLinks.create(member, { ...scope, ...target }).pipe(Effect.flip);
      assert.strictEqual(refused.code, "invalid-target");
    }

    // Ownership is re-read on every visit, so a project that moves takes the
    // links already handed out dead with it.
    const minted = yield* shareLinks.create(member, { ...scope, scope: "project", projectId });
    assert.strictEqual((yield* shareLinks.redeem({ token: minted.link.token })).kind, "project");

    yield* projects.upsert({
      projectId,
      title: "Share Links",
      workspaceRoot: project.workspaceRoot,
      ownership: {
        tenantId,
        tenantDisplayName: "Tenant",
        workspaceId: WorkspaceId.make("workspace-somebody-elses"),
        workspaceTitle: "Somebody Else's",
        organizationId: null,
        organizationDisplayName: null,
        ownerUserId: null,
        ownerDisplayName: null,
      },
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      deletedAt: null,
    });

    const stale = yield* shareLinks.redeem({ token: minted.link.token }).pipe(Effect.flip);
    assert.strictEqual(stale.code, "not-found");
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("lists a workspace's links, and narrows to one project on request", () =>
  Effect.gen(function* () {
    const shareLinks = yield* ShareLinkService;
    yield* beVisible(member);
    yield* makeProject;

    yield* shareLinks.create(member, { ...scope, scope: "workspace" });
    yield* shareLinks.create(member, { ...scope, scope: "project", projectId });

    const all = yield* shareLinks.list(member, scope);
    assert.strictEqual(all.links.length, 2);

    const narrowed = yield* shareLinks.list(member, { ...scope, projectId });
    assert.strictEqual(narrowed.links.length, 1);
    assert.strictEqual(narrowed.links[0]?.scope, "project");
  }).pipe(Effect.provide(makeLayer())),
);
