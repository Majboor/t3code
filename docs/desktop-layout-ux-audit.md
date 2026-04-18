# Desktop layout UX audit

This document records the current desktop shell problems discovered while reviewing the `vibe` / `dev` layout work on top of the workspace/editor stack.

It is intentionally a no-code audit. The goal is to capture the actual blockers before more UI patching lands.

## Context

The current stack added:

- project categories and drag/drop organization
- the in-app workspace/editor
- live diff review UI
- `vibe` / `dev` desktop layout modes
- Projects rail collapse/reopen controls
- a `projects.toggle` keybinding path

User review exposed that the desktop shell still feels under-specified and structurally brittle.

## Desired product targets

### Ideal Vibe

- Projects anchored on the left
- Chat as the primary centered surface
- Header compact and readable
- Workspace opened intentionally rather than dominating by default

### Ideal Dev

- workspace/files surfaced as the default working surface when available
- Projects easy to reveal and dismiss
- Shell still feels spatially coherent and easy to recover

## Main findings

### 1. The desktop shell is split across two independent sidebar systems

Relevant files:

- `apps/web/src/components/AppSidebarLayout.tsx`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`
- `apps/web/src/components/ui/sidebar.tsx`

The current shell is made from:

- a global Projects rail owned by `AppSidebarLayout`
- a thread-local workspace/diff rail owned by `_chat.$environmentId.$threadId`

Both are built from the same fixed-position sidebar primitive. Each provider reserves its own width and each rail decides its own open/closed state.

That means the desktop shell is not really one shell. It is the composition of multiple fixed rails that happen to share styling.

#### Consequences

- rail combinations can crowd or visually compete with chat
- mode switching feels like flipping side/order flags rather than entering a coherent shell
- viewport shrink after rails are open can leave the shell in invalid states

### 2. Mode switching is a settings flip, not a mode transition

Relevant files:

- `apps/web/src/components/ChatView.tsx`
- `apps/web/src/components/AppSidebarLayout.logic.ts`
- `apps/web/src/routes/_chat.$environmentId.$threadId.tsx`

`onDesktopLayoutModeChange` in `ChatView.tsx` currently just updates `desktopLayoutMode` in settings.

The Projects rail open state is stored per mode in `AppSidebarLayout.logic.ts`, which is useful, but that is not enough to define the product behavior of `vibe` and `dev`.

The user expectation is stronger than that:

- switching into `dev` should surface the workspace/files view automatically when a workspace exists
- switching into `vibe` should return to a chat-first shell

Right now the mode switch mostly preserves whatever happened to be open before, which is why `dev` does not reliably feel like a dev-first view.

### 3. Projects controls are fragmented and spatially confusing

Relevant files:

- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/AppSidebarLayout.tsx`
- `apps/web/src/components/WorkspacePanel.tsx`
- `apps/web/src/components/NoActiveThreadState.tsx`
- `packages/contracts/src/keybindings.ts`

The Projects rail can currently be controlled through:

- the global `SidebarTrigger` in the header
- the floating `project-sidebar-reopen` affordance
- the overflow menu
- the `projects.toggle` keybinding
- other sidebar triggers in secondary surfaces

This is not one interaction model.

In `dev`, the user can click a control on the far left and toggle a Projects rail on the far right. That weakens spatial mapping and makes the shell harder to read.

The floating reopen affordance improves recovery, but it is still a patch over a missing clear primary affordance.

### 4. The header has no stable priority model

Relevant files:

- `apps/web/src/components/chat/ChatHeader.tsx`
- `apps/web/src/components/ChatView.browser.tsx`

The desktop header is trying to carry:

- Projects access
- `Vibe / Dev`
- project actions
- editor/open controls
- git actions
- panel toggles
- overflow access

That has already produced regressions where the primary `Vibe / Dev` control disappeared from the visible header.

There is no explicit hierarchy that says which controls must remain primary and which should fall into overflow.

### 5. The tests currently validate workarounds more than the real UX

Relevant file:

- `apps/web/src/components/ChatView.browser.tsx`

The current tests are useful, but they mostly prove the existence of the patched mechanisms:

- per-mode Projects open-state persistence
- floating reopen affordance
- overflow reachability
- Projects toggle distinct from workspace toggle

A good example of the mismatch: `switchDesktopLayoutMode(...)` in the browser tests still drives the overflow menu path instead of the primary visible `Vibe / Dev` control.

That means the suite is not yet protecting the actual interaction users are relying on.

## Linked remediation issues

- [ ] #8 Refactor the desktop shell so Projects and Workspace rails stop competing
- [ ] #10 Define mode-specific default views for Vibe and Dev
- [ ] #9 Redesign Projects sidebar controls and affordances across Vibe and Dev
- [ ] #11 Rebuild desktop header priorities and responsive behavior
- [ ] #12 Replace workaround-driven desktop layout tests with real shell regression coverage

## Recommendation

Do not keep layering local affordances onto the current shell until the model is clarified.

The next implementation pass should start from:

1. one explicit desktop shell model
2. explicit mode-entry behavior for `vibe` and `dev`
3. one clear Projects interaction model
4. a defined header priority/overflow strategy
5. regression coverage that follows the real visible controls and resize flows
