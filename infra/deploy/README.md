# Deploy runner

Takes a workspace id and a directory containing a built application, and turns
them into a running, network-restricted service with a reachable local URL.

Sits directly on `infra/host`: that layer decides *who* a workspace is and what
it may touch, this one decides *what runs*, *where it listens* and *what it may
talk to*. Nothing here re-implements the sandbox; the unit template is
inherited, not restated.

| File | Purpose |
| --- | --- |
| `lp-deploy.sh` | The runner. All commands. |
| `lp-deploy-common.sh` | Address/port allocation and the allow-list arithmetic. Sourced. |
| `lp-verify-egress.sh` | Deploys a probe and proves the network filter from inside it. |

## Interface

```sh
lp-deploy.sh up <workspace-id> --from <dir> --command <cmd> [options]
lp-deploy.sh status  <workspace-id>
lp-deploy.sh logs    <workspace-id> [--lines N] [--follow]
lp-deploy.sh start   <workspace-id>
lp-deploy.sh stop    <workspace-id>
lp-deploy.sh restart <workspace-id>
lp-deploy.sh down    <workspace-id> [--keep-data]
lp-deploy.sh list
```

Options for `up`:

| Option | Default | Meaning |
| --- | --- | --- |
| `--from <dir>` | required | Directory containing the built application |
| `--command <cmd>` | required | Start command, run inside the installed app directory |
| `--health-path <path>` | `/` | Path polled to decide the deploy succeeded |
| `--egress <mode>` | `public` | `public` (internet, no loopback/private/host) or `none` |
| `--port <port>` | allocated | Pin the TCP port |
| `--memory-max`, `--tasks-max` | `512M`, `64` | Passed through to provisioning |
| `--max-size-mb <mb>` | `2048` | Refuse builds larger than this |
| `--health-timeout <s>` | `30` | Seconds to wait for the first successful probe |

`up` is idempotent. Re-running against an existing deployment keeps the address
and port it already holds, re-syncs the build, and restarts — so the URL an
operator or a proxy recorded stays valid. `down` is idempotent too: running it
against an already-removed deployment is a no-op, not an error.

### What a deployment gets

| Resource | Value |
| --- | --- |
| Address | One `/32` inside `127.90.0.0/16`, added to `lo` |
| Port | One port in `21000-21999` |
| Build | `/srv/lp-workspaces/lp-<id>/app`, `rsync -a --delete`, owned by the workspace user |
| Entry point | `/srv/lp-workspaces/lp-<id>/run`, generated, `exec`s `--command` inside `app/` |
| Environment | `LP_WORKSPACE_ID`, `LP_BIND_ADDRESS`, `LP_PORT`, `HOST`, `PORT` |
| Network drop-in | `lp-workspace@<id>.service.d/20-network.conf` |

The application **must** bind `LP_BIND_ADDRESS`. A deployment that binds a
wildcard address is stopped and the deploy fails, because on a host with a
public address a wildcard bind is a public service.

There is no allocation database. The drop-in carries `# lp-address=`,
`# lp-port=` and `# lp-egress=` header comments and *is* the record, so an
operator reading `/etc/systemd/system` sees exactly what the scripts see and a
stale registry cannot disagree with a running service.

Nothing runs as root. `up` reads the effective uid out of `/proc/<mainpid>/status`
after the service answers its first request and fails the deploy if it is 0.

### Why each deployment gets its own loopback address

So that "the workspace may talk to itself" and "the workspace may talk to
everything else on this host" stop being the same firewall rule.

The `/32` alias on `lo` is what makes it work in both directions. Without the
alias the kernel routes `127.90.0.1` through the generic `127.0.0.0/8` local
route, whose preferred source is `127.0.0.1` — so an inbound request would
arrive *from* `127.0.0.1` and accepting it would mean allowing all of loopback.
With the alias the route's own source becomes the alias:

```
# before
local 127.90.0.5 dev lo src 127.0.0.1 uid 0
# after `ip addr add 127.90.0.5/32 dev lo`
local 127.90.0.5 dev lo src 127.90.0.5 uid 0
```

One `/32` allow entry then covers ingress from the host and the service talking
to itself, and nothing else on loopback.

## Network egress

