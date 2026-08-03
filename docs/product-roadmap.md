# Product Roadmap

This document is the current product-facing milestone plan for T3 Code.

## Product direction

T3 Code should move toward a provider model with one primary core LLM and
multiple optional user-connected agents.

Current direction:

- The default core LLM should be an OpenAI-compatible endpoint configured by the
  operator.
- The current reference setup is a proxy-backed deployment that exposes a
  `gpt-5.4` model through an OpenAI-compatible API surface.
- Codex and Claude should remain first-class provider brands in the UI, but
  their login/account flows can be stubbed until the real onboarding path is
  ready.
- Sensitive values such as API keys, passwords, and remote server credentials
  must stay in local operator config and never be committed into the repo.

## Milestone 1: Core LLM foundation

Goal: make the OpenAI-compatible core LLM the default app path.

- [ ] Add a first-class "core LLM" configuration concept in shared contracts.
- [ ] Distinguish core model routing from provider-specific CLI session routing.
- [ ] Support base URL, model slug, and auth token settings for the core LLM.
- [ ] Add server-side validation for OpenAI-compatible core LLM config.
- [ ] Add a startup health check for the configured core LLM.
- [ ] Add a real smoke test against `POST /chat/completions`, not only `/models`.
- [ ] Surface core LLM health/status in settings and startup UX.
- [ ] Add fallback/error messaging when the configured core LLM is unavailable.

## Milestone 2: Provider login stubs

Goal: show Codex and Claude as connectable providers without requiring the full
final auth UX yet.

- [ ] Add explicit provider cards for Codex and Claude in settings/onboarding.
- [ ] Mark both providers as "stubbed" or "coming next" when full login flow is unavailable.
- [ ] Add placeholder actions for "Connect Codex" and "Connect Claude".
- [ ] Define the contract shape for provider login state: disconnected, checking, connected, error, stubbed.
- [ ] Keep manual CLI-based login support documented for local/dev use.
- [ ] Ensure stub flows do not pretend success or create fake durable sessions.
- [ ] Add analytics/event hooks for future provider onboarding completion.

## Milestone 3: Provider account integration

Goal: replace stubs with real account detection and connection flows.

- [ ] Detect existing Codex CLI auth state.
- [ ] Detect existing Claude CLI auth state.
- [ ] Add refresh/recheck actions for provider status.
- [ ] Add server endpoints/services for provider account status discovery.
- [ ] Add import/sync flow for operator-managed Codex auth where applicable.
- [ ] Add provider-specific error states for expired auth, missing binary, and invalid config.
- [ ] Allow users to choose which connected provider to use for a thread/session.

## Milestone 4: Chat and thread UX polish

Goal: finish the obvious product gaps in the core interaction flow.

- [ ] Submitting new messages should scroll to bottom.
- [ ] Only show the last 10 threads for a given project in compact views.
- [ ] New projects should appear at the top.
- [ ] Projects should sort by latest thread update.
- [ ] Add message queueing so sends are predictable under load and reconnects.
- [ ] Make provider/core-model selection obvious on first send.
- [ ] Show clearer loading, disconnected, retrying, and degraded states.

## Milestone 5: Workspace and review flow

Goal: make the current workspace/diff investment feel complete.

- [ ] Finish live workspace diff review ergonomics.
- [ ] Tighten acceptance/rejection flow for agent-generated file changes.
- [ ] Improve multi-file review navigation and keyboard flow.
- [ ] Add better empty states for no project, no thread, and no diff cases.
- [ ] Make thread-to-workspace context switching feel stable during running turns.

## Milestone 6: Auth, organizations, and collaboration

Goal: complete the current in-flight multi-tenant/auth work.

- [ ] Centralize route auth behind `ServerAuth`.
- [ ] Finish bootstrap vs session credential split.
- [ ] Add browser session cookie flow.
- [ ] Add non-loopback-safe auth defaults.
- [ ] Finish org, tenant, membership, and invite flows.
- [ ] Add collaboration presence and shared workspace state.
- [ ] Add organization admin UX that matches the actual permission model.

## Milestone 7: Reliability and edge-case cleanup

Goal: burn down known correctness and platform issues before broader rollout.

- [ ] Resolve the remaining PR89 remediation checklist items.
- [ ] Fix provider runtime event routing race conditions.
- [ ] Fix UTF-8 chunk decoding edge cases in transport/text generation code.
- [ ] Fix shell PATH recovery edge cases, including fish/login-shell behavior.
- [ ] Fix remaining sidebar/localStorage/resizable state footguns.
- [ ] Fix concurrency issues in persistence/session directory updates.

## Milestone 8: GitHub planning hygiene

Goal: keep roadmap work visible and actionable.

- [ ] Create GitHub milestones that mirror the milestone sections in this file.
- [ ] Break each milestone into small tracked issues/checklist items.
- [ ] Label work by area: `core-llm`, `provider-auth`, `workspace`, `auth`, `collaboration`, `reliability`, `ux`.
- [ ] Track which items are stub-only, production-ready, or blocked by infrastructure.
- [ ] Keep this doc and the GitHub milestone state in sync.
