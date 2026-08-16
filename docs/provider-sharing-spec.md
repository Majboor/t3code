# Spec: provider account sharing — the contract every wave implements against

**Status: implemented.** Everything below is built and tested; this file is now the reference for
what the pieces agreed to be, not a plan. Where the code deviated, it is noted inline. What
shipped, what is still missing, and what remains undecided: `docs/provider-account-sharing.md`.

Background and traps: `docs/provider-account-sharing.md`.

## Vocabulary

- **account** — one connected provider credential belonging to one user. A user may have several
  per provider. Identified by `accountId`, unique per `(userId, provider)`.
- **contribute / share** — the account's owner allows a workspace to run turns on it.
- **grant** — an admin decision that a given member uses `own` or `workspace` credentials.
- **policy** — the workspace-wide default and which account the workspace runs on.

## Storage layout (owned by wave 1 / store)

```
<stateDir>/provider-auth/<slug>/
  codex/auth.json                      <- LEGACY, account id "default", still read, never moved
  claude/oauth-token                   <- LEGACY, account id "default", still read, never moved
  codex/meta.json                      <- { defaultAccountId, accounts: [{id,label,createdAt}] }
  codex/accounts/<accountId>/auth.json
  claude/accounts/<accountId>/oauth-token
```

Legacy adoption is **read-only and non-destructive**: when `accountId === "default"` and the new
path does not exist, read the legacy path. Enforcement is no-fallback on prod — a botched move
locks every already-connected user out of turns.

## Database (owned by wave 1 / persistence) — migration `051_ProviderAccountSharing.ts`

```sql
provider_account_index(user_id, provider, account_id, label, created_at, last_used_at,
                       PRIMARY KEY (user_id, provider, account_id))
provider_account_shares(tenant_id, workspace_id, owner_user_id, provider, account_id,
                        enabled INTEGER NOT NULL, updated_at,
                        PRIMARY KEY (tenant_id, workspace_id, owner_user_id, provider))
provider_workspace_policy(tenant_id, workspace_id, provider, mode, shared_owner_user_id,
                          shared_account_id, updated_at,
                          PRIMARY KEY (tenant_id, workspace_id, provider))
provider_member_grants(tenant_id, workspace_id, user_id, provider, access, updated_at,
                       PRIMARY KEY (tenant_id, workspace_id, user_id, provider))
```

`mode` is `own` | `shared`. `access` is `own` | `workspace`. The index exists because slugs are
SHA-256 digests and cannot be mapped back to user ids — it is the only thing that can enumerate
accounts for a roster.

## Contracts (owned by wave 1 / contracts) — `packages/contracts/src/providerSharing.ts`

```ts
ProviderAuthKind = Schema.Literals(["codex", "claude"])          // matches the store's providers
ProviderAccessMode = Schema.Literals(["own", "workspace"])       // per-member grant
ProviderPolicyMode = Schema.Literals(["own", "shared"])          // workspace default

ProviderConnectedAccount { accountId, provider, label, createdAt, isDefault }
ProviderAccountShare     { tenantId, workspaceId, ownerUserId, provider, accountId, enabled, updatedAt }
ProviderWorkspacePolicy  { tenantId, workspaceId, provider, mode, sharedOwnerUserId|null,
                           sharedAccountId|null, updatedAt }
ProviderMemberGrant      { tenantId, workspaceId, userId, provider, access, updatedAt }

// One roster row per connected account in the workspace. Admin-only.
ProviderWorkspaceAccount { userId, displayName, provider, accountId, label, createdAt,
                           isShared, isWorkspaceDefault }
```

RPC methods, added to `WS_METHODS` in `packages/contracts/src/rpc.ts`:

| method | input | result | who |
|---|---|---|---|
| `providerSharing.overview.get` | `{tenantId, workspaceId}` | `ProviderSharingOverviewResult` | any member |
| `providerSharing.share.update` | `{tenantId, workspaceId, provider, accountId, enabled}` | `{share}` | the owner, for themselves only |
| `providerSharing.policy.update` | `{tenantId, workspaceId, provider, mode, sharedOwnerUserId?, sharedAccountId?}` | `{policy}` | admin |
| `providerSharing.member.update` | `{tenantId, workspaceId, userId, provider, access}` | `{grant}` | admin |

`ProviderSharingOverviewResult` is one read that powers the whole panel:

```ts
{
  viewerUserId,
  canManage: boolean,                                   // may set policy and grants
  viewerAccounts: ProviderConnectedAccount[],           // requirements 2, 3
  viewerShares: ProviderAccountShare[],                 // requirement 4
  viewerGrants: ProviderMemberGrant[],                  // what applies to me
  policies: ProviderWorkspacePolicy[],                  // requirement 6
  grants: ProviderMemberGrant[],                        // requirement 1, admin only, else []
  workspaceAccounts: ProviderWorkspaceAccount[],        // requirement 7, admin only, else []
}
```

Never put credential material in any of these. Labels only.

## The decision function (owned by wave 2)

`apps/server/src/providerAuth/decideProviderAccount.ts` — pure, no IO, unit-tested first:

```ts
decideProviderAccount(input: {
  userId, provider,
  ownAccounts: ProviderConnectedAccount[],      // the acting user's own
  grant: { access } | null,                     // this member's grant, if any
  policy: { mode, sharedOwnerUserId, sharedAccountId } | null,
  sharedAccounts: Array<{ ownerUserId, accountId, enabled, connected }>,
}): { ownerUserId, accountId } | { refusal: string }
```

Precedence, strictest first:

1. A contributor's **off** switch always wins — a share with `enabled === false` is invisible.
2. Effective access = `grant?.access ?? (policy?.mode === "shared" ? "workspace" : "own")`.
3. `workspace` → the policy's named account, only if still shared and still connected.
4. Otherwise the acting user's **own default account**.
5. Otherwise refuse. The message must offer both routes: *"No Claude account is connected for you.
   Connect one in Settings → Connections, or ask a workspace admin to share one."*

A workspace-access member whose shared account has gone falls back to their own if they have one,
and refuses otherwise. Revocation stops **new** turns only; turns already running keep their
credential. Say so in the UI.

## Wiring point

`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:342`
`resolveConnectedLaunchEnvironment` currently has `actingUserId` and `ServerConfig` only. Tenant
and workspace come from the project that owns the cwd — the same lookup used at `:400`
(`readModel.projects.find(...)?.ownership`). The web derives workspace the same way
(`CollaborationPresenceBar.tsx:65`): `ownership?.workspaceId ?? WorkspaceId.make(projectId)`. Use
that fallback so a project with no explicit workspace still resolves.

Environment for a shared account is the **owner's**: `HOME` = owner's provider-auth dir,
`CODEX_HOME` = owner's account dir, or `CLAUDE_CODE_OAUTH_TOKEN` = owner's token. Keep
`filterProviderLaunchBaseEnv` in front of it.

## House rules

- Effect v4 (`effect/unstable/sql/SqlClient`), `.ts` extensions on relative imports, `bun --bun`.
- Comments explain *why*, never *what*; match the density of the file you are editing.
- Tests colocated (`*.test.ts`), run with `bun --bun vitest run <path>`.
- `bun --bun turbo run typecheck` must pass for the package you touched.
- Never log or return token material; `http.ts` already redacts `sk-ant-…` and that must hold.
