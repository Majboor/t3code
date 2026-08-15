# ssh-deploy

Deploy a thing to a server over SSH, whatever shape the thing is.

This file describes the **LogicPacks deployment node** — the one public host
users are allowed to deploy onto — and what a deploy onto it actually looks
like. Everything below was verified against the live host on 2026-08-15.

## The node

| | |
|---|---|
| Host | `164.68.117.31` |
| OS | Ubuntu 24.04.2 LTS |
| Access | SSH as `root` |
| Toolchain | node 22.22.1, python 3.12.3, git 2.43.0, rsync 3.2.7, docker 29.1.3 |
| Publishing | `cloudflared` tunnels — there is no nginx and no caddy on this host |
| Disk | 290G, 78% used at the time of writing |

**It is a shared, busy machine.** It runs dozens of unrelated production
services — Apache, several Flask APIs, and a long list of `cf-tunnel-*` units
for other people's projects. A deploy that takes a port someone else is on, or
fills the disk, breaks things that have nothing to do with it. That is the
reason for most of the care below.

## Two places to deploy

The pack deploys to either, and the difference is one field in the config:

- **`local`** — the start command runs on this machine, and a **cloudflare quick
  tunnel** publishes it. No host, no SSH, no credentials. Good for showing
  somebody a thing, and the fastest way to find out whether it survives being
  started at all.
- **`cloud`** — shipped over SSH to the node below and started there, published
  the same way. Survives you closing your laptop, which is the only reason to
  prefer it.

Both publish through `cloudflared`, which is installed on this machine
(2026.3.0, homebrew) and on the node (2026.3.0). A quick tunnel needs no
Cloudflare account and prints a `*.trycloudflare.com` URL on startup — capture
that URL, because it is the deployment's address and it changes every time the
tunnel restarts.

```bash
# after the app is listening on 127.0.0.1:$DEPLOY_PORT
cloudflared tunnel --url "http://127.0.0.1:${DEPLOY_PORT}"
```

## Configuring it

The pack reads `deploy.config.json` from the project root.
`deploy.config.example.json` in this pack is the shape; copy it and fill it in.

**On first use there is no config, and that is the moment to ask.** An agent
running this pack with no `deploy.config.json` present should stop and ask for
the values it needs rather than guess at them — which target, and for an `ssh`
target the host, user, remote directory, port and the *name* of the secret
holding the password. Then write the file. Every later deploy reads it and asks
nothing.

| Field | Meaning |
|---|---|
| `defaultTarget` | Which target a bare "deploy this" means. |
| `targets.<name>.kind` | `local` or `ssh`. |
| `targets.<name>.port` | `null` means pick a free one at deploy time. |
| `targets.<name>.portRange` | Where to pick from, so a guess cannot land on somebody else's service. |
| `targets.<name>.passwordSecretName` | The **name** of a secret, never a password. |
| `targets.<name>.publish.mode` | `cloudflare-quick-tunnel`, or `none` to leave it on loopback. |
| `targets.<name>.shared` | `false` keeps a target out of what other users are offered. |

The config holds no secrets — only the name of one. That is what makes it safe
to commit beside the project.

**The `cloud` target is currently `"shared": false`.** The node is a personal
box running dozens of unrelated production services; it is not yet a thing to
hand other users. Leave the flag alone until that is a deliberate decision.

## The four variables

| Variable | Secret | What it is here |
|---|---|---|
| `DEPLOY_SSH_HOST` | no | `164.68.117.31` |
| `DEPLOY_SSH_USER` | no | `root` |
| `DEPLOY_REMOTE_DIR` | no | `/srv/t3-pack-<id>` — see below |
| `DEPLOY_PORT` | no | a free loopback port; the ones in use are `19xxx` |

`DEPLOY_SSH_PASSWORD` is declared alongside them and is **secret**. It is read
from the server secret store and passed to `ssh` through the environment, never
as a command-line argument — argv is world-readable in `ps`. The password is not
in this repository and must not be put here: this pack carries a `visibility`
field, and a published pack holding a plaintext root password would hand root on
a public box to everyone who installs it.

`DEPLOY_START_COMMAND` comes from the project being deployed, not from this
pack.

## Where a deployment lands

One flat directory per deployment, named for the moment it was created:

```
/srv/t3-pack-1786667796599/
├── app.py                     the project, rsync'd across
├── templates/
├── BUILD                      the build id, e.g. 1786667796599-4
├── app.pid                    the pid of the detached process
└── deploy.log                 gunicorn's own output
```

There is **no** systemd unit per deployment. The only `t3` unit on the host is
`t3code.service`, which is the T3 Code server itself and nothing to do with a
deployed project. A deployment is a detached process whose pid is written down,
which is why `app.pid` matters — it is the only handle on it.

Ports observed in use by existing deployments: `19018`, `19199`, `19203`,
`19209`, `19236`, `19392`. Bind loopback (`127.0.0.1`), never `0.0.0.0`, and let
a cloudflared tunnel publish it. Check the port is free before taking it —
`ss -ltn` — because the failure mode is silently stealing traffic from whatever
was already there.

## The procedure

The manifest's integration prompt is the authority on the shape of a deploy;
this is what it means on this host specifically.

1. **Work out what the thing is.** Something that serves HTTP gets shipped and
   started. Something that produces a document gets built, then its output
   served. A terminal program has no port and cannot pass a health check — stop
   and agree a shape with the person before building anything.
2. **Preflight.** Confirm the start command's runtime exists on the host (node
   and python3 both do), and that `DEPLOY_PORT` is free.
3. **Stamp a build id** into `BUILD` and serve it from `/healthz`.
4. **Ship** the directory with `rsync -a --delete`, then start the process
   detached, writing its pid to `app.pid` and its output to `deploy.log`.
5. **Verify from a separate SSH session**, and require the build id you just
   shipped. "Something answers" is not a check — the previous deployment will
   answer perfectly well.

## Two warts worth knowing

**AppleDouble files.** Existing deployments are full of `._app.py`,
`._BUILD` and friends — rsync from macOS carrying resource forks across. They
are harmless but they are noise, and `--delete` will not remove them because
they keep being re-sent. Use `rsync --exclude='._*'` unless you want them.

**`infra/deploy/README.md` does not describe this host.** That document details
an `lp-deploy.sh` scheme — `/srv/lp-workspaces/lp-<id>`, a per-workspace unix
user, ports allocated from 21000–21999, systemd units per pack — and cites
evidence captured from this same IP on 2026-08-08. **None of it is on the node
today**: no `lp-*` scripts anywhere on the filesystem, no `/srv/lp-workspaces`,
no `lp-*` units, nothing listening in the 21000–21999 range. Either the host was
rebuilt or that tooling was never installed here. Deploy the way this file
describes, not the way that one does, until somebody reconciles the two.
