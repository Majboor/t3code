# ssh-deploy

What this does, what was tried, and what is left undone. The handover is
required because a pack nobody can describe is a zip file with metadata.

## What it does

Ships a project to the LogicPacks deployment node over SSH and starts it, for
whatever shape the project is — an HTTP service, a thing that renders a
document, or a terminal program that has to be talked about before it can be
deployed at all.

The node is `164.68.117.31`, Ubuntu 24.04.2, reached as `root`. A deployment is
a flat directory under `/srv/t3-pack-<id>` holding the project, a `BUILD` stamp,
an `app.pid` and a `deploy.log`; the process is detached gunicorn bound to a
loopback `19xxx` port, published by a cloudflared tunnel. `README.md` has the
detail, verified against the live host on 2026-08-15.

The manifest declares six environment requirements. Four describe the
connection — `DEPLOY_SSH_HOST`, `DEPLOY_SSH_USER`, `DEPLOY_REMOTE_DIR`,
`DEPLOY_PORT` — and their examples are the node's real values. One is the
password, marked secret and read from the server secret store. The last,
`DEPLOY_START_COMMAND`, belongs to the project rather than to this pack.

It deploys to either of two targets: `local` runs the start command on the
machine you are on, `ssh` ships it to the node. Both publish with a cloudflare
quick tunnel, which needs no account and prints a `*.trycloudflare.com` address
that changes on every restart.

Which target a project uses is not written beside the project — it is the
project's deploy targets, which T3 already stores and `t3 deploy list --project
<id>` reads back, with the start command and, for `ssh`, the host, user and
remote path. A target names the secret holding the password and never holds the
password itself.

The integration prompt — the thing an agent actually reads — tells it to consult
that listing first and, when the project has no target yet, to ask for the
values and register one before deploying anything. That is what makes first-run
configuration happen rather than merely be documented, and it is why the answers
survive to the next deploy without a file to keep in step.

## What was tried and rejected

**Putting the node's credentials in the manifest.** The host and the SSH user
are public facts about a public node and belong in the pack. The password does
not: the manifest carries a `visibility` field, and a pack published with a
plaintext root password would hand root on a shared box — one running dozens of
other people's services — to everyone who installs it. It stays in the secret
store, referenced by name.

**Passing the password on the command line.** `sshpass -p` puts it in argv,
which anybody on the host can read out of `ps`. `sshpass -e` and the environment
instead.

**Trusting `infra/deploy/README.md`.** It documents an `lp-deploy.sh` scheme —
`/srv/lp-workspaces/lp-<id>`, a unix user per workspace, ports 21000–21999,
systemd units per pack — and cites evidence captured from this very IP on
2026-08-08. None of that exists on the node now: no `lp-*` scripts, no
`/srv/lp-workspaces`, no `lp-*` units, nothing listening in that port range. The
README here describes what is actually there instead.

## What was closed on 2026-08-15

- **A hand-run deploy was invisible.** An agent following this pack shelled out
  `rsync` and `gunicorn` directly, which serves the app but tells T3 nothing:
  no row on the project's Infrastructure page, and no deployment for analytics
  to attach to. The prompt now registers the start command as a deploy target
  and runs it through `t3 deploy run`, which records the run and registers what
  went live. `t3 deploy run` also grew `--analytics-stream` and friends, because
  until then the CLI — the only surface an agent drives — could start a deploy
  but could not wire it to analytics at all.
- **Nothing retired what it replaced.** Steps 5 and 6 stop the previous process
  and delete its directory, and check `app.pid` is non-empty and live. The six
  orphaned gunicorns and five directories on the node were cleared by hand the
  same day.
- **AppleDouble litter.** The ship step is now
  `rsync -a --delete --exclude='._*'`, in the README and in the prompt.
- **The two deploy stories.** `infra/deploy/README.md` now opens with a banner
  saying it describes a host that no longer exists; re-verified against the node
  that day.
- **Content digests and the scaffold interface.** `contents` carries a digest
  per file, and the placeholder `install` export is gone — a deploy pack exports
  nothing, and the format allows saying so.

Two claims in the earlier version of this file were wrong and are worth
recording as such: the five stale directories totalled **400K**, not a
meaningful share of the node's 78% disk (that is `/var` at 80G and `/root` at
63G, neither of them ours); and their `app.pid` files were **empty**, so the
gunicorns still listening were not reachable through them — one was running
from a directory that had already been deleted.

## What is unfinished

- **The health check can still be fooled, in principle.** `/healthz` must read
  its build id **once at import**. Read per request, a process left over from
  the previous deploy serves the new id straight off disk, and a deploy that
  never restarted anything looks like a success. This is failure mode
  `health-check-answered-by-the-previous-deployment`, and it is easy to
  reintroduce in any app written against this pack.
- **The deploy still has no opinion about ports.** `DEPLOY_PORT` is picked by
  whoever writes the config, and the only protection against taking a port
  someone else is on is the preflight check. On a host running other people's
  services that is thin.
- **Target names are chosen by the agent, and they are load-bearing.** A
  deployment is identified by name, so the name decides whether a deploy
  replaces what is live or stands up a rival beside it. Registering a name that
  already exists now re-registers that target rather than adding a second, which
  makes re-registering on every deploy safe — but nothing stops an agent
  choosing a _different_ name each time, and that still splits one deployment
  into two.
