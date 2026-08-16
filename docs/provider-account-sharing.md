# Handover: sharing provider accounts across a workspace

Continue in `/Users/hico/Desktop/waleed_codes/p36/t3code`, branch **`prod`**.
Anchors below were re-verified against the tree on 2026-08-16.

## The job

A turn runs on the credential of whoever sent the message, and is refused if that person has
not connected one. That floor is now live on prod, and it means everybody needs their own
subscription. This feature lets a workspace share instead.

Seven things were asked for:

1. In the **Collaborators tab**, select people and grant each one permission to use **their own**
   Claude/Codex or **the workspace owner's**.
2. In the **collab panel**, contribute your own account — "Contribute my Claude" only offered if
   Claude is actually connected on your account.
3. If you have **several accounts** for a provider, choose which one you contribute.
4. See **whether you are currently sharing**.
5. Turn your sharing **on and off per project/workspace**, not just globally.
6. A **workspace admin** picks whose subscription the workspace runs on.
7. A workspace admin can **see every Claude/Codex account connected in the workspace**, from the
   collab panel.

## Status: built, tested, NOT yet deployed

All seven requirements are implemented on branch `prod` and not yet pushed or deployed. The
monorepo typechecks (10/10 packages), `apps/web` is 1213 tests green, the feature's own server
tests are 87 green, and the orchestration integration suite runs the new migration for real.

Read the two open product questions at the end of this file **before deploying**. Neither is a
code problem and neither was resolved by building this.

### Where each requirement lives

| # | What was asked | Where it is |
|---|---|---|
| 1 | Per-person "their own" vs "the workspace's" | `ProviderSharingDialog.tsx`, member list → `providerSharing.member.update` |
| 2 | Contribute my Claude, only if connected | `ProviderSharingSection.tsx` in the collab popover; the server only ever returns genuinely connected accounts in `viewerAccounts` |
| 3 | Pick which of several accounts | Account picker in the popover (shown only with >1 account); accounts are created at `/settings/connections` |
| 4 | See whether you are sharing | Per-provider status line and switch in the popover |
| 5 | Per project/workspace on/off | Every sharing call is keyed `{tenantId, workspaceId}`; the UI names the workspace in the caption, each status line and the switch's aria-label |
| 6 | Admin picks whose subscription | `ProviderSharingDialog.tsx` policy section → `providerSharing.policy.update` |
| 7 | See every account in the workspace | Roster in the dialog, from `provider_account_index` restricted to workspace members |

### The shape of it

- **Storage** — `apps/server/src/providerAuth/store.ts`. Multiple accounts per user per provider at
  `<slug>/<provider>/accounts/<accountId>/`. Legacy single-account users are adopted **read-only**
  as the account id `default`: nothing is moved, and the `default` account still writes to the
  legacy path, so a re-login cannot fork into two files that disagree.
- **Index and policy** — migration `051_ProviderAccountSharing.ts`, four tables, served by
  `persistence/{Services,Layers}/ProviderSharing.ts`. The index exists because the directory slugs
  are SHA-256 digests: nothing on disk can enumerate "every account in this workspace".
- **The decision** — `providerAuth/decideProviderAccount.ts`, pure and IO-free, 14 tests. The
  precedence is: a contributor's off switch wins; then the member's grant, defaulting to the
  workspace policy; then their own account; then a refusal that offers both routes out.
- **Resolution and enforcement** — `providerAuth/resolveProviderAccount.ts` gathers the inputs and
  `ProviderCommandReactor.ts` calls it where the old hardcoded refusal was. A shared account runs
  with the **owner's** `HOME`/`CODEX_HOME`/token.
- **RPC** — `providerSharing.{overview.get,share.update,policy.update,member.update}`, implemented
  in `providerSharing/Layers/ProviderSharingService.ts`, handled in `ws.ts`, reaching the browser
  through `packages/sdk/src/api/providerSharing.ts` and `apps/web/src/rpc/wsRpcClient.ts`.
- **Connect flow** — `providerAuth/http.ts` gained `POST /api/provider-auth/account` and account
  ids on `start`/`code`/`logout`/`prompt`, and reconciles the index on every call so it cannot
  drift from disk.

### Known limitations, in the order they will annoy someone

1. **An account can be emptied but not deleted.** `newAccount: true` creates the account before the
   browser sign-in happens, so an abandoned sign-in leaves a permanent "Not connected" row with no
   way to remove it. Needs a `removeAccount` route.
2. **A grant cannot be cleared back to "follow the workspace default".** `member.update` takes only
   `own | workspace`, so once an admin touches a person the tri-state is one-way. Needs a nullable
   `access` or a delete.
