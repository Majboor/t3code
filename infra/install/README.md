# Turning a machine into an environment

An environment is just a machine running the T3 server. This is the one line
that does it, and the reasoning about why it is safe to run on a box that is
already doing other work — which is the normal case, not the exception.

## The line

**Not published yet.** No job builds a server tarball and no job uploads one
anywhere, so there is no URL to `curl`. The script refuses at the download step
rather than guessing at a host:

```
t3: ERROR: there is no published release to install.

    No job builds a server tarball and no job uploads one anywhere, so this
    script has nowhere to fetch 0.0.20 from and will not guess at a URL.
    Nothing was installed.
```

When there is a release host, exactly two things change: the
`ENVIRONMENT_INSTALL_BASE_URL` constant in
[`scripts/lib/environment-install.ts`](../../scripts/lib/environment-install.ts)
and the `T3_INSTALL_BASE_URL` line in the script. Then the line is:

```sh
curl -fsSL https://<host>/install.sh | sh
```

Until then, copy `t3-environment.sh` to the machine and point it at artifacts
you host yourself:

```sh
sudo sh t3-environment.sh \
  --base-url https://your-host/artifacts \
  --account-url https://your-t3-server \
  --port 3773
```

## Look before you run

Anyone pasting a pipe-to-shell line deserves to see the plan. It prints on every
run, and `--dry-run` prints it and stops:

```sh
sudo sh t3-environment.sh --dry-run --base-url ...
```

```
t3: plan for vps-01
    install    T3 server 0.0.20 + bun 1.3.11 into /opt/t3-environment
    data       /var/lib/t3-environment (created if absent, never overwritten)
    user       system account 't3env', no shell, no password
    service    /etc/systemd/system/t3-environment.service, restart on failure, start at boot
    listen     127.0.0.1:3773
    enroll     into the account at https://... (you approve it in a browser)
```

Every step that would change the machine then announces itself as `would run:`
and executes nothing.

## What it installs, and where

| Path                                            | What                               | Removed by `--uninstall` |
| ----------------------------------------------- | ---------------------------------- | ------------------------ |
| `/opt/t3-environment`                           | bun runtime + server bundle        | yes                      |
| `/opt/t3-environment/libexec/t3-environment.sh` | a copy of this script, for removal | yes                      |
| `/var/lib/t3-environment`                       | database, logs, worktrees          | **no — see below**       |
| `/etc/systemd/system/t3-environment.service`    | the unit                           | yes                      |
| `/opt/t3-environment/libexec/t3-unit-helper`    | the one thing the agent may `sudo` | yes                      |
| `/etc/sudoers.d/t3-environment`                 | one line, naming that helper       | yes                      |
| `/var/lib/t3-environment/apps`                  | where the agent's own services live | **no — under the data dir** |
| `t3-app-*.service` written by that helper       | the agent's own units              | yes (only its own)       |
| system user `t3env`                             | uid < 1000, no shell, no password  | yes                      |

Nothing else. No packages are installed — not by the installer and not by the
privileged helper — no unit anything else wrote is touched, and no file outside
those paths is written.

Data lives outside the prefix on purpose. Uninstall removes the prefix outright;
if the SQLite file and the worktrees lived under it, `--uninstall` would be
indistinguishable from `rm -rf` on somebody's work. Keeping it at an
FHS-conventional path means removal can be honest — the code goes, the data
stays, and the script says so and prints its size.

## What it needs

- Linux, x86_64 or aarch64. Anything else is refused by name (`Darwin` gets told
  about `t3 serve`, not about its CPU).
- systemd as the **running** init — `/run/systemd/system` must exist. A plain
  container fails this and is told so.
- `curl`, `tar`, `unzip`, `awk`. Missing ones are named with the package to
  install; the script does not install system packages on a machine it does not
  own.
- root, for `useradd` and the unit. Platform is checked _before_ privilege, so a
  Mac user is not asked for a root shell they turn out not to need.
- Outbound HTTPS to `github.com` for the pinned bun release, and to whatever
  host serves the server tarball.

