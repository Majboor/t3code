# Per-workspace host isolation

Groundwork for deploying packs onto a shared test host. Each workspace gets a
dedicated unprivileged Linux user, a directory only that user can enter, and a
hardened systemd unit that confines its service. This is the substrate the
later "deploy a pack" work sits on; it deliberately stops short of deciding
_what_ runs or _when_.

## Contents

| File                        | Purpose                                                             |
| --------------------------- | ------------------------------------------------------------------- |
| `lp-common.sh`              | Shared constants, id validation, disk guard. Sourced, not executed. |
| `lp-provision-workspace.sh` | Creates the user, directory, unit template and limits drop-in.      |
| `lp-workspace@.service`     | Hardened systemd template, instantiated per workspace.              |
| `lp-verify-isolation.sh`    | Runs the isolation proofs from inside a live workspace service.     |
| `lp-teardown-workspace.sh`  | Removes exactly what provisioning created.                          |

Everything created on a host carries the `lp-` prefix so an operator with no
knowledge of this project can identify and remove it.

## Usage

```sh
# Provision. Idempotent: safe to re-run, preserves the account's uid.
./lp-provision-workspace.sh acme-web --memory-max 512M --tasks-max 64

# The workspace supplies an executable `run` at the top of its directory.
install -m 0700 -o lp-acme-web -g lp-acme-web ./start.sh /srv/lp-workspaces/lp-acme-web/run
systemctl start lp-workspace@acme-web.service

# Remove everything for one workspace.
./lp-teardown-workspace.sh acme-web
```

The workspace id is the bare name; the `lp-` prefix is applied by the tooling to
derive the user (`lp-acme-web`) and directory (`/srv/lp-workspaces/lp-acme-web`).
Ids are restricted to lowercase alphanumerics and single hyphens, and rejected
if the derived username would exceed the 32-character limit `useradd` enforces.

## What provisioning creates

| Resource       | Value                                        | Notes                                                                             |
| -------------- | -------------------------------------------- | --------------------------------------------------------------------------------- |
| User           | `lp-<id>`                                    | System account (uid < 1000), `/usr/sbin/nologin`, password locked. Cannot SSH in. |
| Group          | `lp-<id>`                                    | Primary group, no other members.                                                  |
| Directory      | `/srv/lp-workspaces/lp-<id>`                 | Mode `0700`, owned by the workspace user.                                         |
| Parent         | `/srv/lp-workspaces`                         | Root-owned `0755`. Traversable, not writable by workspaces.                       |
| Unit template  | `/etc/systemd/system/lp-workspace@.service`  | Shared by all workspaces.                                                         |
| Limits drop-in | `lp-workspace@<id>.service.d/10-limits.conf` | Per-workspace `MemoryHigh`/`MemoryMax`/`TasksMax`.                                |

Workspaces live under `/srv`, not `/home`, because the unit sets
`ProtectHome=yes` — a home-directory workspace would be invisible to its own
service.

## Host inventory (recorded before any changes)

Ubuntu 24.04.2, kernel 6.8.0-78, systemd 255, 6 CPU, 11Gi RAM, cgroup v2
unified with `cpu`, `memory` and `pids` controllers available.

This is not an idle box. It was running **84 services**, including Apache,
`cloudflared` tunnels (~19 of them), `garage` object storage, `mediamtx`,
several FastAPI/Flask/gunicorn apps, and a `t3code.service` headless server on
port 3773. Docker was running four containers: `baserow`, `baserow_db`
(postgres:15), `grafana` and `prometheus`.

Relevant to namespacing: `/home` contained only `deploy` and `t3code`; the only
human account was `deploy` (uid 1000); `/srv` contained only `chase`; and
**nothing in the `lp-` namespace existed**, so the prefix was free.

One thing worth flagging that this work did not touch: the existing
`t3code.service` runs `User=root` with no hardening directives at all. That is
outside the scope of this change, but it is the single largest isolation gap on
the host and the reason a pack deployed as root would be indistinguishable from
the host itself.

