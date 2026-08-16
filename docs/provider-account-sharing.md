# Handover: sharing provider accounts across a workspace

Continue in `/Users/hico/Desktop/waleed_codes/p36/t3code`, branch **`prod`**.

## The job

Today a turn runs on the credential of whoever sent the message, and refuses if that person
has not connected one. That is the right floor, but it means everyone needs their own
subscription. This feature lets a workspace share.

Seven things were asked for:

1. In the **Collaborators tab**, select people and grant each one permission to use **their
   own** Claude/Codex or **the workspace owner's**.
2. In the **collab panel**, contribute your own account — "Contribute my Claude" is only
   offered if Claude is actually connected on your account.
3. If you have **several accounts** for a provider, choose which one you are contributing.
4. See **whether you are currently sharing**.
5. Turn your sharing **on and off per project/workspace**, not just globally.
6. A **workspace admin** picks whose subscription the workspace runs on.
7. A workspace admin can **see every Claude/Codex account connected in the workspace**, in the
   collab panel.

## What already exists — verified, do not rebuild

### The connect flow (built and deployed as of this handover)

- **`apps/server/src/providerAuth/store.ts`** — the only place that answers "which directory
  belongs to this user". Layout: `<stateDir>/provider-auth/<slug>/codex/auth.json` and
  `<slug>/claude/oauth-token` (0600). `<slug>` is a readable prefix plus a SHA-256 suffix, so a
  user id containing a slash cannot escape into another user's directory.
- **`apps/server/src/providerAuth/http.ts`** — `/api/provider-auth/{start,code,connections,logout,prompt}`,
  each scoped to the caller via `authenticateHttpRequest` + `resolveAuthenticatedUserId`.
- **`apps/web/src/components/settings/ProviderAccountsSection.tsx`** — two buttons at
  `/settings/connections`. No thread, no terminal.
- **`ProviderCommandReactor.ts:342`** `resolveConnectedLaunchEnvironment` — the enforcement
  point. `:328` resolves the acting user (the author of the message that started the turn,
  falling back to the newest attributed message). `:365` is the refusal.

### The sharing vocabulary — exists, but is **not wired to anything**

This is the most important thing to know before designing. A previous effort modelled all of
this and none of it runs:

- `packages/contracts/src/tenancy.ts:379` — `ProviderAccountSharing = "private" | "tenant-shared"`.
- `packages/contracts/src/tenancy.ts:385` — `ProviderAccount` with `owner`
  (`user` | `tenant` | `organization`), `sharing`, and per-account directories.
- `packages/shared/src/tenancy.ts:862` — `evaluateProviderAccountAccess`, a complete decision
  function for whether a session may use an account.
- `packages/contracts/src/tenancy.ts:67-69` — permissions `provider.use`, `provider.connect`,
  `provider.manage` already exist and are already assigned to roles.

**The trap:** all of it hangs off `ProviderSessionIsolation` records that nothing on this
deployment creates. Production has provider-account rows but no live provider sessions, which
is why `resolveProviderLaunchEnvironment` falls through to the store path on every turn. Read
this machinery for its vocabulary and its access rules. Do not assume calling it will work.

## The four real gaps

**1. One account per user per provider.** The store's paths have no room for a second. Every
signature is `(stateDir, userId, provider)` — see `store.ts:55,78,84,104,117,128,153`. Multiple
accounts means an account id in the path and something that lists them. This is the change that
touches the most code; do it first, because requirement 3 and requirement 7 both depend on it.

**2. No sharing at all in the live path.** `providerCredentialEnv` resolves the acting user's
own credential and returns null otherwise. Sharing turns this into a policy question: *given
this user, this project, and this provider, which account should answer?*

**3. Sharing is tenant-wide, scoping is per project.** `ProviderAccountSharing` has exactly two
values and no project dimension. Requirement 5 needs per-project state.

**4. Nothing lists accounts across a workspace.** Requirement 7 needs a roster, which the
per-user directory layout cannot produce without an index.

## Decide these before writing code

**Where does truth live — the store, or the dormant tenancy model?**
Recommendation: **keep the store as the source of truth** and borrow the tenancy vocabulary
(`owner`, `sharing`, the three permissions). Wiring the tenancy path means standing up provider
sessions, tenant runtimes and the per-tenant Linux user that
`packages/shared/src/tenancy.ts` describes and that has never run. That is a much larger job
than this feature and would swallow it.

**Precedence.** Write this down before implementing, because every ambiguous case here is
somebody's bill. Suggested order, strictest first:

1. A contributor's **off** switch always wins. It is their account and their money.
2. Otherwise, the **admin's workspace choice**, if the named account is still shared.
3. Otherwise, the user's **own** account.
4. Otherwise refuse — and the refusal must now say *"connect your own, or ask an admin to share
   one"*, not the current text at `ProviderCommandReactor.ts:365`.

**Revocation timing.** Decide whether flipping sharing off kills turns already running on that
credential or only stops new ones. Stopping new ones is simpler and almost certainly what
people expect; say so in the UI either way.

## Traps

1. **`claude setup-token` returns no identity.** There is no account name, email, or id in the
   output — only the token. Requirement 3 ("select which account") therefore has nothing to
   label Claude accounts *with*. Codex is fine: `auth.json` in `CODEX_HOME` carries an email.
   Options are to let the person name the account themselves at connect time, or to derive a
   label by running a prompt against it. **Verify which is possible before promising a picker.**
2. **`claude auth status` lies about `setup-token`** — it reads a shared credential file that
   `setup-token` never writes and reports `loggedIn: false` about a working login. Never use it
   to decide whether an account exists; ask the store.
3. **Enforcement is no-fallback.** A policy lookup that returns nothing does not degrade — it
   blocks the turn. A bug in the resolution function takes the whole workspace out. Give it
   tests before giving it a UI.
4. **The single-credential assumption is baked into the test harnesses.** Both seed exactly one
   account per provider: `ProviderCommandReactor.test.ts` (`seedProviderCredentials`,
   `HARNESS_USER_ID`) and `integration/OrchestrationEngineHarness.integration.ts`
   (`INTEGRATION_USER_ID`). Changing the store layout breaks both; they are the fastest way to
   know your change is coherent.
5. **`CLAUDE_CODE_OAUTH_TOKEN` is on the denied list** in `PROVIDER_LAUNCH_DENIED_ENV_KEYS`
   (`packages/shared/src/tenancy.ts`) so the server's own environment cannot stand in for a
   user's. Keep it there — a shared-credential feature makes leaking the machine's login *more*
   confusing to debug, not less.
6. **The collab panel is a popover, not a tab.** `CollaborationPresenceBar.tsx:216-230`
   composes `CollaborationPeople` and `CollaborationGovernancePanel` inside a
   `PopoverPopup` about 22rem wide. An account roster and a per-person permission matrix will
   not fit there comfortably; plan for a dialog or a settings page and leave the panel showing
   status plus a way in.
7. **Do not echo tokens.** `http.ts` redacts `sk-ant-…` before anything leaves the server
   because an earlier version published a year-long credential to a public page. A roster that
   lists accounts must show labels and never material.

## Two questions for the product owner, not for the code

- **Provider terms.** Running a workspace on one person's Claude or ChatGPT subscription may
  breach the provider's terms of service. This feature makes that easy and default-looking. Get
  a decision before building the admin control in requirement 6, because the answer may change
  it from "pick whose subscription" to "pick from accounts explicitly contributed for team use".
- **Blast radius.** A shared credential lets user B run arbitrary agent turns billed to user A,
  and `ProviderSandboxMode` (`read-only` | `workspace-write` | `danger-full-access`) is declared
  in contracts but **never read** in `apps/server/src` — `full-access` maps to Claude's
  `bypassPermissions`. Signup on this deployment is open. Sharing credentials before sandboxing
  exists means a stranger who signs up can spend someone else's subscription running unsandboxed
  agents. Sequence the sandbox work first, or gate sharing behind invite-only signup.

## Verification

A status is not evidence; a prompt is. For any account you believe is usable:

```sh
CODEX_HOME=<that user's codex home> codex exec --skip-git-repo-check -o /tmp/r.txt "Reply with exactly: OK" && cat /tmp/r.txt
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… claude -p "Reply with exactly: OK"
```

`OK` means the credential is real. For the sharing logic itself, the cheap high-value test is
the resolution function in isolation: user with no account + admin sharing on → runs; same user
after the contributor toggles off → refuses; contributor's own turn → always their own account.

## Where things stand

The connect flow described above is complete, typechecks, and its tests pass. It was **not yet
deployed to prod at the time of writing** — the full suite was still running. Prod details, the
deploy loop, and the box's gotchas are in `docs/deployment.md` and the prior provider-login
handover; the short version is `164.68.117.31`, `/srv/t3code`, `t3code-prod.service`, and never
`pkill -f turbo` on that machine.