The gap the previous wave flagged: a workspace could reach all of `127.0.0.1`,
where this host keeps unauthenticated `garage` (3900-3903), `mediamtx` (8554,
9997), `dufs` file servers, several uvicorn/gunicorn apps and `t3code` itself.

`lp-workspace@.service` now sets `IPAddressDeny=any`, so a workspace with no
network drop-in has no network at all. `lp-deploy.sh` writes back an allow list.

### systemd's IP filter is not longest-prefix-wins

This was assumed while writing the first version of this tooling and it is
wrong. **An address matching any `IPAddressAllow=` entry is permitted outright,
whatever `IPAddressDeny=` says.** The deny list only decides addresses the
allow list did not match, and `systemctl show` will not warn you, because it
reduces each list independently — a narrower deny simply vanishes into a broader
one from the same list.

Measured on the host with transient units:

```
=== control: garage reachable from an unfiltered transient unit ===
(no output — curl succeeded)

=== A: deny any + allow /1s + deny 127/8 ===
(no output — curl succeeded: the deny for 127.0.0.0/8 did nothing)

=== B: no deny-any; allow /1s + deny 127/8 ===
(no output — curl succeeded)

=== C: deny any + allow explicit public prefixes only (1.0.0.0/8) ===
curl: (28) Connection timed out after 4002 milliseconds
--- C2: same unit reaching 1.1.1.1 (must work) ---
(no output — curl succeeded)
```

So "allow everything except X" is not expressible by denying X. X has to be
*absent* from the allow list, which means the allowed space must be enumerated.
`lp_deploy_public_allow_prefixes` computes exactly that: the IPv4 space minus

```
0.0.0.0/8  10.0.0.0/8  100.64.0.0/10  127.0.0.0/8  169.254.0.0/16
172.16.0.0/12  192.0.0.0/24  192.168.0.0/16  198.18.0.0/15
224.0.0.0/4  240.0.0.0/4
```

plus every address configured on this host. That last exclusion matters as much
as loopback: anything bound to `0.0.0.0` here answers on the host's public
address too, so blocking loopback alone would leave the same services one hop
away. On this host the complement is 99 prefixes. Two `/32` holes are then
punched for `127.0.0.53` (the stub resolver — without it nothing resolves) and
the deployment's own address.

`--egress none` writes only the deployment's own `/32`.

IPv6 gets no allow entry at all, so the template's deny covers it. Nothing on
this host listens on IPv6 and a dual-stack client falls back to IPv4.

## Evidence

All output below is real, captured from `164.68.117.31` on 2026-08-08.

### A trivial app, deployed

```
[lp] provisioning workspace 'demo-1'
[lp] free space on /: 67743MB (need 64MB)
[lp] creating system user lp-demo-1
[lp] ensuring workspace directory /srv/lp-workspaces/lp-demo-1
[lp] writing limits drop-in (MemoryMax=128M MemoryHigh=100663296 TasksMax=24)
[lp] address 127.90.0.1, port 21000, egress public
[lp] adding loopback alias 127.90.0.1/32
[lp] free space on /: 67743MB (need 130MB)
[lp] installing build (1MB) into /srv/lp-workspaces/lp-demo-1/app
[lp] starting lp-workspace@demo-1.service
[lp] waiting for http://127.90.0.1:21000/
[lp] healthy
[lp] service runs as lp-demo-1 (uid 995, pid 1269851), not root
[lp] not reachable on the host's public address 164.68.117.31:21000

workspace   demo-1
unit        lp-workspace@demo-1.service
user        lp-demo-1
app         /srv/lp-workspaces/lp-demo-1/app
egress      public
url         http://127.90.0.1:21000
```

```
$ curl -sS http://127.90.0.1:21000/
hello from demo-1 uid=995
```

`uid=995` is reported by the application itself, so the non-root claim is made
by the workload rather than about it.

Two deployments side by side, each on its own address and port:

```
WORKSPACE                ADDRESS        PORT    STATE      URL
demo-1                   127.90.0.1     21000   active     http://127.90.0.1:21000
demo-2                   127.90.0.2     21001   active     http://127.90.0.2:21001
probe-egress             127.90.0.3     21002   active     http://127.90.0.3:21002
probe-sealed             127.90.0.4     21003   active     http://127.90.0.4:21003
```