## Isolation evidence

Captured from `lp-verify-isolation.sh` against a throwaway pair,
`lp-probe-1786200587` and `lp-neighbour-1786200587`, provisioned with
`--memory-max 256M --tasks-max 32`.

Every check below was executed **by the workspace's own `run` executable, under
the hardened unit**. This matters: running the same commands via `su` from root
would bypass the systemd sandbox entirely and produce a far weaker result that
looked identical.

### Identity and privilege state

```
uid=994(lp-probe-1786200587) gid=984(lp-probe-1786200587) groups=984(lp-probe-1786200587)
CapEff:	0000000000000000
CapBnd:	0000000000000000
NoNewPrivs:	1
Seccomp:	2
Seccomp_filters:	31
```

Zero effective capabilities, zero bounding set, `NoNewPrivs` set, seccomp in
filter mode.

### Cannot read another workspace

A secret file was planted in the neighbour workspace first, so that a denial
could not be explained away as the directory merely being empty.

```
target: /srv/lp-workspaces/lp-neighbour-1786200587
BLOCKED list neighbour workspace :: exit=2 :: ls: cannot open directory '/srv/lp-workspaces/lp-neighbour-1786200587': Permission denied
BLOCKED read neighbour secret :: exit=1 :: cat: /srv/lp-workspaces/lp-neighbour-1786200587/secret.txt: Permission denied
```

### Cannot read /root or /etc/shadow

```
ls /root -> ls: cannot open directory '/root': Permission denied
BLOCKED read /root/.bashrc :: exit=1 :: cat: /root/.bashrc: Permission denied
BLOCKED read shadow file :: exit=1 :: cat: /etc/shadow: Permission denied
```

### Cannot escalate

```
BLOCKED sudo -n id :: exit=1 :: sudo: The "no new privileges" flag is set, which prevents sudo from running as root.
BLOCKED su root :: exit=1 :: Password: su: Authentication failure
BLOCKED unshare user namespace :: exit=1 :: unshare: unshare failed: Operation not permitted
BLOCKED mount over /etc :: exit=159 ::
```

`sudo` names the exact mechanism that stopped it. Exit 159 is `128 + SIGSYS` —
the seccomp filter killing the `mount` attempt rather than merely refusing it.

### Cannot write outside its own directory

```
BLOCKED write /etc :: exit=1 :: touch: cannot touch '/etc/lp-should-not-exist': Read-only file system
BLOCKED write /usr/local/bin :: exit=1 :: touch: cannot touch '/usr/local/bin/lp-should-not-exist': Read-only file system
BLOCKED write /srv/lp-workspaces :: exit=1 :: touch: cannot touch '/srv/lp-workspaces/lp-should-not-exist': Read-only file system
BLOCKED write neighbour workspace :: exit=1 :: touch: cannot touch '/srv/lp-workspaces/lp-neighbour-1786200587/lp-should-not-exist': Permission denied
```

### Can write inside its own directory

```
OK wrote /srv/lp-workspaces/lp-probe-1786200587/lp-write-probe
```

This control matters. Without it, every denial above would also be produced by
a service that was simply broken.

### Private /tmp and process invisibility

```
/tmp contents: []
pids visible in /proc: 4
can read PID 1 cmdline? no
```

Four visible pids on a host running 84 services: the workspace can see only its
own processes.

### Resource limits are real and self-locked

```
cgroup:     /sys/fs/cgroup/system.slice/system-lp\x2dworkspace.slice/lp-workspace@probe-1786200587.service
memory.max: 268435456
memory.high:201326592
pids.max:   32
BLOCKED raise own memory.max :: exit=1 :: tee: '.../memory.max': Read-only file system
```

256M and 32 tasks as requested, read from the kernel rather than from the unit
file, and `ProtectControlGroups=yes` prevents the service from raising its own
ceiling.

### Teardown

