# AGENTS.md

## Task Completion Requirements

- All of `bun fmt`, `bun lint`, and `bun typecheck` must pass before considering tasks completed.
- NEVER run `bun test`. Always use `bun run test` (runs Vitest).
- `bun run test:collab` drives two real accounts through the collaboration flow in a
  browser: sharing a workspace by invite, seeing each other's file changes live,
  prompt approval, personal branches, and conflict warnings. It needs a server
  already running (`bun run dev` with `T3CODE_LOCAL_PASSWORD_AUTH=true`) and a
  configured provider, so it is not part of the default gate. Run it when you touch
  workspace files, collaboration, or auth.
- `T3_DEPLOY_SSH_HOST=<host> bun run test:pack-deploy` builds a Flask/Jinja2 app in a
  real workspace, registers it as a deploy target through the `t3 deploy` CLI, deploys
  it over SSH and checks every page it serves. Needs key-based SSH to the host: a
  `command` target never receives the password secret, and the deploy pack refuses to
  put one on a command line. `deploy run` tars the directory it is called from.
- `bun run test:analytics` is the quick one: a project, a declared stream, events posted with
  nothing but an ingest key, and the chart a person sees. No agent and no remote host, so it
  needs no credentials.
- `bun run test:pdf-pack` renders a PDF, deploys it, has the
  deployment report how far a reader got, and asks which page held them longest. Runs locally,
  because a deployment must be able to reach the analytics endpoint and a remote host cannot
  reach a loopback address here.
- `T3_E2E_SKIP_AGENT=1` drops the phases that need a model, which is how CI runs it
  without any provider credentials. It also reports the branch comparison and the
  conflict warning as SKIP. That is not because they need a turn — a probe with two
  fresh accounts, no turns and no approvals had B create a branch and the comparison
  render fine. Something specific to the agent-off path breaks it, and until that is
  understood the suite says what it does not know rather than failing a feature that
  works everywhere else.

## Project Snapshot

T3 Code is a minimal web GUI for using coding agents like Codex and Claude.

This repository is a VERY EARLY WIP. Proposing sweeping changes that improve long-term maintainability is encouraged.

## Core Priorities

1. Performance first.
2. Reliability first.
3. Keep behavior predictable under load and during failures (session restarts, reconnects, partial streams).

If a tradeoff is required, choose correctness and robustness over short-term convenience.

## Maintainability

Long term maintainability is a core priority. If you add new functionality, first check if there is shared logic that can be extracted to a separate module. Duplicate logic across multiple files is a code smell and should be avoided. Don't be afraid to change existing code. Don't take shortcuts by just adding local logic to solve a problem.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and web. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.

## Codex App Server (Important)

T3 Code is currently Codex-first. The server starts `codex app-server` (JSON-RPC over stdio) per provider session, then streams structured events to the browser through WebSocket push messages.

How we use it in this codebase:

- Session startup/resume and turn lifecycle are brokered in `apps/server/src/codexAppServerManager.ts`.
- Provider dispatch and thread event logging are coordinated in `apps/server/src/providerManager.ts`.
- WebSocket server routes NativeApi methods in `apps/server/src/wsServer.ts`.
- Web app consumes orchestration domain events via WebSocket push on channel `orchestration.domainEvent` (provider runtime activity is projected into orchestration events server-side).

Docs:

- Codex App Server docs: https://developers.openai.com/codex/sdk/#app-server

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex
- Codex-Monitor (Tauri, feature-complete, strong reference implementation): https://github.com/Dimillian/CodexMonitor

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.
