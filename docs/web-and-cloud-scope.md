# Where the web app points, and what the cloud is for

A decision, taken 2026-08-20, after comparing this fork with `pingdotgg/t3code`.

## The two products had drifted

Upstream and this fork share a name and an ancestor and very little else. Upstream has no
`packs`, `collaboration`, `deploy`, `analytics` or `providerAuth` on the server at all; its
identity is Clerk and its web app exists to reach a machine somewhere else through a relay.
This fork has multi-tenancy, collaboration, packs, deploy targets, analytics streams and
per-user provider credentials, and its web app talks to a server you run.

Neither is a version of the other, so "merge upstream" is not a thing that can happen. What
follows is what we take, and what we deliberately do not.

## The web interface pairs with a local environment

The browser connects to the environment on **your own machine**, the way upstream does it.
That is the model, and it is the one being kept.

Why, rather than hosting every user's workspace on our VPS: running everyone's environments
centrally means running everyone's infrastructure — their deployments, their processes, their
ports, their failures — and that is a hosting business wearing a product's clothes. Pairing
puts the machine back where the work already is.

**What this changes:** nothing about how the app connects. Pairing already exists here. What
it changes is that pairing is the *intended* path for the web interface rather than an
accident, so it deserves the same care as any other first-run surface.

## The cloud is for packs and the CLI, and nothing else

The VPS keeps two jobs:

1. **The pack ecosystem** — the registry, publishing, discovery, verification.
2. **The CLI** — `t3 deploy` shipping a project onto our infrastructure when someone asks for
   that, rather than to their own host.

It is explicitly **not** where everyone's workspace lives. A workspace lives on the machine of
the person working in it.

## Prod pairs; beta keeps the hosting

Decided 2026-08-20, on finding that the deployed app does the opposite of the section
above. It is an ordinary server with a login on it, so signing up gives you a workspace
whose `workspace_root` is a path on the VPS — measured, not inferred: the one project on
prod is rooted at `/var/lib/t3code`. Nothing in the code expressed the intent, so nothing
enforced it.

The split:

- **beta** keeps today's behaviour — sign up, and the workspace runs on our box. It stays
  because it works and people can use it now, not because it is the destination.
- **prod** becomes the pairing shell: it holds accounts, environments, share links and
  packs, and the projects live on the machine in front of you.

`workspaceSource` is how a server says which one it is — `this-server` or
`paired-environment` — and the browser stops assuming that a session implies a workspace.
The field is optional and its absence means `this-server`, so every server built before it
existed keeps behaving exactly as it does now.

**The refusal is enforced at the orchestration engine's dispatch, not at the websocket.**
The socket is not the only way in: the CLI dispatches straight into the engine, and server
startup can auto-create a project from its working directory. A rule only the socket knows
about is one `t3 project add` away from being untrue.

**The readiness gate counts saved environments, not live connections.** Connections are
established after the shell mounts, so a liveness test reads zero on every cold load and
would eject someone whose laptop is merely asleep. Whether an environment is reachable is
the workspace's job to display.

What this does **not** yet do, so nobody promises it:

- Neither name resolves. `logicpacks.io` is on Cloudflare nameservers, but the box has no
  `cert.pem`, so named tunnels cannot be minted unattended and both instances are still
  reachable only through disposable `trycloudflare.com` URLs.
- The deployed build predates all of this — and the rename — by four days.
- A `paired-environment` server refuses to create projects, but nothing yet *moves* the
  existing hosted workspaces to beta. That is a data migration, not a flag.

## A machine can be a runner instead of a workspace, added 2026-08-21

`workspaceSource` says what a *server* is for. Nothing said what a **machine** was for, and
two very different things were both showing up as "a machine you connected":

- A **workspace host** — where the agent works. It holds projects, and because per-user
  provider credentials are enforced with no fallback, it is useless until the person has
  connected a Claude or Codex account of their own.
- A **runner** — a box the agent *drives*. It runs and serves things, holds ports, and no
  turn ever executes on it.

Every connected machine looked like the first kind, so connecting a deploy target led to the
same place a new laptop does: connect a provider account before you can do anything. That is
the friction this removes. A runner is never asked, and it is asked *because of what it is*
rather than because of what its owner happens to have connected already — so somebody who has
never touched Claude gets the same silence on a deploy box as somebody with two subscriptions.

