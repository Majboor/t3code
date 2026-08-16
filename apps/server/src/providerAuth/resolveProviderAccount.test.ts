import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Layer, Option } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { PersistenceSqlError } from "../persistence/Errors.ts";
import {
  ProviderSharingRepository,
  type ProviderAccountShareRecord,
  type ProviderMemberGrantRecord,
  type ProviderWorkspacePolicyRecord,
} from "../persistence/Services/ProviderSharing.ts";
import { resolveProviderAccount } from "./resolveProviderAccount.ts";
import { codexHomeFor, providerAuthUserDir, type ProviderAuthProvider } from "./store.ts";

const TENANT_ID = "tenant-1";
const WORKSPACE_ID = "workspace-1";
const OWNER_ID = "user-owner";
const MEMBER_ID = "user-member";

const stateDirs = new Set<string>();

afterEach(() => {
  for (const stateDir of stateDirs) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  stateDirs.clear();
});

function makeStateDir(): string {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-resolve-provider-"));
  stateDirs.add(stateDir);
  return stateDir;
}

/** The single-account layout every already-connected user is in. */
function connect(stateDir: string, userId: string, provider: ProviderAuthProvider): void {
  if (provider === "codex") {
    const home = codexHomeFor(stateDir, userId);
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ email: `${userId}@example` }));
    return;
  }
  const claudeDir = path.join(providerAuthUserDir(stateDir, userId), "claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(path.join(claudeDir, "oauth-token"), `sk-ant-${userId}`);
}

const UPDATED_AT = "2026-01-01T00:00:00.000Z";

/** An owner lending an account into the workspace. Enabled unless said otherwise. */
function shareRow(
  input: {
    readonly ownerUserId?: string;
    readonly provider?: string;
    readonly enabled?: boolean;
  } = {},
): ProviderAccountShareRecord {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    ownerUserId: input.ownerUserId ?? OWNER_ID,
    provider: input.provider ?? "codex",
    accountId: "default",
    enabled: input.enabled ?? true,
    updatedAt: UPDATED_AT,
  };
}

/** The workspace running on somebody's account rather than each member's own. */
function sharedPolicyRow(
  input: { readonly sharedOwnerUserId?: string; readonly provider?: string } = {},
): ProviderWorkspacePolicyRecord {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    provider: input.provider ?? "codex",
    mode: "shared",
    sharedOwnerUserId: input.sharedOwnerUserId ?? OWNER_ID,
    sharedAccountId: "default",
    updatedAt: UPDATED_AT,
  };
}

/** An admin's decision about one member. */
function grantRow(
  input: { readonly access?: string; readonly provider?: string } = {},
): ProviderMemberGrantRecord {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    userId: MEMBER_ID,
    provider: input.provider ?? "codex",
    access: input.access ?? "workspace",
    updatedAt: UPDATED_AT,
  };
}

interface StubOptions {
  readonly shares?: ReadonlyArray<ProviderAccountShareRecord>;
  readonly policies?: ReadonlyArray<ProviderWorkspacePolicyRecord>;
  readonly grants?: ReadonlyArray<ProviderMemberGrantRecord>;
  readonly failReads?: boolean;
}

function makeRepositoryStub(options: StubOptions = {}) {
  const touched: Array<{ userId: string; provider: string; accountId: string }> = [];
  const fail = <A>() =>
    Effect.fail(
      new PersistenceSqlError({ operation: "stub", detail: "sharing tables unavailable" }),
    ) as Effect.Effect<A, PersistenceSqlError>;

  const shares = options.shares ?? [];
  const policies = options.policies ?? [];
  const grants = options.grants ?? [];

  const layer = Layer.mock(ProviderSharingRepository, {
    listSharesForWorkspace: () => (options.failReads ? fail() : Effect.succeed(shares)),
    listPoliciesForWorkspace: () => (options.failReads ? fail() : Effect.succeed(policies)),
    getGrant: (input) => {
      if (options.failReads) {
        return fail();
      }
      const grant = grants.find(
        (entry) => entry.userId === input.userId && entry.provider === input.provider,
      );
      return Effect.succeed(grant === undefined ? Option.none() : Option.some(grant));
    },
    touchAccountUsed: (input) =>
      Effect.sync(() => {
        touched.push({
          userId: input.userId,
          provider: input.provider,
          accountId: input.accountId,
        });
      }),
  });

  return { layer, touched };
}

function resolve(
  input: {
    readonly stateDir: string;
    readonly userId: string;
    readonly provider?: ProviderAuthProvider;
    readonly tenantId?: string | null;
    readonly workspaceId?: string | null;
  },
  stub: ReturnType<typeof makeRepositoryStub>,
) {
  return Effect.runPromise(
    resolveProviderAccount({
      stateDir: input.stateDir,
      userId: input.userId,
      tenantId: input.tenantId === undefined ? TENANT_ID : input.tenantId,
      workspaceId: input.workspaceId === undefined ? WORKSPACE_ID : input.workspaceId,
      provider: input.provider ?? "codex",
      providerLabel: (input.provider ?? "codex") === "codex" ? "Codex" : "Claude",
    }).pipe(Effect.provide(stub.layer)),
  );
}

