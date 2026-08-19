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