What a runner deliberately **cannot** do: it is not a place work happens. It holds no
projects you are expected to open, and it is not offered as somewhere to start a turn. What it
**can** still do is everything its credential could always do — the role is a statement of
purpose, not a permission boundary, and it must never become one. `decideProviderAccount` is
untouched: a turn dispatched from anywhere still resolves a real per-user credential or is
refused. This changes what the product *asks* for, never what a session may reach.

**The role is chosen by the person approving, not claimed by the machine.** A request to join
is not evidence of anything — that is why the approval screen exists at all — and the person
clicking Connect is the one who knows whether the box on the other end is their laptop or
their deploy target. It travels with the approval, is stored on the enrollment row, and is
copied onto the machine at collect. There is nowhere else to keep it: the code is spent
immediately afterwards, and the approve request and the collect request are made minutes apart
by two different parties.

**The absence is interpreted in exactly one place**, `resolveMachineRole`, the same discipline
`resolveWorkspaceSource` established. It resolves `runner` and nothing else to `runner`, so
an absent column, a `null`, and a role invented by a later build all land on `workspace-host`.
The asymmetry is the point: `workspace-host` is what every machine connected before this
existed genuinely is, *and* it is the role that gets asked for a provider account. A value
this build cannot read must never be able to talk the app out of asking.

A machine that reconnects takes the new answer rather than its old one, because a revival is a
fresh approval — a box repurposed from laptop to deploy target has to be able to stop being
asked without being given a new name.

What this does **not** do, so nobody promises it:

- **The role cannot be changed from Settings.** It is shown there, on every row, and changing
  it means disconnecting the machine and connecting it again. That is a real gap and not a
  hard one to close; it is left out because the moment that matters is the approval, and a
  second place to set a role is a second place for the two to disagree.
- **Nothing consumes the role on the machine's own side yet.** `/collect` returns
  `machineRole` so the process that just took a credential knows not to walk its user into
  provider setup, and that is the seam — but the desktop client does not read it yet, so
  today the exemption is visible on the browser that approved and in Settings.
- **A runner is not yet refused a turn**, and deliberately so. The no-fallback rule already
  refuses anything without a credential behind it, and adding a second refusal keyed on the
  role would be a permission check wearing a label's clothes.

## Sharing stays one click, and is not pairing

Upstream hands out a pairing URL and a token. We do not, for the thing a person sends to a
colleague: from the app, sharing a workspace is one action and the recipient gets a link.

These are two different acts and must never be confused in the UI, which is exactly the bug
that prompted this: a share recipient landed on **"Pair with this environment — paste a
pairing token"**, a screen for trusting a *device*, offering a credential they have no way to
obtain. Under `desktop-managed-local` the server advertises `desktop-bootstrap` as the only
bootstrap method, so there is no token that page could ever accept from them.

- **Pairing** is for *your own* browser reaching *your own* environment.
- **A share link** is for *somebody else* reaching *your* workspace, and must carry its own
  way in — a public link, or one scoped to named people who sign in or sign up.

## What we take from upstream, and what we do not

**Take** — self-contained UI, adapted rather than copied wholesale:

- The connect/pair surface's *shape*: an auth shell with eyebrow, title and a sentence that
  says what is about to happen, instead of a bare "Paste token" field.
- Copy-to-clipboard affordances on codes and URLs.
- The usage-insights redesign, thread action menus, workspace navigation, `AnimatedHeight`,
  `ConnectionStatusDot`, the colour selector.

**Do not take:**

- **Clerk.** Identity here is Supabase, local password and desktop bootstrap, and per-user
  provider credentials hang off it. Swapping identity means re-hanging all of that.
- **The relay/cloud environment model**, for now. It is a better answer than a Cloudflare
  quick tunnel whose URL dies with the laptop, and it is worth revisiting — but it is their
  connectivity architecture, not a component.
- **The mobile app.** 682 files built against upstream's auth, contracts and navigation.
  Porting it is a project with its own plan, not a wave in someone else's.

## What the multi-user flow actually does, measured

Run `node scripts/collab-multiuser-e2e.mjs` against a dev server. Latest: **72 of 72**, with
three skips (no agent-vs-person marker, python-written files unattributed, no
conflict-resolve control).

Do not edit the tree while this suite runs. A verification pass scored 61/71 purely because
vite hot-reloaded the app mid-run; the failures looked like a collapsed branch phase and
were an artefact of the edit, not a regression.

