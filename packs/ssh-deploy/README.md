# ssh-deploy

Deploy a thing to a server over SSH, whatever shape the thing is.

This file describes the **LogicPacks deployment node** — the one public host
users are allowed to deploy onto — and what a deploy onto it actually looks
like. Everything below was verified against the live host on 2026-08-15.

## The node

|            |                                                                     |
| ---------- | ------------------------------------------------------------------- |
| Host       | `164.68.117.31`                                                     |
| OS         | Ubuntu 24.04.2 LTS                                                  |
| Access     | SSH as `root`                                                       |
| Toolchain  | node 22.22.1, python 3.12.3, git 2.43.0, rsync 3.2.7, docker 29.1.3 |
| Publishing | `cloudflared` tunnels — there is no nginx and no caddy on this host |
| Disk       | 290G, 78% used at the time of writing                               |

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

There is no config file. A project's deploy targets are the configuration, and
T3 already stores them:

```sh
t3 deploy list --project <projectId>
```

That names every target the project has, with the start command it runs and,
for an `ssh` target, its host, user and remote path — which is everything a
redeploy needs to know about the last one.

**On first use nothing is listed, and that is the moment to ask.** An agent
running this pack against a project with no targets should stop and ask for the
values it needs rather than guess at them — which target, and for an `ssh`
target the host, user, remote directory, port and the _name_ of the secret
holding the password. It then registers the answers as a target (`t3 deploy
add`), and every later deploy reads them back from the listing and asks nothing.

**Keep the target's name stable.** The name is how a deployment is identified,
so registering one that already exists re-registers that same target and a
redeploy replaces what is live. A new name each time stands up a rival
deployment beside the old one, and the next deploy that wires analytics is
refused for taking the stream away from what is really its own past self.

Earlier versions of this pack described a `deploy.config.json` written beside
the project. Nothing in T3 ever read it, and what it held — target name, start
command, port — was already in the deploy target, so the two could only drift
apart. It is gone as of 1.5.0; delete any copy still sitting in a project root.

No secret is stored either way — a target holds the _name_ of the secret
holding the password, never the password.

**The `cloud` target is currently `"shared": false`.** The node is a personal
box running dozens of unrelated production services; it is not yet a thing to
hand other users. Leave the flag alone until that is a deliberate decision.

## The four variables

| Variable            | Secret | What it is here                                   |
| ------------------- | ------ | ------------------------------------------------- |
| `DEPLOY_SSH_HOST`   | no     | `164.68.117.31`                                   |
| `DEPLOY_SSH_USER`   | no     | `root`                                            |
| `DEPLOY_REMOTE_DIR` | no     | `/srv/t3-pack-<id>` — see below                   |
| `DEPLOY_PORT`       | no     | a free loopback port; the ones in use are `19xxx` |

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
4. **Ship** the directory with `rsync -a --delete --exclude='._*'`, then start
   the process detached, writing its pid to `app.pid` and its output to
   `deploy.log`. The exclude is not optional on macOS; see the wart below.
5. **Verify from a separate SSH session**, and require the build id you just
   shipped. "Something answers" is not a check — the previous deployment will
   answer perfectly well.
6. **Retire what you replaced.** Stop the previous deployment before starting
   the new one, by the pid in its `app.pid` — and when that file is empty, by
   the process whose working directory is the old deployment directory
   (`ls -l /proc/*/cwd`), never by `pkill -f`. Then delete the old directory,
   and check the new `app.pid` is non-empty and names a live process. An empty
   pid file is the same as no handle at all.

## Two warts worth knowing

**AppleDouble files.** Existing deployments are full of `._app.py`,
`._BUILD` and friends — rsync from macOS carrying resource forks across. They
are harmless but they are noise, and `--delete` will not remove them because
they keep being re-sent, which is why step 4 excludes them rather than leaving
it to taste. Deployments made before that exclude still hold theirs; clearing
them means deleting them on the host, because no later deploy will.

**`infra/deploy/README.md` does not describe this host.** That document details
an `lp-deploy.sh` scheme — `/srv/lp-workspaces/lp-<id>`, a per-workspace unix
user, ports allocated from 21000–21999, systemd units per pack — and cites
evidence captured from this same IP on 2026-08-08. **None of it is on the node
today**: no `lp-*` scripts anywhere on the filesystem, no `/srv/lp-workspaces`,
no `lp-*` units, nothing listening in the 21000–21999 range. Either the host was
rebuilt or that tooling was never installed here. Deploy the way this file
describes, not the way that one does.

Re-verified against the live host on 2026-08-15, and that document now carries a
status banner saying it describes a host that no longer exists — so the two no
longer contradict each other. It remains the design for the runner; this file
remains the description of the node.