## Joining an account

`--account-url` enrolls the machine through the flow that already exists in
[`apps/server/src/deviceEnrollment/http.ts`](../../apps/server/src/deviceEnrollment/http.ts).
No second mechanism, and nothing that works without a person:

1. The machine `POST`s to `/api/devices/enrollments` and gets a code back.
2. The script prints an approval link and waits.
3. You open it in a browser where you are already signed in and approve. That
   route is the only authenticated one in the flow, and it is the whole feature.
4. The machine polls `/collect`, receives a bearer session **once**, and the
   code is spent forever.

The credential lands at `/var/lib/t3-environment/enrollment.json`, mode `0600`,
owned by `t3env`. The machine also appears in your account's connected-machines
list, where it can be revoked — that is `POST /api/devices/machines/:id/revoke`,
and revoking kills the session, not just the row.

Omit `--account-url` and the server is installed and running but joins no
account. Enrollment failures never fail the install; they warn and tell you to
re-run.

## What the agent may do as root, and what it may not

The agent on a box runs as `t3env`: a system account with no shell, no password
and no privileges. That is the whole design, and it is why the T3-side refusals
("that service is not ours to stop") are worth having at all — they describe a
machine the agent genuinely cannot damage.

Two things it legitimately needs are out of reach of an unprivileged user:
managing its own services, and having them start at boot. Those, and only those,
are delegated — through **one** sudoers rule naming **one** root-owned helper:

```
t3env ALL=(root) NOPASSWD: /opt/t3-environment/libexec/t3-unit-helper
```

That line is the entire grant. It is worth reading for what it does not say:

- **Not `/bin/systemctl`.** `NOPASSWD: /bin/systemctl` is the tempting version
  and it is the same thing as giving the agent root — one
  `systemctl stop days-tracker-api` and somebody's production API is down. The
  refusals in the T3 code cannot prevent that, because the agent has a shell and
  can call systemctl itself.
- **No wildcard.** One absolute path, no `*`, no argument patterns. The helper
  validates its own arguments; sudoers is not asked to.
- **No `ALL`, no second entry, no second user.**

### What the helper will do

Seven verbs — `create`, `start`, `stop`, `restart`, `enable`, `disable`,
`status` — over units named `t3-app-<something>.service` that carry its own
marker. Everything else is refused, with a reason and an exit code of 3:

```
$ sudo /opt/t3-environment/libexec/t3-unit-helper stop days-tracker-api
t3-unit-helper: refused (unit-name-outside-prefix): this helper only manages
units named t3-app-<something>.service. Everything else on this machine belongs
to somebody else.
```

`create` does **not** accept a unit file. It takes a program, its arguments, a
working directory, a port and a description, and generates the unit from a fixed
template:

```sh
t3 box unit create <box> t3-app-web \
  --exec /var/lib/t3-environment/apps/web/run \
  --arg --config --arg /var/lib/t3-environment/apps/web/app.json \
  --port 8080
```

The generated unit always sets `User=t3env`, `Group=t3env`,
`NoNewPrivileges=yes` and `ReadWritePaths=/var/lib/t3-environment/apps`. So even
a permitted unit runs as the same unprivileged account the agent already had —
the helper's job is to write and manage the unit, never to elevate what runs in
it.

### What it will not do

| Attempt                                             | What happens                                                       |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `systemctl stop <anything>` as `t3env`              | Refused by systemd — the account has no polkit authorisation       |
| `sudo systemctl …`                                  | Refused by sudo — not in the rule                                  |
| `sudo <any other binary>`                           | Refused by sudo — the rule names one path                          |
| Helper, on a unit outside `t3-app-*`                | `refused (unit-name-outside-prefix)`                               |
| Helper, on a `t3-app-*` unit it did not write       | `refused (unit-not-ours)` — the marker, not the name, decides      |
| `t3-app-../other`, `t3-app-x;sh`, `t3-app-Ｘ`       | `refused (unit-name-malformed)` — allowlist, not a prefix test     |
| `--exec` outside the deploy root                    | `refused (path-outside-deploy-root)`                               |
| `--exec` through a symlink out of the deploy root   | Same — resolution happens **before** the decision                  |
| Deploy root replaced with a symlink to `/`          | `refused (deploy-root-unsafe)`                                     |
| `--arg $'x\nUser=root'`, `--description $'x\n…'`    | `refused (argument-malformed)` / `(description-malformed)`         |
| Installing a package                                | Not a verb. Out of scope, deliberately — ask the machine's owner   |

