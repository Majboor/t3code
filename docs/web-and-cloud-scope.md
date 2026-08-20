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

And two that are absent by design rather than broken:

- Nothing distinguishes *a person* from *an agent* working on a file. The model records that a
  file was touched, not who or what is touching it now.
- Authorship is claimed by the browser that saved a file, so a file written outside the app
  can never carry one.

Those last two are the gap behind "see if two people are working on it or an agent is" — it
needs a presence-per-file concept that does not exist yet. That is a feature, not a fix.