### Egress is restricted

From `lp-verify-egress.sh probe-egress`. Every line below was produced by the
probe application itself, running under the deployed unit as `lp-probe-egress`.

```
=== IDENTITY ===
uid=993(lp-probe-egress) gid=983(lp-probe-egress) groups=983(lp-probe-egress)
bind address: 127.90.0.3:21002

=== HOST SERVICES ON LOOPBACK AND LOCAL INTERFACES (must be denied) ===
BLOCKED  loopback-service     127.0.0.1:3900      :: exit=28 :: curl: (28) Connection timed out after 4002 milliseconds
BLOCKED  loopback-service     127.0.0.1:3901      :: exit=28 :: curl: (28) Connection timed out after 4001 milliseconds
BLOCKED  loopback-service     127.0.0.1:3903      :: exit=28 :: curl: (28) Connection timed out after 4002 milliseconds
BLOCKED  loopback-service     127.0.0.1:5023      :: exit=28 :: curl: (28) Connection timed out after 4002 milliseconds
BLOCKED  loopback-service     127.0.0.1:5055      :: exit=28 :: curl: (28) Connection timed out after 4003 milliseconds
BLOCKED  loopback-service     127.0.0.1:5056      :: exit=28 :: curl: (28) Connection timed out after 4002 milliseconds
BLOCKED  host-public-address  164.68.117.31:3773  :: exit=28 :: curl: (28) Connection timed out after 4002 milliseconds
BLOCKED  docker-bridge        172.17.0.1:9090     :: exit=28 :: curl: (28) Connection timed out after 4006 milliseconds

=== OWN ADDRESS (must stay reachable — proves the probe is not simply offline) ===
OK       self                 http://127.90.0.3:21002/

=== OUTBOUND INTERNET AND DNS ===
resolve example.com -> 2606:4700:10::6814:179a example.com
OK       public https         https://1.1.1.1/
LP-EGRESS-CHECKS-COMPLETE
```

`127.0.0.1:3900` and `:3903` are `garage` object storage, `:5055`/`:5056` are
`dufs` file servers, `164.68.117.31:3773` is `t3code`, `172.17.0.1:9090` is
reached through the docker bridge. The targets are discovered from `ss -ltn` at
run time rather than hardcoded, so the evidence is about the services this host
is actually running.

The denials only mean something next to two controls. First, the same targets
dialled from a root shell outside the sandbox, in the same run:

```
root shell: loopback-service    127.0.0.1:3900      answered
root shell: loopback-service    127.0.0.1:3901      did not answer (see note)
root shell: loopback-service    127.0.0.1:3903      answered
root shell: loopback-service    127.0.0.1:5023      answered
root shell: loopback-service    127.0.0.1:5055      answered
root shell: loopback-service    127.0.0.1:5056      answered
root shell: host-public-address 164.68.117.31:3773  answered
root shell: docker-bridge       172.17.0.1:9090     answered
```

Seven of the eight answer a plain HTTP GET from root and none of them answer
from inside the deployment. (`3901` is garage's admin port, which does not serve
a bare `GET /`; it is reachable, it just does not reply usefully.) Second, the
probe's own address and the public internet stayed reachable, so nothing was
proved by simply breaking the network.

The failure mode is a silent packet drop — `curl: (28) Connection timed out` —
rather than `EPERM`, because the cgroup BPF filter discards the SYN instead of
rejecting the `connect()`. Worth knowing: a deployed pack that hits a blocked
destination will hang for its own timeout, not fail fast.

Ingress, from the same run:

```
from root shell to 127.90.0.3:21002 -> reachable
from root shell to 127.0.0.1:21002  -> blocked
```

### `--egress none`

Same probe, sealed mode. Everything above still blocked, own address still
reachable, and now DNS is gone too:

```
=== OWN ADDRESS (must stay reachable) ===
OK       self                 http://127.90.0.4:21003/
=== OUTBOUND INTERNET AND DNS ===
resolve example.com -> FAILED
```

### The isolation layer still holds