```
[lp] stopping lp-workspace@probe-1786200587.service
[lp] removing drop-in directory /etc/systemd/system/lp-workspace@probe-1786200587.service.d
[lp] removing user lp-probe-1786200587
[lp] removing workspace directory /srv/lp-workspaces/lp-probe-1786200587
[lp] teardown complete for workspace 'probe-1786200587'
```

Re-running immediately is a no-op rather than an error:

```
[lp] user lp-probe-1786200587 already absent
[lp] workspace directory /srv/lp-workspaces/lp-probe-1786200587 already absent
```

Post-teardown state: no `lp-` users, no `lp-` groups, no `lp-` units, `/srv`
back to containing only `chase`, no failed units, all four Docker containers
healthy, and the pre-existing services (`t3code`, `apache2`, `docker`,
`cloudflared`, `garage`, `soc-mel-api`) still active. Disk unchanged at 17G
free.

## Disk situation

The root filesystem is at **95% — 290G total, 274G used, ~16.9G available**.
Free space measured identically before and after the full provision/verify/
teardown cycle.

The cause is worth stating plainly, because it drives the recommendation below:

| Consumer                         | Size        |
| -------------------------------- | ----------- |
| Docker images (23)               | 107.8 GB    |
| Docker build cache (159 entries) | 83.4 GB     |
| Docker volumes                   | 1.2 GB      |
| **Docker total**                 | **~192 GB** |

Roughly **70% of the used disk is Docker**, dominated by ~15GB GPU worker
images (`camera-gpu-worker` v1–v6, `splat-gpu-worker` v2–v13). Of that, ~12.9GB
of images and ~24.7GB of build cache are reclaimable.

Implications:

- This tooling is negligible on disk. A workspace is one directory and one
  small drop-in file; the probe cycle moved the free-space figure by under 1MB.
- `LimitCORE=0` is set on the unit specifically so a crashing workspace cannot
  dump a multi-hundred-megabyte core onto a nearly-full disk. Verified: the
  `SIGSYS` kill during testing produced no core file.
- `lp_check_disk` fails provisioning outright below 64MB free rather than
  producing a half-created workspace.
- There is real headroom available (`docker system prune` on build cache alone
  would return ~24GB) but reclaiming it is not this change's business and was
  not done.

## What this protects against — and what it does not

### Does protect against

- **One workspace reading or corrupting another's data.** Two independent
  layers: DAC (`0700`, distinct uid) and the systemd sandbox (`ProtectSystem=strict`
  with a single-path `ReadWritePaths`). Either alone would be sufficient;
  requiring both to fail is the point.
- **A workspace writing anywhere on the host.** The entire hierarchy is
  read-only except its own directory.
- **Privilege escalation via setuid binaries.** `NoNewPrivileges=yes` plus an
  empty `CapabilityBoundingSet` neuters `sudo`, `su`, `mount` and `pkexec`.
- **Reading host secrets** in `/root`, `/home`, or `/etc/shadow`.
- **Reconnaissance.** `ProtectProc=invisible` hides the other 84 services'
  existence, command lines and environments.
- **Reaching anything on the network.** `IPAddressDeny=any` means a workspace
  with no deploy drop-in cannot send or receive an IP packet at all. A
  deployment re-opens a specific allow list; `infra/deploy/README.md` carries
  the evidence, including the finding that an `IPAddressAllow=` entry beats
  `IPAddressDeny=` outright regardless of prefix length, so exclusions must be
  expressed as gaps in the allow list rather than as denies.
- **Resource starvation.** `MemoryMax`/`TasksMax` are enforced by the kernel and
  cannot be raised from inside.
- **Accidental persistence.** Teardown is proven to remove the account, group,
  directory, drop-in and unit.

### Does NOT protect against

- **Kernel exploits.** Every workspace shares one kernel. `RestrictNamespaces`
  and the seccomp filter shrink the attack surface, but a kernel LPE defeats
  this model completely. This is the fundamental ceiling of the approach and no
  amount of unit hardening changes it.
