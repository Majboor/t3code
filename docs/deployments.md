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
shell pipelines and CI. `run` accepts a target's **exact name** as well as its
id, so the name you just passed to `deploy add` is enough. A name that no
target answers to — or that two do — is refused with the list of targets that
do exist; nothing is run.

`deploy list`, `deploy runs`, `analytics list` and `analytics query` also take
`--json`, which is the form an agent should read.

## `t3 deploy run` is the only route that records anything

This is the single most confusing failure in the product, so it is worth being
blunt about. Starting the process yourself — `ssh host './start.sh'`, a
container push, a plugin that publishes for you — works. The site serves. And
T3 records nothing: no deploy target, no deployment row, so the Infrastructure
page stays empty for a project that is live, and analytics can never be wired,
because the ingest key is minted during `t3 deploy run` and is never stored.
There is no later command that can repair it. Redeploy through `t3 deploy run`.

A successful run therefore prints what it registered and where to look at it:

```
Deploy deploy-run:f272… succeeded.
  Target      web-3000 (deploy-target:18c9…)
  Project     proj-1
  Deployment  web-3000 — live at http://127.0.0.1:3000
  Took        4.2s
  Analytics   page.view — stream declared, ingest key injected as T3_ANALYTICS_INGEST_KEY

Now visible on:
  Infrastructure  http://127.0.0.1:3773/infra/proj-1
  Analytics       http://127.0.0.1:3773/analytics/proj-1
```

Those addresses come from the running server when there is one. When there is
not, the default port is used and the output says so rather than printing a
guess as if it had been checked.

## Wiring analytics into a deploy

Analytics only becomes reachable if the deploy declares it, because that is the
only moment a deployment can be handed a working key:

```bash
t3 deploy run web-3000 \
  --url http://127.0.0.1:3000 \
  --analytics-stream page.view \
  --analytics-purpose 'Which pages get read' \
  --analytics-properties 'path:string:required,seconds:number'
```

| Flag                     | Default                                          |
| ------------------------ | ------------------------------------------------ |
| `--analytics-stream`     | none — without it, no analytics is wired at all  |
| `--analytics-key-var`    | `T3_ANALYTICS_INGEST_KEY`                        |
| `--analytics-purpose`    | "Reported by the `<deployment>` deployment."     |
| `--analytics-properties` | empty — the stream accepts no properties          |
| `--deployment-name`      | the target's name                                |
| `--url`                  | none — the deployment is recorded without one     |

`--analytics-purpose` and `--analytics-properties` are read only when the
stream has to be declared. The run says which of the two happened: `stream
declared` for a new one, `existing stream, ingest key reissued` for one that
was already there. A stream name that the contract would reject is refused
before the deploy runs, rather than surfacing as a decode failure after the
command has already executed.

Reissuing stops the previous key working, so a deploy that would cut off a
*different* live deployment is refused and nothing runs. The refusal names who
reports to the stream and the two ways out: redeploy under that deployment's
name, or report to a different stream.

The key is injected into the deploy process's environment and nowhere else. It
is not stored, not printed by `deploy run`, not present in `--json` output, and
redacted out of the captured run output before it is saved.

## Agent-driven deploys

Coding agents already run shell commands inside the workspace, so they can
invoke `t3 deploy run <targetId>` directly — no separate tool wiring. Ask the
agent to "deploy production" and it can list targets, pick the right one, run
it, and read back the recorded output. Because runs are persisted, a later
session can inspect what happened with `t3 deploy runs`, which shows when each
run started, how long it took, its exit code, who triggered it and against
which target.

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

## Packs

`t3 pack search <what you are about to do>` and `t3 pack show <name>` read the
recorded knowledge for a task. Both print the workspace page for each pack they
found, so the same pack can be read in the app.

## Programmatic access

See [`packages/sdk/README.md`](../packages/sdk/README.md) for driving deploys
from scripts with `@t3tools/sdk`.
