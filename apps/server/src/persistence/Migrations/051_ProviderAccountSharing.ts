import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Provider account sharing: who has connected what, who lends it out, and who
 * is allowed to borrow.
 *
 * The load-bearing table here is `provider_account_index`, and it exists
 * because the filesystem cannot answer the one question the admin panel is
 * built around: "which accounts exist in this workspace?". Credentials live
 * under `<stateDir>/provider-auth/<slug>/…`, where the slug is a SHA-256
 * digest of the user id. A digest is one-way — walking that directory yields a
 * set of hashes that can be *tested* against a user id but never *mapped back*
 * to one. Enumerating a roster from disk would mean hashing every user in the
 * tenant and probing for a directory, which is O(members) stat calls for a
 * panel that renders on every open, and still cannot see the per-account
 * subdirectories' labels. So the index is a deliberate duplicate of what disk
 * already knows, kept only so a roster is a single query.
 *
 * It holds no credential material and never will — an account id, a
 * human-chosen label and two timestamps. The token stays on disk.
 *
 * The other three tables are the decisions layered on top of that index:
 * a contributor's per-workspace opt-in (`provider_account_shares`), the
 * workspace-wide default and the account it names (`provider_workspace_policy`),
 * and the per-member override an admin sets (`provider_member_grants`).
 * They are kept apart rather than folded into one settings blob because they
 * have three different owners — the contributor owns the share, the admin owns
 * the policy and the grants — and a single row would let one of them overwrite
 * another's decision on write.
 *
 * There is no index statement below, which is intentional rather than an
 * omission. Every read this feature performs is a leftmost prefix of a
 * composite PRIMARY KEY, and SQLite builds an implicit unique index over those
 * columns for each of these tables:
 *
 *   - `provider_account_index` PK (user_id, …) serves `listAccountsForUser`
 *     and the `user_id IN (…)` roster scan in `listAccountsForUsers`; the full
 *     key serves `touchAccountUsed`, `removeAccount`, and wave 2's
 *     "is the policy's named account still connected" probe.
 *   - `provider_account_shares` PK (tenant_id, workspace_id, …) serves
 *     `listSharesForWorkspace`, and its three-column prefix `listSharesForUser`.
 *   - `provider_workspace_policy` PK (tenant_id, workspace_id, …) serves
 *     `listPoliciesForWorkspace`.
 *   - `provider_member_grants` PK (tenant_id, workspace_id, …) serves
 *     `listGrantsForWorkspace`, and the full key serves `getGrant`.
 *
 * A secondary index on any of those column sets would be a byte-for-byte copy
 * of the primary key's index: more write amplification on every share toggle,
 * no read ever faster. Add one when a read appears that starts somewhere other
 * than a key's first column — a "which workspaces am I lending into" view
 * starting at `owner_user_id` is the likely first.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per connected credential. A user may connect several accounts per
  // provider, so the account id is part of the key rather than the whole of it.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_account_index (
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      -- Null for the legacy single-account layout, which was connected before
      -- labels existed and whose account id is the literal "default". The
      -- service substitutes a display name; storing one here would invent a
      -- name the user never typed.
      label TEXT,
      created_at TEXT NOT NULL,
      -- Null until the account has actually run a turn. Purely informational:
      -- it lets the panel show a stale contributor account without having to
      -- guess from the credential file's mtime, which a token refresh moves.
      last_used_at TEXT,
      PRIMARY KEY (user_id, provider, account_id)
    )
  `;

  // A contributor's opt-in, scoped to one workspace. One row per
  // (owner, provider): a user lends at most one account per provider into a
  // given workspace, so `account_id` is a column and not part of the key —
  // switching which account is lent must update the existing row, never leave
  // the previous one behind still enabled.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_account_shares (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      account_id TEXT NOT NULL,
      -- 0/1. A row with enabled = 0 is kept rather than deleted so the panel can
      -- show "shared, currently off" and so re-enabling restores the same
      -- account instead of asking the owner to pick again.
      enabled INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, owner_user_id, provider)
    )
  `;

  // The workspace default, set by an admin.
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_workspace_policy (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      -- "own" | "shared".
      mode TEXT NOT NULL,
      -- The account the workspace runs on under mode "shared". Both null under
      -- mode "own". Held as a plain (owner, account) pair with no foreign key:
      -- the referenced share can be switched off or the account disconnected at
      -- any moment, and the decision function is required to re-check both at
      -- launch anyway. A cascade here would silently erase the admin's choice
      -- on a contributor's temporary toggle.
      shared_owner_user_id TEXT,
      shared_account_id TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, provider)
    )
  `;

  // An admin's per-member override of the policy. Absence is meaningful: no row
  // means "follow the policy", which is why this is not defaulted to "own".
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_member_grants (
      tenant_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      -- "own" | "workspace".
      access TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, workspace_id, user_id, provider)
    )
  `;
});