describe("resolveProviderAccount", () => {
  it("runs a connected user on their own account when nothing is shared", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, MEMBER_ID, "codex");
    const stub = makeRepositoryStub();

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({
      outcome: "launch",
      ownerUserId: MEMBER_ID,
      accountId: "default",
      source: "own",
    });
    expect(resolved.outcome === "launch" && resolved.env).toMatchObject({
      HOME: providerAuthUserDir(stateDir, MEMBER_ID),
      CODEX_HOME: codexHomeFor(stateDir, MEMBER_ID),
    });
  });

  it("runs on the user's own account when the turn belongs to no workspace", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, MEMBER_ID, "codex");
    const stub = makeRepositoryStub();

    const resolved = await resolve(
      { stateDir, userId: MEMBER_ID, tenantId: null, workspaceId: null },
      stub,
    );

    expect(resolved).toMatchObject({ outcome: "launch", ownerUserId: MEMBER_ID, source: "own" });
  });

  it("runs a granted member on the owner's credential, with the owner's home", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, OWNER_ID, "codex");
    const stub = makeRepositoryStub({
      shares: [shareRow()],
      policies: [sharedPolicyRow()],
      grants: [grantRow()],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({
      outcome: "launch",
      ownerUserId: OWNER_ID,
      accountId: "default",
      source: "workspace",
    });
    expect(resolved.outcome === "launch" && resolved.env).toMatchObject({
      HOME: providerAuthUserDir(stateDir, OWNER_ID),
      CODEX_HOME: codexHomeFor(stateDir, OWNER_ID),
    });
    expect(stub.touched).toEqual([{ userId: OWNER_ID, provider: "codex", accountId: "default" }]);
  });

  it("refuses a granted member once the owner withdraws the share", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, OWNER_ID, "codex");
    const stub = makeRepositoryStub({
      shares: [shareRow({ enabled: false })],
      policies: [sharedPolicyRow()],
      grants: [grantRow()],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({ outcome: "refused" });
    expect(resolved.outcome === "refused" && resolved.refusal).toContain("no longer shared");
    expect(stub.touched).toEqual([]);
  });

  it("falls back to the member's own account when the shared one has gone", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, MEMBER_ID, "codex");
    // The owner's share row survives their logout; their disk does not.
    const stub = makeRepositoryStub({
      shares: [shareRow()],
      policies: [sharedPolicyRow()],
      grants: [grantRow()],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({ outcome: "launch", ownerUserId: MEMBER_ID, source: "own" });
  });

  it("offers both routes when no account answers anywhere", async () => {
    const stateDir = makeStateDir();
    const stub = makeRepositoryStub();

    const resolved = await resolve({ stateDir, userId: MEMBER_ID, provider: "claude" }, stub);

    expect(resolved).toMatchObject({ outcome: "refused" });
    expect(resolved.outcome === "refused" && resolved.refusal).toBe(
      "No Claude account is connected for you. Connect one in Settings → Connections, or ask a workspace admin to share one.",
    );
  });

  it("keeps a connected user working when the sharing tables cannot be read", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, MEMBER_ID, "codex");
    const stub = makeRepositoryStub({ failReads: true });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({ outcome: "launch", ownerUserId: MEMBER_ID, source: "own" });
  });

  it("never lends an account the workspace policy did not name", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, OWNER_ID, "codex");
    const stub = makeRepositoryStub({
      // A colleague contributes, but the workspace runs on somebody else.
      shares: [shareRow()],
      policies: [sharedPolicyRow({ sharedOwnerUserId: "user-nobody" })],
      grants: [grantRow()],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({ outcome: "refused" });
    expect(stub.touched).toEqual([]);
  });

  it("keeps a member on their own account when their grant says own", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, OWNER_ID, "codex");
    connect(stateDir, MEMBER_ID, "codex");
    const stub = makeRepositoryStub({
      shares: [shareRow()],
      policies: [sharedPolicyRow()],
      grants: [grantRow({ access: "own" })],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID }, stub);

    expect(resolved).toMatchObject({ outcome: "launch", ownerUserId: MEMBER_ID, source: "own" });
    expect(stub.touched).toEqual([{ userId: MEMBER_ID, provider: "codex", accountId: "default" }]);
  });

  it("ignores a share for a different provider", async () => {
    const stateDir = makeStateDir();
    connect(stateDir, OWNER_ID, "codex");
    const stub = makeRepositoryStub({
      shares: [shareRow({ provider: "codex" })],
      policies: [sharedPolicyRow({ provider: "codex" })],
      grants: [grantRow({ provider: "codex" })],
    });

    const resolved = await resolve({ stateDir, userId: MEMBER_ID, provider: "claude" }, stub);

    expect(resolved).toMatchObject({ outcome: "refused" });
  });
});
