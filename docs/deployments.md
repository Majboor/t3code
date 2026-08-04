# Deployments

A deploy target describes how a project ships. Targets belong to a project,
and every run is recorded so humans and agents share the same history.

## Target kinds

| Kind      | Runs                                            | Use for                                                                |
| --------- | ----------------------------------------------- | ---------------------------------------------------------------------- |
| `command` | A shell command in the project's workspace root | Local builds, container pushes, `vercel deploy`, PDF/report generation |
| `ssh`     | The same command on a remote host over SSH      | Servers you own — pull, build, restart services                        |

## Managing targets from the CLI

```bash
# Local command target
t3 deploy add --project <projectId> --name "Build docs" \
  --command "npm run build && npm run export"

# Remote target over SSH
t3 deploy add --project <projectId> --name "Production" \
  --command "git pull && docker compose up -d --build" \
  --ssh-host 203.0.113.10 --ssh-user root --ssh-path /srv/app \
  --ssh-password-secret production-ssh

t3 deploy list
t3 deploy run <targetId>
t3 deploy runs
```

`t3 deploy run` exits non-zero when the deploy fails, so it composes with
shell pipelines and CI.

## Agent-driven deploys

Coding agents already run shell commands inside the workspace, so they can
invoke `t3 deploy run <targetId>` directly — no separate tool wiring. Ask the
agent to "deploy production" and it can list targets, pick the right one, run
it, and read back the recorded output. Because runs are persisted, a later
session can inspect what happened with `t3 deploy runs`.

## Credentials

SSH passwords are never stored in the projection and never passed as process
arguments. Write the password into the server secret store and reference it
by name:

```bash
# Secrets live under <baseDir>/<stateDir>/secrets/<name>.bin
printf 'your-password' > ~/.t3/userdata/secrets/production-ssh.bin
chmod 600 ~/.t3/userdata/secrets/production-ssh.bin
```

The server passes the value to `sshpass -e` through the environment. Key-based
auth is preferred where possible — use `--ssh-identity-file` instead.

## Permissions

Deploy RPCs are gated by the same workspace permissions as the rest of the
project surface: listing requires `project.view`, and creating, deleting, or
running a target requires `project.edit`. A collaborator who cannot edit a
project cannot deploy it.

## Programmatic access

See [`packages/sdk/README.md`](../packages/sdk/README.md) for driving deploys
from scripts with `@t3tools/sdk`.
