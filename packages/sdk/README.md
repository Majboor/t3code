# @t3tools/sdk

Typed client for driving a T3 Code server from scripts and automation.
Everything the web app can do over the websocket is reachable here.

## Connecting

```ts
import { connect } from "@t3tools/sdk";

const t3 = await connect({
  baseUrl: "http://127.0.0.1:13773",
  token: process.env.T3_TOKEN,
});

try {
  console.log(await t3.getSessionState());
} finally {
  await t3.close();
}
```

`token` is shorthand for `credentials: { kind: "bearer", token }`. Pass
`credentials` instead to log in:

| Kind           | Use it for                                                                |
| -------------- | ------------------------------------------------------------------------- |
| `password`     | An existing local-password account.                                       |
| `signup`       | Creating a local-password account (auto-provisions a personal workspace). |
| `pairingToken` | A one-time token from `t3 auth pairing create`.                           |
| `bearer`       | A Supabase access token, or a session token you already hold.             |

## The grouped API

| Group           | What lives there                                                        |
| --------------- | ----------------------------------------------------------------------- |
| `workspace`     | Workspaces, project registration, directory listing, file read/write.   |
| `threads`       | Reading threads, starting turns, interrupting, answering approvals.     |
| `history`       | Shared prompts, workspace activity, turn and thread diffs.              |
| `changes`       | Status, working-tree diffs, branches, worktrees, merges, pull requests. |
| `collaboration` | Presence, invites, members, approvals, settings, branch claims.         |
| `organizations` | Employees, teams, departments, access grants, audit trail.              |
| `deploys`       | Deploy targets and runs.                                                |
| `terminals`     | Server-side shell sessions.                                             |
| `providers`     | Agent provider accounts.                                                |
| `server`        | Server config, settings, keybindings, lifecycle subscriptions.          |

Every method takes the contract's own input type, so the shapes match the ones
the server validates.

## Projects and files

```ts
const projectId = await t3.workspace.registerProject({
  workspaceRoot: "/srv/app",
  title: "Payments",
});

const { entries } = await t3.workspace.listDirectory({ cwd: "/srv/app" });
const file = await t3.workspace.readFile({ cwd: "/srv/app", relativePath: "README.md" });
await t3.workspace.writeFile({
  cwd: "/srv/app",
  relativePath: "README.md",
  contents: `${file.contents}\n`,
});
```

## Threads

```ts
const threads = await t3.threads.list();
const { messageId } = await t3.threads.startTurn({
  threadId: threads[0]!.id,
  prompt: "Add a health check endpoint",
});

const stop = t3.threads.watch(threads[0]!.id, (event) => {
  if (event.kind === "event") {
    console.log(event.event.type);
  }
});

await t3.threads.interruptTurn({ threadId: threads[0]!.id });
stop();
```

Turns started while a workspace reviews prompts must clear the gate first:

```ts
const gate = await t3.collaboration.submitApproval({ tenantId, workspaceId, threadId, prompt });
if (gate.mayRun) {
  await t3.threads.startTurn({ threadId, prompt });
}
```

## Changes

```ts
const status = await t3.changes.status({ cwd: "/srv/app" });
const merge = await t3.changes.mergeBranch({ cwd: "/srv/app", branch: "feature" });
if (merge.status === "conflicts") {
  await t3.changes.abortMerge({ cwd: "/srv/app" });
}

await t3.changes.runStackedAction(
  { actionId: crypto.randomUUID(), cwd: "/srv/app", action: "commit_push_pr" },
  { onProgress: (event) => console.log(event.kind) },
);
```

## Collaborators

```ts
const invite = await t3.collaboration.createInvite({
  tenantId,
  workspaceId,
  email: "teammate@example.com",
  scope: "workspace",
  roles: ["developer"],
  expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
});
console.log(invite.acceptUrlPath);
```

## Deploys

```ts
const { target } = await t3.deploys.createTarget({
  projectId,
  name: "Production",
  kind: "ssh",
  command: "git pull && docker compose up -d --build",
  ssh: { host: "203.0.113.10", user: "root", remotePath: "/srv/app" },
});

const { run } = await t3.deploys.run({ targetId: target.id });
console.log(run.status, run.output);
```

SSH passwords are never passed to the SDK. Store them in the server secret
store and reference them with `ssh.passwordSecretName`.

## Notes

- Always `close()` the client; the websocket otherwise keeps the process alive.
- Every call is permission-checked server-side against the session's tenant
  memberships, so a scripted client can only reach its own workspaces.
- `watch*` methods return an unsubscribe function and do not reconnect on their
  own; a long-lived script should reconnect when the socket drops.