- **Outbound access to the public internet**, for a workspace whose deploy
  drop-in allows it. The unit itself sets `IPAddressDeny=any`, so a bare
  workspace has no network at all — see below. A deployment made from a pack
  gets only the hosts its manifest declared; one made with `--egress public`
  gets everything routable, and there the boundary is "not this host and not
  this network" rather than "only what the pack declared".
- **CPU starvation.** Only memory and tasks are capped. `CPUQuota=` is not set,
  so a busy loop can still degrade a 6-CPU box shared with 84 services.
- **Disk exhaustion.** No quota. A workspace can write until `/` is full, which
  on a 95%-full disk is a short trip. Needs filesystem quotas or a per-workspace
  loopback volume.
- **Journal flooding.** A chatty workspace consumes shared journald capacity.
  `StartLimitBurst` bounds crash-looping, not deliberate logging.
- **Anything root does.** These are unprivileged confinements. Provisioning and
  teardown both require root, and the deploy layer above will too.
- **A malicious `run` file.** The workspace fully controls its own executable.
  The sandbox bounds what that executable can reach; it does not vet it.

## Docker vs systemd for this use case

**Recommendation: stay with the systemd path on this host. Move to containers
when workspaces need to bring their own dependencies, and only after the disk
is reclaimed.**

The honest comparison, given Docker is already installed:

**Isolation strength — containers win, but by less than the reputation suggests.**
A default `docker run` shares the kernel exactly as systemd services do, and
runs as root inside the container unless configured otherwise. The hardened
unit above already has zero capabilities, seccomp filtering, a read-only
filesystem, PID hiding and a locked cgroup — a default container has _fewer_ of
those, not more. Docker's genuine advantages are filesystem namespacing (a
workspace sees only its own root, no host paths at all) and easy per-container
network isolation, which was the gap identified above and has since been
closed within systemd instead. But a container
configured to match this unit's guarantees requires `--cap-drop=ALL
--security-opt=no-new-privileges --read-only --user`, which is roughly the same
amount of configuration, just expressed differently.

**Disk cost — systemd wins decisively, and this is the deciding factor.**
Docker is already consuming ~192GB and is the direct reason the disk sits at
95%. A workspace under this scheme costs a directory and a ~200-byte drop-in.
A containerised workspace costs a base image layer at minimum; even Alpine-based
images plus per-workspace layers would add gigabytes across a handful of
workspaces. With ~16.9G free, adding an image-per-pack workflow is how the box
runs out of disk. Reclaiming ~24GB of build cache would relieve but not reverse
this.

**Operational complexity — closer than expected, with systemd ahead here.**
The box's 84 existing services are all systemd units, so this model matches how
the host is already operated and administered: `systemctl status`, `journalctl
-u`, and standard cgroup accounting all work with no new tooling. Containers
add image build/registry/pull steps, a daemon in the failure path, and log
plumbing that does not go to journald by default. Against that, containers give
genuinely better dependency isolation — under systemd every workspace shares
the host's Node, Python and system libraries, which becomes painful the moment
two packs need different runtime versions.

**The deciding trade-off.** Containers are the better answer _in general_, and
if this host had 200G free I would recommend them without much hesitation —
chiefly for network isolation and dependency independence. On _this_ host, with
17G free and Docker already the reason it is full, provisioning a container per
workspace is the wrong tool. The systemd path delivers most of the isolation
value at essentially zero disk cost, and its two real gaps (network, disk quota)
were both closable within systemd; network egress has since been closed via
`IPAddressDeny=` plus a computed allow list (see `infra/deploy/`), leaving
filesystem quotas.

Revisit if any of these becomes true: workspaces need conflicting runtime
versions; the disk is reclaimed to comfortable headroom; or per-pack egress
allow lists outgrow what `IPAddressAllow=` can express and a full network
namespace per workspace is required anyway.