Every one of those was exercised against a real systemd container, as `t3env`,
against a foreign service that was still running afterwards.

### Ports below 1024

Nothing runs as root to bind one. Pass `--port 80` and the generated unit gets:

```
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
```

systemd grants the one capability that binds a low port and drops everything
else; the process is still `t3env`. Verified in the container: `ss` shows the
listener on `:80` owned by uid 996. Above 1024 the unit gets an **empty**
bounding set instead.

### The checks the installer makes before it grants anything

A helper the service user can rewrite is a root shell with extra steps, and the
sudoers line would look identical. So `install_unit_manager`:

1. Installs the helper `root:root`, mode `0755`.
2. Verifies the helper **and every directory above it** are root-owned and not
   group- or other-writable. If any of them is not, it refuses to write the rule
   and removes any rule left from an earlier run.
3. Writes the sudoers file to a temporary path, validates it with `visudo -cf`,
   and only then installs it as `0440 root:root`.
4. Runs `visudo -c` against the whole configuration afterwards, and removes the
   file immediately if that fails — a malformed sudoers file locks everybody out
   of sudo.

`--no-unit-manager` skips all of it and removes the rule if one is present. A
relocated install (`T3_INSTALL_PREFIX`) also skips it: the helper's paths are
fixed, so a rule naming them would not describe the machine.

### The audit trail

Every invocation is logged, including refusals, to syslog (`auth.notice`, tag
`t3-unit-helper`) and to `/var/log/t3-unit-helper.log` — root-owned, mode
`0600`, deliberately outside the agent's reach, because an audit trail the
audited party can rewrite is not one:

```
2026-08-20T22:44:26Z verb=stop unit=t3-app-handwritten.service
  outcome=refused:unit-not-ours detail=... invoker=t3env invoker_uid=996
```

On the T3 side the same actions land in `box_command_journal` (migration 064)
under `unit-create`, `unit-stop` and so on, and a refusal that came back from
the box is recorded as `helper:<reason>` rather than as a failed command — the
distinction being that a box declining to touch somebody's service is an answer,
not a fault. `t3 box history` shows both.

### Where the rules live

`infra/install/t3-unit-helper.sh` is the enforcement, because the agent has a
shell and can call it directly.
[`apps/server/src/box/decideUnitCommand.ts`](../../apps/server/src/box/decideUnitCommand.ts)
is the same rules in TypeScript, so a refusal arrives before a round trip and
lands in the journal with wording a reader can act on. They cannot import each
other, so the helper carries a drift-checked constants block and
`decideUnitCommand.test.ts` asserts the two agree — and then runs the helper
itself against every bypass in the table above.

## Refusing to damage a busy box

The target host for this work runs ~85 unrelated services. Every refusal below
was exercised against a real systemd container, not reasoned about:

| Situation                                    | What happens                                                         |
| -------------------------------------------- | -------------------------------------------------------------------- |
| Something else holds the port                | Refuses, **names the holder and its pid**, changes nothing           |
| A `t3-environment.service` we did not write  | Refuses in preflight, before creating a user or downloading anything |
| Our own service holds the port               | Recognised **by pid**, stopped and replaced                          |
| Our unit exists but a stranger took the port | Refuses — an install existing is not evidence the socket is ours     |
| `ss` unavailable                             | Warns that the check was skipped rather than guessing                |
| Unsupported platform                         | Refuses by name before touching anything                             |

