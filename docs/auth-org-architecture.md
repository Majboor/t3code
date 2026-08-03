# Auth and Organization Architecture

T3 Code uses the existing Node backend as the source of truth for local auth,
organizations, memberships, invites, scoped grants, provider accounts, and shared
agent infrastructure.

- `apps/server` owns HTTP auth routes, WebSocket auth, organization RPCs, and
  SQLite persistence.
- Chat threads, provider sessions, checkpoint metadata, files, terminals, and
  Codex app-server runtime state remain in the same Node/SQLite backend.
- `apps/web` talks only to the Node backend for app flows.
- The auth/org implementation should stay adapter-shaped so Supabase can replace
  the local Node persistence later without changing the React app.

Local development:

```sh
T3CODE_LOCAL_PASSWORD_AUTH=true bun run dev
```

Required checks before completion:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```