Working, each verified with three real accounts in separate browser contexts: invite links;
a second person joining with no shared cookies; a third joining on a session that already has
an account; a file written into the folder by python being picked up; per-file author marks
that name the author rather than the viewer; three people each drawn in their own colour; an
admin changing somebody else's colour and everyone seeing it; read-only demotion actually
refusing a send server-side; a branch per person; and an admin merging one from the panel —
including reporting the conflict rather than pretending it merged.

Two entries previously listed here as broken were **the suite misreading the app**, not the
app misbehaving. Both are corrected rather than deleted, because "we tested it and it
failed" is the kind of claim that gets repeated:

- **Two people in one file** is noticed, and always was. A file carrying a change this
  browser has not reviewed opens in **diff review**, not the editor — so the harness, which
  waited only for Monaco, reported that the editor never rendered. It now takes the
  "Edit file contents" offer first. That is also why the same file passed for one person
  and failed for the next: the first met a clean file, the second met an incoming change.
- **An agent's file write is attributed** correctly. The touch row was in the database
  during the failing runs, with the acting user on it. Since the workspace redesign three
  separate lists are drawn from file names — the explorer, "Changes", and a turn's
  "Changed files" — and only the explorer carries authorship; the suite read whichever
  matched first. Explorer rows now have a `data-testid="workspace-entry"` handle and the
  suite reads that.

The lesson worth keeping: a UI test that identifies elements by their text will start
reporting product bugs the moment a redesign adds a second list of the same names.

And one that is absent by design rather than broken:

- Authorship is claimed by the browser that saved a file, so a file written outside the app
  can never carry one. The python file from the setup phase is in the tree, on disk, and
  belongs to nobody, and the suite still says so rather than inventing an author.

## Presence per file, added 2026-08-20

The other entry that used to sit above — "nothing distinguishes a person from an agent
working on a file" — is now built, because the advice genuinely differs. Two people in one
file is an ordinary collision and the answer is a branch each. An agent writing a file a
person has open is not a collision: an agent replaces a file rather than merging into it, so
the open buffer loses, and that one is worth interrupting somebody for.

It is a **second** concept beside the file-touch marks, not an extension of them, because the
two have opposite lifetimes:

- A **touch** is history. It says who last changed a file, it never expires, and that is
  right — a mark that vanished would be a worse answer to "who wrote this".
- **Presence** is a live claim with a deadline. A browser page says which files it has open
  and re-says it every fifteen seconds; a turn's claim is filed by the reactor that runs it
  and given up when the turn stops being the session's active one. Anything past its deadline
  is swept on every read and every write, and the browser applies the same deadline again as
  it draws. Nothing sweeps on a timer, so there is no window in which a stale claim can be
  observed — "somebody is editing this" left standing forever would be worse than never
  having shown it.

The rules live in one pure function, `packages/shared/src/filePresence.ts`, shared by the
server and the browser rather than written twice. The counting is deliberately asymmetric:
people are counted per account, so one person with two tabs open is one person, and agents
are counted per thread, so one person running two turns into one file is two writers racing.
A person and their *own* agent in one file is still the urgent case — it is the commonest way
somebody loses unsaved work.

What it changes, in three places:

- **The file row** carries a presence icon distinct from the author dot — a pencil for a
  person, a bot for a turn, and only the urgent combination animates. The dot means history,
  the icon means now, and they must not be mistakable for each other at the glance this is
  for.
- **The contention section** now gives each file its own sentence instead of one shared
  footnote, because a branch is the answer to two people and no answer at all to an agent:
  the turn runs in the same worktree the file is open in either way.
- **Turn start** records a warning naming the files somebody has open, on the dispatch path,
  which is the last moment the loss is preventable. It warns and never refuses — a workspace
  where a colleague's open editor could block everybody's turns would be a worse product.

What it deliberately does **not** claim: which files a turn is about to write. Nothing knows
that before the turn runs — the file list only exists once a diff does — so the pre-turn
warning names the real risk (somebody has unsaved work in this workspace) rather than
dressing a guess up as a prediction.

The e2e suite's probe for this used to look for selectors nothing ever rendered and report
"no such marker exists". It now reads the real marker, and an empty result skips with the
accurate reason — that nobody was holding a file at the instant it looked — rather than the
one that stopped being true.