That fourth row is the one worth pointing at. The first version of this check
asked "is there an install here?", which meant that once an environment had ever
been installed, _any_ process on the port was waved through as ours. Only a pid
match against systemd's `MainPID` settles it. The rule and its edge cases —
`MainPID` of 0 for an inactive unit, an unknown pid from an unprivileged `ss` —
are in `conflictIsOwnService`, with tests.

Re-running is always safe. It never duplicates a user, a unit or a data
directory, preserves the account's uid, and reinstalls the same version over
itself rather than doing nothing — because the commonest reason somebody pastes
the line twice is that the first run left something broken.

## Removing it

```sh
sudo /opt/t3-environment/libexec/t3-environment.sh --uninstall
```

Add `--dry-run` to see the plan first. It stops and disables the unit **only if
this script wrote it**, removes the unit, the prefix and the user, and then says
what it left behind:

```
t3: uninstalled.
    LEFT BEHIND: /var/lib/t3-environment (8.0K)
    That is your database, logs and worktrees. Reinstalling picks it up again.
    To remove it too:  sudo rm -rf /var/lib/t3-environment
```

`userdel` is deliberately called without `--remove`: that flag deletes the home
directory, and the home directory is the data directory this promises to keep.
There is a test asserting the flag never appears.

Running it twice is a no-op, not an error.

## Where the decisions live

The script is POSIX `sh` because it runs on a fresh VPS before any runtime
exists. That makes it a bad place to keep judgement, so the judgement is in
[`scripts/lib/environment-install.ts`](../../scripts/lib/environment-install.ts)
with tests in `environment-install.test.ts`: platform detection, version
ordering, `ss` parsing, port-collision rules, service ownership, and the
enrollment poll table.

The script cannot import that module — nothing can, at the moment it runs. So it
carries its own copy of the shared constants in one fenced block, and the test
suite parses that block out of the file and asserts the two agree. Without that
check they would agree exactly once, on the day they were written.

The unit is deliberately less hardened than
[`infra/host/lp-workspace@.service`](../host/lp-workspace@.service). That one
confines a single known workload; this supervises an agent server whose job is
to run git, package managers and whatever toolchain a project needs.
`ProtectSystem=strict`, `ProtectHome=yes` and a syscall filter would each break
that in ways that surface much later as an unexplained failure inside somebody's
build. What is set is the subset that costs nothing: `NoNewPrivileges`,
`PrivateTmp`, `ProtectSystem=full`, the kernel-tunable protections, and a single
`ReadWritePaths`.

## Testing it

`shellcheck -s sh infra/install/t3-environment.sh infra/install/t3-unit-helper.sh`
must pass.

The helper validates its arguments *before* it checks for root, so the whole
refusal table can be exercised from the test suite on any POSIX machine —
`decideUnitCommand.test.ts` does exactly that, running `/bin/sh
infra/install/t3-unit-helper.sh` against each attempt. What still needs a
container is everything after that line: symlink resolution, unit ownership, the
sudoers rule, and the OS refusing `systemctl` to the service user.

The full cycle can be exercised in a throwaway systemd container. Do **not** run
it against a shared host:

```sh
docker run -d --name t3test --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw ubuntu-with-systemd

docker cp t3-environment.sh t3test:/srv/
# The helper is installed from beside the script when there is one there.
docker cp t3-unit-helper.sh t3test:/srv/
# curl understands file://, so a directory of artifacts is enough of a release host
docker exec t3test sh /srv/t3-environment.sh --base-url file:///srv/artifacts

# Then drive it as the agent does — as the unprivileged service user:
docker exec t3test runuser -u t3env -- /bin/sh -c \
  'sudo -n /opt/t3-environment/libexec/t3-unit-helper stop days-tracker-api'
```

`T3_INSTALL_PREFIX` relocates the install and, as a consequence, skips the
sudoers rule: the helper's paths are fixed.

`T3_INSTALL_PREFIX` and `T3_INSTALL_DATA_DIR` relocate the install for tests.
They are not a supported way to run a real environment: two installs under
different prefixes would still contend for the one unit name, and neither gets a
privileged helper.