3. **A failed read of the sharing tables falls back to the sender's own account** rather than
   refusing, and it swallows defects as well as typed failures. That is the right trade for
   availability — a transient DB fault would otherwise stop every turn in every workspace — but it
   means a member relying on a shared account is silently refused instead, and the only trace is a
   logged warning. Narrow it to typed failures when someone has time.
4. **Revocation stops new turns only.** A turn already running keeps the credential until it
   finishes. The UI says so; the server does not enforce anything stronger.
5. **`/prompt` returns text with no verdict**, so "Test" shows a reply and leaves the judgement to
   the reader. `lastUsedAt` is recorded but never surfaced, so the panel cannot answer "which of
   these am I actually spending on".
6. **Claude accounts still carry no identity.** `setup-token` returns only a token, so the label is
   whatever the person types, falling back to a positional name. Codex derives an email.

## Traps

1. **`claude setup-token` returns no identity** — no name, email or id, only the token. Requirement
   3 has nothing to label Claude accounts with. Either let the person name the account at connect
   time, or derive a label by running a prompt against it. **Verify which is possible before
   promising a picker.** Codex is fine: `auth.json` in `CODEX_HOME` carries an email.
2. **`claude auth status` lies about `setup-token`** — it reads a shared credential file that
   `setup-token` never writes, and reports `loggedIn: false` about a working login. Ask the store.
3. **Enforcement is no-fallback.** A policy lookup that returns nothing does not degrade, it
   blocks the turn. A bug in the resolution function takes the whole workspace out. Tests first.
4. **The single-credential assumption is baked into the harnesses.** `ProviderCommandReactor.test.ts`
   (`seedProviderCredentials`, `HARNESS_USER_ID`) and
   `integration/OrchestrationEngineHarness.integration.ts` (`INTEGRATION_USER_ID`) each seed
   exactly one account per provider. Changing the store layout breaks both — they are the fastest
   way to know the change is coherent.
5. **`CLAUDE_CODE_OAUTH_TOKEN` stays on the denied list** in `PROVIDER_LAUNCH_DENIED_ENV_KEYS`
   (`packages/shared/src/tenancy.ts:1341`). A sharing feature makes a leaked machine login *harder*
   to debug, not easier.
6. **The collab panel is a popover, not a tab.** `CollaborationPresenceBar.tsx:195-225` composes
   `CollaborationPeople` and `CollaborationGovernancePanel` inside a `PopoverPopup`
   `w-[min(22rem,calc(100vw-2rem))]` (`:199`). A roster and a per-person permission matrix will not
   fit. Plan a dialog or a settings page; leave the popover showing status, the contribute toggle,
   and a way in.
7. **Never echo tokens.** `http.ts` redacts `sk-ant-…` before anything leaves the server, because
   an earlier version published a year-long credential to a public page. A roster shows labels and
   never material.

## Two questions for the product owner, not for the code

- **Provider terms.** Running a workspace on one person's Claude or ChatGPT subscription may
  breach the provider's terms. This feature makes that easy and default-looking. Get a decision
  before building requirement 6 — the answer may turn it from "pick whose subscription" into "pick
  from accounts explicitly contributed for team use".
- **Blast radius.** A shared credential lets user B run arbitrary agent turns billed to user A,
  and `ProviderSandboxMode` (`read-only` | `workspace-write` | `danger-full-access`) is declared in
  contracts but **never read** in `apps/server/src` — `full-access` maps to Claude's
  `bypassPermissions`. Signup on this deployment is open. Sharing before sandboxing exists means a
  stranger who signs up can spend someone else's subscription running unsandboxed agents. Sequence
  the sandbox work first, or gate sharing behind invite-only signup.

## Verification

What is proven by tests: the decision function's precedence in isolation (14 cases, including a
withdrawn share and an admin naming an account nobody contributed), the store's legacy adoption
(the regression that would lock out every existing prod user), the index staying true across
connect/rename/default/logout, the reactor running a granted member on the owner's `HOME` and
refusing when the owner switches off, and that no response body anywhere contains `sk-ant`.

What is **not** proven: any of it against a real provider. A status is not evidence; a prompt is.
For any account believed usable:

```sh
CODEX_HOME=<that user's codex home> codex exec --skip-git-repo-check -o /tmp/r.txt "Reply with exactly: OK" && cat /tmp/r.txt
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-… claude -p "Reply with exactly: OK"
```

`OK` means the credential is real. The Claude end-to-end path is **still never confirmed green** —
it needs a real browser sign-in, so no session so far has been able to verify it. Codex was
verified end to end before this work. Confirm a shared Claude account actually runs a turn before
telling anybody the feature works.

Prod details and the deploy loop are in `docs/deployment.md`; the short version is `164.68.117.31`,
`/srv/t3code`, `t3code-prod.service`, and never `pkill -f turbo` on that machine.
