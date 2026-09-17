# cloudflare-deploy

What this does, what was tried, and what is left undone. The handover is
required because a pack nobody can describe is a zip file with metadata.

## What it does

Deploys a project through T3's two native Cloudflare deploy target kinds —
`cloudflare-tunnel` and `cloudflare-pages` — added to the platform alongside
the existing `command`/`ssh` kinds in this same change. Where `ssh-deploy`'s
`local` mode tells the agent to hand-roll a `cloudflared tunnel --url`
invocation, poll a log file itself, and pass `--url` on `t3 deploy run`, a
`cloudflare-tunnel` target does that inside T3 itself: the deploy command only
has to background `cloudflared` redirected into the path T3 hands it in
`$T3_TUNNEL_LOG_PATH`, and `t3 deploy run` reads the resulting
`*.trycloudflare.com` address back out and registers it as the deployment's
URL without the agent doing any polling or `--url` bookkeeping.

`cloudflare-pages` deploys a static build directory to a named Cloudflare
Pages project using the OAuth-backed Cloudflare connection under Settings →
Connections, rather than any personally-held API token: `cloudflareCreatePagesProject`
and `cloudflareDeployPages` on `ExternalIntegrations` do the work, so the
account deployed to is whichever one the person connected, not one chosen by
the agent.

Both kinds show up on the project's Infrastructure page exactly like a
`command`/`ssh` deployment does, because they go through the same
`DeploymentRegistry.register` call the other two kinds already use — this pack
does not add a second, parallel way of telling T3 something is live.

## What was tried and rejected

**Reusing `ssh-deploy`'s hand-rolled tunnel prompt instead of a new schema
field.** That already works, but it makes every project reproduce the same
"nohup, redirect, poll, pass --url" ritual by hand in its own deploy command,
and none of that effort is visible to T3 as a *kind* of target — a
`cloudflare-tunnel` target can be listed, filtered and reasoned about as what
it is, the same way an `ssh` target's host and user are structured data rather
than words inside a shell string.

**Requiring a named (persistent) Cloudflare tunnel.** A named tunnel needs a
Cloudflare account, a zone, and a one-time `cloudflared tunnel create` +
DNS-record step before it can be used at all — real setup a first deploy
should not be blocked on. A quick tunnel needs nothing pre-existing and prints
a working address in seconds, at the cost of that address changing on every
restart. This pack is quick-tunnel only; a named-tunnel kind is future work
(see below).

**Deploying Pages by shelling out to `wrangler`.** `wrangler pages deploy`
needs its own API-token-shaped auth, which is exactly the kind of credential
the OAuth work in this same change was built to avoid re-introducing.
`cloudflareDeployPages` uses the connected account's OAuth token instead,
resolved server-side, never handed to the deploy command as an environment
variable the way `DEPLOY_SSH_PASSWORD` is for `ssh-deploy`.

## What was verified, and how

- **`cloudflare-tunnel`, end to end, three real runs.** A `command`-kind
  target backgrounding a `python3 -m http.server` alone confirmed the generic
  "background a process and return" contract other kinds already rely on
  (returns in ~1s once stdin is also redirected — see failure mode below). A
  `cloudflare-tunnel` target backgrounding both that server and
  `cloudflared tunnel --url` redirected into `$T3_TUNNEL_LOG_PATH` was run
  three times: the first hit a transient `cloudflared`-side timeout
  requesting its quick tunnel; the second surfaced a real bug (a stale,
  previous-run failure line matching the URL pattern and getting registered
  as the deployment's address instead of the real tunnel URL, fixed by
  excluding `api.trycloudflare.com` from the pattern and truncating the log
  file at the start of every run); the third, after that fix, again hit the
  same transient `cloudflared` timeout, took 2m21s to return, and surfaced the
  open failure mode below.
- **`cloudflare-pages` — not yet run against a live Cloudflare account.**
  `cloudflareCreatePagesProject`/`cloudflareDeployPages` are real, existing,
  previously-tested methods on `ExternalIntegrations`, and the schema/CLI/
  Infrastructure-page wiring for the `cloudflare-pages` target kind is
  complete and typechecks, following the exact `ssh`/`cloudflareTunnel`
  pattern. What has not been done: a live deploy against a real, connected
  Cloudflare account, because doing so needs a human to complete the OAuth
  consent flow in a browser first (see the platform-level report this pack
  ships alongside) — an agent cannot click through that, and this pack does
  not work around it with a personally-held API token.

## Failure modes carried in `knowledge`

Two, both from the same investigation:

1. **Fixed** — a stale line from a previous, failed run stayed in the
   append-mode tunnel log and matched the URL pattern before the real
   tunnel's line did, because the pattern did not distinguish `cloudflared`'s
   own `api.trycloudflare.com` control-plane host (present verbatim in a
   failure message) from a real tunnel's random-word subdomain.
2. **Open** — a `cloudflare-tunnel` run can take as long as `cloudflared`
   itself takes to give up (observed: 2m21s), because backgrounding it with
   plain `(nohup ... </dev/null >>log 2>&1 &)` inside a non-interactive shell
   does not give it its own session — `nohup` only ignores `SIGHUP`, it does
   not detach the process group — so the deploy command's process-management
   layer keeps waiting on `cloudflared`'s own exit rather than the launcher
   script's. Advised fix (`setsid`) is written into `DeployService.ts` and
   into this pack's integration prompt, but has not been re-verified
   end-to-end: the next real run of this pack should confirm it actually
   returns quickly, and if it does, this entry should move from `open` to
   `fixed`.

## Left undone

- No named (persistent) tunnel kind — quick tunnels only, so every
  `cloudflare-tunnel` deployment's address changes on restart.
- `cloudflare-pages` has not been exercised against a real, connected
  Cloudflare account — needs a human OAuth consent step first.
- The `setsid` fix for the open failure mode above has not been re-verified
  end-to-end; it is the first thing the next deployment of this pack should
  confirm.
- No TLS/custom-domain wiring for a Pages deployment beyond what
  `cloudflareConnectDomain`'s registrar-hint flow already provides — this pack
  covers the `*.pages.dev` deploy itself, not attaching a custom domain to it.
