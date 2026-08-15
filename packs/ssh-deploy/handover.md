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

It deploys to either of two targets, chosen in `deploy.config.json` at the
project root: `local` runs the start command on the machine you are on, `ssh`
ships it to the node. Both publish with a cloudflare quick tunnel, which needs
no account and prints a `*.trycloudflare.com` address that changes on every
restart. `deploy.config.example.json` is the shape; the config names the secret
holding the password and never holds the password itself, which is what makes it
safe to commit beside a project.

The integration prompt — the thing an agent actually reads — tells it to read
that config first and, when it is absent, to ask for the values and write it
before deploying anything. That is what makes first-run configuration happen
rather than merely be documented.

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

## What is unfinished

- **Content digests.** `t3-pack validate` reports one warning:
  `contents-digest-missing`, so an extractor cannot check what it got before
  running it. Pre-existing, and worth closing before this is published anywhere.
- **The two deploy stories are not reconciled.** Either the `lp-*` tooling
  should be reinstalled on the node, or `infra/deploy/README.md` should say it
  describes a host that no longer exists. Right now they contradict each other
  and both look authoritative.
- **Nothing reaps old deployments.** Five `t3-pack-*` directories are on the
  node from previous runs, the oldest from 2026-08-09, with their gunicorn
  processes still listening. The disk is 78% full. There is no cleanup step in
  the deploy and no record of which deployments are still wanted.
- **AppleDouble litter.** Deploys from macOS carry `._*` files across; `rsync`
  should exclude them and currently does not.
