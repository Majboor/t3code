# TODO

This file is the short operational backlog. For the broader milestone plan, see
`docs/product-roadmap.md`.

## Core LLM and providers

- [ ] Make the OpenAI-compatible core LLM the default model/runtime path
- [x] Expose Codex and Claude provider connect flows in settings
- [ ] Add real core-LLM smoke test coverage against `/chat/completions`

## Collaboration and deployment

- [x] Auto-provision a personal tenant and workspace on first login
- [x] Scope workspaces, projects, and sessions to tenant memberships
- [x] Workspace invites with roles, acceptance, and presence
- [x] Merge/rebase with conflict reporting on diverged branches
- [x] Deploy targets (local command and SSH) with recorded runs
- [x] `@t3tools/sdk` for scripting workspaces, agents, and deploys
- [ ] Share workspace diff review state across collaborators
- [ ] Sandbox agent processes per workspace (ProviderSandboxMode is unused)
- [ ] Add `workspaces.list`/`update`/`archive` RPCs

## Chat and thread polish

- [ ] Submitting new messages should scroll to bottom
- [ ] Only show last 10 threads for a given project
- [x] Thread archiving
- [ ] New projects should go on top
- [ ] Projects should be sorted by latest thread update
- [ ] Queueing messages

## Planning hygiene

- [ ] Mirror the roadmap in GitHub milestones
- [ ] Add checklist-style issues for each milestone