`infra/host/lp-verify-isolation.sh` was re-run after the unit template change,
against a fresh `iso-a`/`iso-b` pair. Every check the previous wave recorded
still passes — zero capabilities, `NoNewPrivs`, seccomp filter mode, cross-
workspace reads denied, `/root` and `/etc/shadow` denied, `sudo`/`su`/`unshare`
denied, `mount` killed with `exit=159` (`128 + SIGSYS`), writes outside the
workspace denied, writes inside it working, private `/tmp`, 4 visible pids, and
`memory.max` unwritable from inside.

### Teardown

```
[lp] stopping lp-workspace@demo-1.service
[lp] removing loopback alias 127.90.0.1/32
[lp] removing drop-in directory /etc/systemd/system/lp-workspace@demo-1.service.d
[lp] removing user lp-demo-1
[lp] removing workspace directory /srv/lp-workspaces/lp-demo-1
[lp] teardown complete for workspace 'demo-1'
[lp] deployment 'demo-1' removed
```

Re-running is a no-op rather than an error:

```
[lp] no recorded address for 'demo-1'; nothing to unbind
[lp] user lp-demo-1 already absent
[lp] workspace directory /srv/lp-workspaces/lp-demo-1 already absent
```

After removing all four deployments, both isolation workspaces and the scripts
themselves:

```
lp- users:  0
lp- groups: 0
lp- units:  0
lp- procs:  0
lp- paths:  0
loopback aliases: 1: lo    inet 127.0.0.1/8 scope host lo
/srv: chase
ports 21000-21999: none
docker: baserow / baserow_db / grafana / prometheus all Up
services: t3code active, apache2 active, docker active, cloudflared active,
          garage active, ssh active
disk: 290G total, 224G used, 67G available — unchanged
```

The three units in `systemctl --failed` (`days-tracker-api`, `run-u175258`,
`unattended-upgrades`) are pre-existing; `run-u175258` last started
`2026-08-02`, six days before this work.

## What this protects against — and what it does not

### Does protect against

- **Reaching any service on this host.** Loopback, the docker bridges, the
  RFC1918 ranges and the host's own public and IPv6 addresses are all outside
  the allow list, proven from inside a live deployment.
- **Reaching the cloud metadata address.** `169.254.0.0/16` is excluded, which
  covers `169.254.169.254`.
- **One deployment reaching another.** Each holds a single `/32` and no other
  `127.90.x.y` address is allowed to it.
- **Accidentally publishing a service.** A wildcard bind is detected and the
  deploy is failed and stopped rather than reported as successful.
- **Running privileged.** Checked against `/proc`, not assumed from the unit.
- **Filling the disk.** The build is measured before it is copied, the guard
  asks for room for two copies, and anything over 2048MB is refused outright.

### Does NOT protect against

- **Outbound access to the public internet** under `--egress public`. A
  deployment can call anything routable, including scanning other hosts. The
  boundary drawn here is "not this host and not this network", not "only what
  the pack declared". Per-pack allow lists derived from the manifest's
  `permissions.network` are the obvious next step, and would need DNS
  resolution at deploy time plus re-resolution as records change.
- **DNS-based exfiltration.** `127.0.0.53/32` is open, and systemd-resolved will
  forward whatever it is asked to resolve.
- **A pack that binds a unix socket** somewhere shared. The IP filter is an IP
  filter; `AF_UNIX` is untouched by it.
- **Anything the previous layer already does not cover** — kernel exploits, CPU
  starvation, disk quota, journal flooding, or a malicious `run` file. See
  `infra/host/README.md`.
- **The host's own exposure.** `t3code.service` still runs as root, and the
  services on `0.0.0.0` are still on `0.0.0.0`. This work stops *deployments*
  reaching them; it does not fix them.
- **Public exposure of a deployment.** The reported URL is loopback-only. Putting
  a deployment behind the existing `apache2`/`cloudflared` is deliberately out of
  scope — that config belongs to someone else.
- **Telemetry.** The runner emits nothing. `docs/deployment.md` specifies what it
  would have to emit for the maintenance loop to work; none of it is implemented.

## Requirements

Root (for `useradd`, `systemctl` and `ip addr`), systemd with cgroup v2 and BPF
available, `rsync`, `curl`, `ss` and `ip`. The IP filter fails **open** on a
system without BPF cgroup support: systemd logs a warning and the unit still
runs. `lp-verify-egress.sh` is the check that it is actually in force, and it
should be run on any new host before anything real is deployed to it.
