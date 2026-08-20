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
| system user `t3env`                             | uid < 1000, no shell, no password  | yes                      |

Nothing else. No packages are installed, no other unit is touched, and no file
outside those three paths is written.

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

`shellcheck -s sh infra/install/t3-environment.sh` must pass.

The full cycle can be exercised in a throwaway systemd container. Do **not** run
it against a shared host:

```sh
docker run -d --name t3test --privileged --cgroupns=host \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw ubuntu-with-systemd

docker cp t3-environment.sh t3test:/srv/
# curl understands file://, so a directory of artifacts is enough of a release host
docker exec t3test sh /srv/t3-environment.sh --base-url file:///srv/artifacts
```

`T3_INSTALL_PREFIX` and `T3_INSTALL_DATA_DIR` relocate the install for tests.
They are not a supported way to run a real environment: two installs under
different prefixes would still contend for the one unit name.
