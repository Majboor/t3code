# @t3tools/sdk

Typed client for driving a T3 Code server from scripts and automation:
create workspaces, invite collaborators, inspect projects, prompt agents,
and run deploys.

## Connecting

```ts
import { connect } from "@t3tools/sdk";

const t3 = await connect({
  baseUrl: "http://127.0.0.1:13773",
  credentials: { kind: "password", email: "you@example.com", password: "..." },
});

try {
  console.log(await t3.getSessionState());
} finally {
  await t3.close();
}
```

Supported credentials:

| Kind           | Use it for                                                                |
| -------------- | ------------------------------------------------------------------------- |
| `password`     | An existing local-password account.                                       |
| `signup`       | Creating a local-password account (auto-provisions a personal workspace). |
| `pairingToken` | A one-time token from `t3 auth pairing create`.                           |
| `bearer`       | A Supabase access token, or a session token you already hold.             |

## Workspaces and collaborators

```ts
const workspaces = await t3.listWorkspaces();

const { workspace } = await t3.createWorkspace({
  tenantId: workspaces[0]!.tenantId,
  title: "Payments pack",
});

const invite = await t3.inviteToWorkspace({
  tenantId: workspace.tenantId,
  workspaceId: workspace.id,
  email: "teammate@example.com",
  roles: ["developer"],
});
console.log(invite.acceptUrlPath);
```

## Projects and agents

```ts
const projects = await t3.listProjects();
await t3.promptAgent({ threadId, prompt: "Add a health check endpoint" });
```

## Deploys

```ts
const target = await t3.createDeployTarget({
  projectId,
  name: "Production",
  command: "git pull && docker compose up -d --build",
  ssh: { host: "203.0.113.10", user: "root", remotePath: "/srv/app" },
});

const run = await t3.runDeploy(target.id);
console.log(run.status, run.output);
```

SSH passwords are never passed to the SDK. Store them in the server secret
store and reference them with `ssh.passwordSecretName`.

## Notes

- Always `close()` the client; the websocket otherwise keeps the process alive.
- Every call is permission-checked server-side against the session's tenant
  memberships, so a scripted client can only reach its own workspaces.
