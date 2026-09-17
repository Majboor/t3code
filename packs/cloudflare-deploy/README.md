# cloudflare-deploy

Deploy a project through Cloudflare's quick tunnels or Cloudflare Pages, using
T3's native `cloudflare-tunnel` / `cloudflare-pages` deploy target kinds
rather than a hand-rolled shell ritual.

This file describes the real infrastructure a deploy through this pack talks
to — which, unlike `ssh-deploy`'s single fixed node, is not one host but two
different pieces of Cloudflare's own infrastructure, verified against real
runs on 2026-09-17.

## The two targets

|                    | `cloudflare-tunnel`                                                                | `cloudflare-pages`                                                              |
| ------------------ | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| What it publishes   | Whatever the deploy command starts locally, on a loopback port                      | A static build output directory                                                  |
| Where it runs       | This machine (or wherever the deploy command executes)                              | Cloudflare's own edge, via the Cloudflare Pages API                              |
| Account needed      | None — an anonymous **quick tunnel**                                                | Yes — the person's own Cloudflare account, connected once under Settings → Connections |
| Address             | `https://<random-words>.trycloudflare.com`, changes every restart                   | `https://<project>.pages.dev`, stable across deploys                             |
| Auth                | None                                                                                 | OAuth token resolved server-side by `ExternalIntegrations`, never handed to the deploy command |

Both are additive `DeployTargetKind` values sitting alongside the existing
`command` and `ssh` kinds — a `cloudflare-tunnel`/`cloudflare-pages` target is
listed, run and shown on the Infrastructure page through the exact same
`t3 deploy` commands and `DeploymentRegistry` as any other target kind.

## `cloudflare-tunnel`

### How it actually works

1. `t3 deploy add --project <id> --name <name> --command '<cmd>' --tunnel-port <port>`
   registers a target whose `cloudflareTunnel.port` is `<port>`.
2. `t3 deploy run <targetId>` executes `<cmd>` with one extra environment
   variable injected: `T3_TUNNEL_LOG_PATH`, a path to a fresh, truncated log
   file for this run.
3. The command's job is to background **both** the service on `<port>` **and**
   `cloudflared`, with `cloudflared`'s stdout/stderr redirected into
   `$T3_TUNNEL_LOG_PATH`, then exit quickly — the same "start it and return"
   contract every deploy target already expects of `command`/`ssh`.
4. Once the launcher exits, `t3 deploy run` polls `$T3_TUNNEL_LOG_PATH` for a
   `https://<name>.trycloudflare.com` line (up to 10 attempts, 500ms apart)
   and registers that as the deployment's URL — no `--url` flag needed, unlike
   `ssh-deploy`'s manual quick-tunnel path.

A real, tested invocation:

```bash
t3 deploy add --project "$PROJECT_ID" --name web \
  --command '(cd www && setsid nohup python3 -m http.server 8947 </dev/null >/dev/null 2>&1 &); \
             (setsid nohup cloudflared tunnel --url http://127.0.0.1:8947 </dev/null >> "$T3_TUNNEL_LOG_PATH" 2>&1 &); \
             sleep 1; echo started' \
  --tunnel-port 8947

t3 deploy run <targetId>
```

### Two things learned from real runs, not from reading the code

**A previous run's failure line can be mistaken for this run's success.**
`cloudflared` writes into the same log path across redeploys (append mode,
same as any log a shell `>>` redirect writes to), and a failed attempt's own
error line —

```
failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded
```

— contains a real `https://….trycloudflare.com`-shaped URL: `cloudflared`'s
own control-plane host, `api.trycloudflare.com`. A pattern that does not
exclude it can match that line instead of the real tunnel's, from three runs
earlier, and register the wrong address as live. T3 now truncates the log at
the start of every run and excludes `api.trycloudflare.com` by name from the
match — see `DeployService.ts`. A pack author who ever reads this log
directly (rather than through `t3 deploy run`) should apply the same
exclusion.

**`nohup` is not enough to make `cloudflared` return quickly.** Measured: a
run that only wrapped `cloudflared` in `nohup ... </dev/null >>log 2>&1 &`
took 2m21s to return — as long as `cloudflared` itself took to give up on a
transient quick-tunnel-request timeout — because `nohup` only ignores
`SIGHUP`; it does not put the process in a new session, so it stays in the
same process group as the launcher and keeps a pipe T3's process runner is
waiting on from closing. **Use `setsid`** (shown in the invocation above) to
actually detach it. This is written into the manifest's integration prompt as
current advice, not as a confirmed fix — the next real deploy through this
pack should confirm it returns quickly, and this README (and the matching
`knowledge.failureModes` entry) should be updated once it does.

## `cloudflare-pages`

### How it actually works

1. The person connects Cloudflare once, under Settings → Connections — this
   is a browser OAuth consent flow and cannot be done by an agent; see the
   note below.
2. `t3 deploy add --project <id> --name <name> --command '<build cmd>' \
   --pages-account-id <accountId> --pages-project <name> --pages-build-dir <dir>`
   registers a target whose `cloudflarePages` config names the account,
   the Pages project, and which directory (relative to the workspace) holds
   the build output to upload.
3. `t3 deploy run <targetId>` runs the build command, then deploys
   `<dir>` to Cloudflare Pages via `ExternalIntegrations.cloudflareDeployPages`
   — the same OAuth-backed method used everywhere else Cloudflare is touched
   in this codebase, resolving the account's token server-side rather than
   asking the deploy command for one.

### What has not been verified yet, and why

No live deploy has been run against a real Cloudflare account. Doing so needs
a person to click through the OAuth consent screen in a browser first — the
platform has no way around that, and this pack does not attempt one with a
personally-held API token. Once a Cloudflare account is connected, the next
real test is: run a `cloudflare-pages` target end to end and confirm the
deployment shows up correctly on the project's Infrastructure page, the same
check already done for `cloudflare-tunnel`.

## What T3 already had before this pack

Everything above is new schema and CLI surface added in this same change —
`DeployTargetKind` gained `cloudflare-tunnel`/`cloudflare-pages` alongside the
existing `command`/`ssh`, migration `068_DeployTargetsCloudflare` added the
matching nullable columns, and `t3 deploy add` gained `--tunnel-port` and
`--pages-account-id`/`--pages-project`/`--pages-build-dir`. Existing
`command`/`ssh` targets were regression-checked and still create and run
unchanged.
