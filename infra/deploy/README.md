# Deploy runner

Takes a workspace id and a `.pack` directory, and turns them into a running,
network-restricted service with a reachable local URL — and an event stream that
says what happened to it.

Sits directly on `infra/host`: that layer decides _who_ a workspace is and what
it may touch, this one decides _what runs_, _where it listens_, _what it may
talk to_ and _what it reports_. Nothing here re-implements the sandbox; the unit
template is inherited, not restated.

What starts it, where it listens and what it may reach come out of the
manifest's `runtime`, `interfaces` and `permissions` sections. They are not
restated on the command line, and a manifest this host cannot honour is refused
rather than deployed weaker than it declares.

| File                                           | Purpose                                                                                             |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `lp-deploy.sh`                                 | The runner. All commands.                                                                           |
| `lp-deploy-common.sh`                          | Address/port allocation, allow-list arithmetic, the observation table and the timer units. Sourced. |
| `lp-pack.sh`                                   | Reads `pack.json`, derives the deploy, and refuses what cannot be honoured. Sourced.                |
| `lp-telemetry.sh`                              | The event envelope, the ULIDs, the per-deployment event file. Sourced.                              |
| `lp-heartbeat.sh`                              | One telemetry tick: heartbeat, health, run boundaries, denials, silence.                            |
| `lp-heartbeat@.service`, `lp-heartbeat@.timer` | Unit templates for the tick. Installed with `@LP_DEPLOY_DIR@` substituted.                          |
| `lp-verify-egress.sh`                          | Deploys a probe and proves the network filter from inside it.                                       |
| `lp-verify-pack-telemetry.sh`                  | Deploys a throwaway pack and proves the manifest path and the telemetry end to end.                 |

## Interface

```sh
lp-deploy.sh up <workspace-id> --pack <dir.pack> [options]
lp-deploy.sh up <workspace-id> --from <dir> --command <cmd> [options]
lp-deploy.sh plan    --pack <dir.pack> [--env-file <file>]
lp-deploy.sh status  <workspace-id>
lp-deploy.sh logs    <workspace-id> [--lines N] [--follow]
lp-deploy.sh events  <workspace-id> [--lines N]
lp-deploy.sh start   <workspace-id>
lp-deploy.sh stop    <workspace-id>
lp-deploy.sh restart <workspace-id>
lp-deploy.sh down    <workspace-id> [--keep-data]
lp-deploy.sh list
```

Options for `up`:

| Option                           | Default                                      | Meaning                                                                                                        |
| -------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--pack <dir>`                   | required                                     | A `.pack` directory. Its `pack.json` decides the rest.                                                         |
| `--from <dir>` `--command <cmd>` | —                                            | The manifest-less alternative: a built directory and an explicit start command                                 |
| `--env-file <file>`              | none                                         | `KEY=VALUE` lines for the service. Every `requirements.environment` entry marked `required` must appear here.  |
| `--environment <env>`            | `development`                                | `production`, `preview` or `development`; travels in every event                                               |
| `--service <id>`                 | first                                        | Which `runtime.services` entry owns the address and port                                                       |
| `--health-path <path>`           | the service's `healthPath`, else `/`         | Overrides what the manifest declared                                                                           |
| `--egress <mode>`                | `pack` with `--pack`, `public` with `--from` | `pack` (what `permissions.network` declares), `public` (anywhere routable, no loopback/private/host) or `none` |
| `--port <port>`                  | allocated, or the manifest's `fixed` port    | Pin the TCP port                                                                                               |
| `--memory-max`, `--tasks-max`    | `512M`, `64`                                 | Passed through to provisioning                                                                                 |
| `--max-size-mb <mb>`             | `2048`                                       | Refuse builds larger than this                                                                                 |
| `--health-timeout <s>`           | `30`                                         | Seconds to wait for the first successful probe                                                                 |
| `--heartbeat-interval <s>`       | `60`                                         | Telemetry cadence, and the unit silence is counted in                                                          |

`plan` reads a manifest, prints every decision it implies, and changes nothing —
it does not even require root, because "would this host take this pack" is a
question worth answering before there is a host to answer it on.

`up` is idempotent. Re-running against an existing deployment keeps the address
and port it already holds, re-syncs the build, and restarts — so the URL an
operator or a proxy recorded stays valid. `down` is idempotent too: running it
against an already-removed deployment is a no-op, not an error.

### What the manifest decides

| Manifest field                                        | What the runner does with it                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `runtime.commands.start`                              | Becomes the generated `run` file's `exec` line. Its `cwd` is the directory that line runs in. |
| `runtime.target`, `runtime.versionRange`              | Checked against the host's interpreter, and recorded in every event's `conditions.runtime`    |
| `runtime.services[].binding`                          | `environment` sets that variable to the allocated port; `fixed` pins it; `dynamic` is refused |
| `runtime.services[].healthPath`                       | The path `up` polls, and the path the timer keeps polling afterwards                          |
| `permissions.network[].host`                          | Resolved to addresses at deploy time; those addresses are the entire allow list               |
| `requirements.environment[].required`                 | Must be supplied through `--env-file` or the deploy is refused                                |
| `identity.id`, `identity.version`, `visibility.scope` | Attribution on every event                                                                    |
| every file in the directory                           | Hashed into `contentDigest`, which is what a finding actually lands on                        |

### What a deployment gets

| Resource          | Value                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------- |
| Address           | One `/32` inside `127.90.0.0/16`, added to `lo`                                                                 |
| Port              | One port in `21000-21999`                                                                                       |
| Build             | `/srv/lp-workspaces/lp-<id>/app`, `rsync -a --delete`, owned by the workspace user                              |
| Entry point       | `/srv/lp-workspaces/lp-<id>/run`, generated, `exec`s the manifest's start command                               |
| Environment       | `LP_WORKSPACE_ID`, `LP_BIND_ADDRESS`, `LP_PORT`, `HOST`, `PORT`, the manifest's port variable, and `--env-file` |
| Network drop-in   | `lp-workspace@<id>.service.d/20-network.conf`                                                                   |
| Telemetry         | `/var/lib/lp-telemetry/<id>/events.ndjson`, root-owned `0600`, outside the workspace                            |
| Timer             | `lp-heartbeat@<id>.timer`, with the cadence in a generated drop-in                                              |
| Observation table | `nft` table `inet lp_egress_<id>`, log-only, matched on the workspace's uid                                     |

The pack cannot read or write its own event file. That is deliberate: an event
attributed to a pack digest is worth nothing if the pack could have written it.

The application **must** bind `LP_BIND_ADDRESS`. A deployment that binds a
wildcard address is stopped and the deploy fails, because on a host with a
public address a wildcard bind is a public service.

There is no allocation database. The drop-in carries `# lp-address=`,
`# lp-port=`, `# lp-egress=`, `# lp-health-path=`, `# lp-egress-hosts=`,
`# lp-pack-id=`, `# lp-content-digest=` and `# lp-start-digest=` header comments
and _is_ the record, so an operator reading `/etc/systemd/system` sees exactly
what the scripts see and a stale registry cannot disagree with a running
service. The timer reads the same header rather than keeping its own copy, which
is why a deployment torn down underneath it produces silence and not a wrong
event.

Nothing runs as root. `up` reads the effective uid out of `/proc/<mainpid>/status`
after the service answers its first request and fails the deploy if it is 0.

### Why each deployment gets its own loopback address

So that "the workspace may talk to itself" and "the workspace may talk to
everything else on this host" stop being the same firewall rule.

The `/32` alias on `lo` is what makes it work in both directions. Without the
alias the kernel routes `127.90.0.1` through the generic `127.0.0.0/8` local
route, whose preferred source is `127.0.0.1` — so an inbound request would
arrive _from_ `127.0.0.1` and accepting it would mean allowing all of loopback.
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

`lp-workspace@.service` sets `IPAddressDeny=any`, so a workspace with no
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
_absent_ from the allow list, which means the allowed space must be enumerated.
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

### `--egress pack`: what the manifest declared, and nothing else

The default for `--pack`. Every `permissions.network[].host` is resolved at
deploy time and each resulting address becomes one allow entry — `/32` for A
records, `/128` for AAAA. The stub resolver is added only if something was
declared; a pack that declares no egress gets none, not even DNS.

```
IPAddressAllow=104.20.23.154/32
IPAddressAllow=172.66.147.243/32
IPAddressAllow=2606:4700:10::6814:179a/128
IPAddressAllow=2606:4700:10::ac42:93f3/128
IPAddressAllow=127.0.0.53/32
IPAddressAllow=127.90.0.1/32
```

Six entries for one declared host, against 101 for `--egress public`.

AAAA records are in the list for a reason found by measurement rather than
design: a dual-stack client tries IPv6 first, so an IPv4-only allow list made a
pack's own declared destination fail once per connection before falling back —
producing a stream of `egress.denied` events for a host the manifest declared.
That reading of the event is the expensive one to get wrong.

The allow list is exactly as durable as the DNS records behind it. It is
resolved once, at deploy time, and a record that moves afterwards produces
denials for a declared host — which is visible, because `egress.denied` re-checks
the declared names at emission time and marks that case `declaredInManifest:
true`. A redeploy re-resolves.

IPv6 under `public` and `none` gets no allow entry at all, so the template's
deny covers it. Nothing on this host listens on IPv6 and a dual-stack client
falls back to IPv4.

### What is refused rather than deployed weaker

A manifest declares what a pack may do. Deploying one whose declarations this
host cannot honour would run it with weaker guarantees than it claims, and then
attribute its telemetry to a configuration nobody chose. So these fail the
deploy, all of them reported at once with the field named:

| Declaration                                                          | Why it cannot be honoured                                                                                    |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `runtime.target: container`                                          | The sandbox is a systemd unit, not a container runtime                                                       |
| `runtime.target` with a missing interpreter                          | Nothing would start                                                                                          |
| `runtime.versionRange` unsatisfied by the host                       | Only the `>=X.Y` form is actually checked; anything else is reported as unverified                           |
| `runtime.services[].binding: dynamic`                                | The port has to be known to probe it and to hand out a URL                                                   |
| Two or more `runtime.services` and no `--service`                    | One deployment gets one address and one port                                                                 |
| `permissions.network` with a `*.` wildcard                           | The filter matches addresses; a wildcard cannot be enumerated. `--egress public` is the deliberate override. |
| A declared host that does not resolve                                | No allow entry can be written for it                                                                         |
| `permissions.elevated` (any entry)                                   | Empty capability bounding set, `NoNewPrivileges`, seccomp, no docker socket                                  |
| `permissions.filesystem` rooted at `home`, `workspace` or `absolute` | `ProtectHome=yes` and a read-only host                                                                       |
| A required `requirements.environment` entry not supplied             | A missing requirement is an install defect, and the contract classes it as unrepairable                      |
| `requirements.services` whose `connectionEnvVar` is unset            | This runner provisions no databases or queues                                                                |
| `requirements.packs`                                                 | It deploys one pack and resolves no pack graph                                                               |
| `requirements.toolchain` not on the host                             | It would fail later, less clearly                                                                            |

One thing is **warned about rather than refused**: `permissions.network[].ports`.
systemd's IP filter matches addresses only, so a declared host is reachable on
every port. Refusing every manifest that names a port would refuse almost all of
them, and the gap is in the enforcement layer rather than in the pack — so the
deploy says so, and `deployment.provisioned` carries
`portRestrictionsEnforced: false` so a consumer of the telemetry sees it too.

## Telemetry

`docs/deployment.md` specifies the contract. This layer implements tier 1 of it:
the events derivable from the runner and the supervisor with no cooperation from
the pack.

Events are newline-delimited JSON in `/var/lib/lp-telemetry/<id>/events.ndjson`,
root-owned, one file per deployment, appended under `flock` because the runner
and the timer both write. There is no network sink and no server endpoint —
the contract says a deployment buffers to disk and replays, and disk is the half
that has to exist before a collector can.

| Event                    | Emitted by                                                           | When                                                            |
| ------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `deployment.provisioned` | runner                                                               | Once the user, address, port, filter and build exist            |
| `deployment.started`     | runner, and the timer for a restart nobody asked for                 | Every process start; a new `deploymentRunId` each time          |
| `deployment.healthy`     | runner, then the timer                                               | First successful probe, and every recovery from unhealthy       |
| `deployment.unhealthy`   | runner, then the timer                                               | A failed probe, with `consecutiveFailures` and `unhealthyForMs` |
| `deployment.stopped`     | runner for `stop`/`restart`/`down`, timer for a crash or an OOM kill | `reason` is `operator`, `redeploy`, `crash`, `oom` or `removed` |
| `deployment.removed`     | runner                                                               | `down`, before the deployment's resources go                    |
| `deployment.heartbeat`   | timer                                                                | Every interval while active                                     |
| `deployment.went_quiet`  | timer                                                                | Three missed intervals                                          |
| `egress.denied`          | timer                                                                | Aggregated per destination since the last tick                  |

Attribution is by `contentDigest` — a SHA-256 over every file in the pack — on
every event, exactly as the contract requires and for the reason it gives:
a version is a promise about behaviour, and a finding attributed to a version
can land on code that never ran. `packId` and `version` travel too;
a manifest-less `--from` deployment carries a digest with both set to `null`.

### The events that need something running to notice them

The timer unit is separate from the deployment's unit and outlives it. That is
the whole design: a crash, an OOM kill and silence are the three most
interesting things a deployment can do, and it cannot report any of them itself.

`deployment.went_quiet` is synthesised on this side rather than left to a
control plane, because a file of newline-delimited JSON has no clock. Nothing
downstream can tell a deployment that stopped emitting from one that was never
deployed unless something here notices the gap and writes it down. The tick
compares now against the last heartbeat, and reports once per gap.

### `egress.denied`, and how the destination is recovered

The previous wave recorded this event as unavailable: the cgroup BPF filter
discards a denied packet silently, with no `EPERM`, no log line, and a byte
counter that does not name a destination. `docs/deployment.md` named the two
possible fixes; this is the second, a netfilter log rule.

It works because of hook order. `NF_INET_LOCAL_OUT` fires in `__ip_local_out`,
and the cgroup egress program runs later, in `ip_output`. A rule at the output
hook therefore sees the SYN the filter is about to drop:

```
table inet lp_egress_<id> {
  set allowed4 { type ipv4_addr; flags interval; elements = { ... } }
  set allowed6 { type ipv6_addr; flags interval; elements = { ... } }
  chain observe {
    type filter hook output priority filter; policy accept;
    meta skuid 995 ip  daddr @allowed4 return
    meta skuid 995 ip6 daddr @allowed6 return
    meta skuid 995 tcp flags syn / fin,syn,rst,ack limit rate 10/second burst 5 packets log prefix "lp-egress-deny <id>: " level info
  }
}
```

Four properties worth stating:

- The allowed sets are fed the _same_ prefix list that goes into
  `IPAddressAllow=`, so the set that decides what is reported as denied and the
  set that decides what is permitted cannot drift apart.
- The chain's policy is `accept` and it contains no verdict beyond `return`. It
  observes; it never decides. Enforcement stays in one place.
- `limit rate` exists because a pack in a reconnect loop must not become a
  logging denial of service against a host running 84 other services.
- `count` is SYNs, TCP retransmits included — one blocked `connect()` typically
  shows up as four. It is a measure of how hard the pack is trying, not of how
  many calls it made.

`declaredInManifest` is what separates the two readings of the event. The
declared hosts are re-resolved at emission time, so a destination that is in the
manifest but not in the allow list — a record that moved — reports `true`, which
is a requirements signal with an obvious repair. Anything else reports `false`,
which is a security signal.

## Evidence

All output below is real, captured from `164.68.117.31` on 2026-08-08.

### A pack, deployed

From `lp-verify-pack-telemetry.sh packprobe-1786212676`, which builds a
throwaway `.pack` in a temp directory and deploys it through `lp-deploy.sh`.

`plan` first — every line of it derived from `pack.json`, none of it passed in:

```
pack        lp-packprobe 0.1.0 (pack_lp_packprobe, format 2.0)
digest      sha256:30b6a027616d0b4adccd99cd6e753361168407dc2d23a5df23a33fb204ab2542
interfaces  api:probe-api
runtime     node >=20 (host has 22.22.1)
start       node server.js
cwd         app/
service     web, binding environment via PORT
health      /healthz
egress      pack
  allow     example.com                              104.20.23.154
  allow     example.com                              172.66.147.243
  allow     example.com                              2606:4700:10::6814:179a
  allow     example.com                              2606:4700:10::ac42:93f3
plan only: nothing on this host was changed
```

The same pack with four declarations changed to things this host cannot give:

```
[lp] ERROR: this host cannot honour 4 declaration(s) in .../unhonourable.pack/pack.json:
[lp]   - runtime.services[web].binding is 'dynamic': this runner has to know the port to health-probe it and to hand out a URL, and a runtime-chosen port cannot be discovered from outside the sandbox
[lp]   - permissions.network declares the wildcard host '*.stripe.com'. The sandbox filters by address, so a declared host is resolved to addresses at deploy time and a wildcard cannot be enumerated. Deploy it deliberately with --egress public (the coarser 'anywhere public' list) if that is what you mean.
[lp]   - permissions.elevated declares 'docker-socket': the workspace unit runs with an empty capability bounding set, NoNewPrivileges, a seccomp filter and no docker socket, so this cannot be granted
[lp]   - permissions.filesystem asks for an 'absolute' path: the host is mounted read-only apart from the deployment's own directory
[lp] refusing to deploy: running it anyway would give it weaker guarantees than its own manifest declares
```

And the deploy:

```
[lp] address 127.90.0.1, port 21000, egress pack
[lp] adding loopback alias 127.90.0.1/32
[lp] egress observation active (nft table lp_egress_packprobe_1786212676)
[lp] installing build (1MB) into /srv/lp-workspaces/lp-packprobe-1786212676/app
[lp] installed 2 environment values from /tmp/lp-packprobe-.../probe.env
[lp] starting lp-workspace@packprobe-1786212676.service
[lp] waiting for http://127.90.0.1:21000/healthz
[lp] healthy
[lp] service runs as lp-packprobe-1786212676 (uid 995, pid 1570667), not root
[lp] not reachable on the host's public address 164.68.117.31:21000
[lp] telemetry every 15s; silence reported after 3 missed ticks

workspace   packprobe-1786212676
pack        lp-packprobe 0.1.0 (pack_lp_packprobe)
digest      sha256:30b6a027616d0b4adccd99cd6e753361168407dc2d23a5df23a33fb204ab2542
interfaces  api:probe-api
egress      pack
telemetry   /var/lib/lp-telemetry/packprobe-1786212676/events.ndjson
url         http://127.90.0.1:21000
```

### The declared egress was applied

The probe pack declares exactly one host, `example.com`, and dials two
destinations on a timer: that one, and one it never declared. Both lines below
were printed by the workload itself, running under the deployed unit:

```
declared REACHED example.com:80 in 21ms
undeclared BLOCKED 127.0.0.1:3900 (timed out after 4002ms)
declared REACHED example.com:80 in 8ms
undeclared BLOCKED 127.0.0.1:3900 (timed out after 4005ms)
declared REACHED example.com:80 in 15ms
undeclared BLOCKED 127.0.0.1:3900 (timed out after 4001ms)
```

`127.0.0.1:3900` is `garage` object storage. The block only means something next
to its control — the same destination from a root shell, in the same run:

```
root shell -> 127.0.0.1:3900           answered
root shell -> 127.0.0.1:3900           tcp connect succeeded
```

So the target was up and answering throughout, and the declared destination was
reachable from inside at the same time — the denial is the filter, not a dead
service and not a broken network. Ingress, same run:

```
from root shell to 127.90.0.1:21000 -> reachable
from root shell to 127.0.0.1:21000  -> blocked
```

### The event stream

The literal file, payloads only, from the run above. Every event also carries
the envelope, the `PackRef`, the `DeploymentRef` and the `Conditions` block —
one full line is shown after the summary.

```
 1 deployment.provisioned {"uid":995,"unit":"lp-workspace@packprobe-1786212676.service","memoryMaxBytes":268435456,"tasksMax":32,"egressMode":"pack","allowedPrefixCount":6,"buildSizeBytes":4206,"declaredHostCount":1,"portRestrictionsEnforced":true}
 2 deployment.started     {"deploymentRunId":"run_01KZH951PJPKVC82FW78D0HMWX","startCommandDigest":"bc6e2259...","bindAddress":"127.90.0.1","port":21000,"coldStartMs":null,"isRedeploy":false,"observedBy":"runner"}
 3 deployment.healthy     {"probePath":"/healthz","statusCode":200,"timeToHealthyMs":329,"attempts":1}
 4 deployment.heartbeat   {"uptimeSeconds":18,"memoryCurrentBytes":9019392,"tasksCurrent":11,"ipIngressBytes":1188,"ipEgressBytes":1190,"restartsSinceStart":0}
 5 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":4,"declaredInManifest":false,"observedBy":"netfilter-log"}
 6 deployment.heartbeat   {"uptimeSeconds":33,"memoryCurrentBytes":9277440,"tasksCurrent":11,"ipIngressBytes":2346,"ipEgressBytes":2469,"restartsSinceStart":0}
 7 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":8,"declaredInManifest":false,"observedBy":"netfilter-log"}
 8 deployment.stopped     {"reason":"crash","exitCode":null,"signal":9,"uptimeSeconds":33}
 9 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":4,"declaredInManifest":false,"observedBy":"netfilter-log"}
10 deployment.started     {"deploymentRunId":"run_01KZH96ZFNVG8P3ZE4AT962NGD","startCommandDigest":"bc6e2259...","bindAddress":"127.90.0.1","port":21000,"coldStartMs":null,"isRedeploy":false,"restartsTotal":1,"observedBy":"supervisor-restart"}
11 deployment.heartbeat   {"uptimeSeconds":10,"memoryCurrentBytes":8880128,"tasksCurrent":7,"ipIngressBytes":0,"ipEgressBytes":0,"restartsSinceStart":1}
12 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":1,"declaredInManifest":false,"observedBy":"netfilter-log"}
13 deployment.heartbeat   {"uptimeSeconds":24,"memoryCurrentBytes":8994816,"tasksCurrent":11,"ipIngressBytes":1158,"ipEgressBytes":1279,"restartsSinceStart":1}
14 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":7,"declaredInManifest":false,"observedBy":"netfilter-log"}
15 deployment.heartbeat   {"uptimeSeconds":33,"memoryCurrentBytes":9170944,"tasksCurrent":11,"ipIngressBytes":1940,"ipEgressBytes":2126,"restartsSinceStart":1}
16 egress.denied          {"destination":{"host":null,"address":"127.0.0.1","port":3900},"deniedBy":"ip-filter","count":4,"declaredInManifest":false,"observedBy":"netfilter-log"}
17 deployment.stopped     {"reason":"operator","exitCode":0,"signal":null,"uptimeSeconds":33}
18 deployment.went_quiet  {"lastHeartbeatAt":"2026-08-08T18:12:47.000Z","missedIntervals":3,"intervalSeconds":15,"unitState":"inactive","synthesisedBy":"deployment-host"}
19 deployment.removed     — emitted during the teardown that followed, which then deleted the file
```

`down` prints the path and the event count before it removes anything, and
`--keep-data` keeps the file. From a run that did:

```
[lp] telemetry for 'packprobe-removed-1786212342' is at /var/lib/lp-telemetry/.../events.ndjson
deployment.stopped  {"reason":"removed","exitCode":0,"signal":null,"uptimeSeconds":2}
deployment.removed  {"uptimeTotalSeconds":2,"restartsTotal":0,"reason":"operator"}
```

Events 8 and 10 are the interesting pair. The main process was killed with
`SIGKILL` by the verification script; no runner was involved, nothing asked for
a restart, and both the stop (`reason: crash`, `signal: 9`) and the new run were
recorded by the timer, under a new `deploymentRunId`. Event 18 is the one that
is an absence: the service was stopped at 18:12:47 and nothing emitted for three
intervals, so the tick reported the silence.

`deployment.unhealthy` does not appear here because the probe never failed while
the service was up. From an earlier run of the same script, where a tick caught
the service mid-shutdown:

```
deployment.unhealthy   {"probePath":"/healthz","lastStatusCode":null,"consecutiveFailures":1,"unhealthyForMs":0}
```

One full line, to show the envelope every event carries:

```jsonc
{
  "schemaVersion": "1.0",
  "eventId": "evt_01KZH95221E8Y8PQY9WPGQ370H",
  "type": "deployment.healthy",
  "occurredAt": "2026-08-08T18:11:21.803Z",
  "receivedAt": null,
  "sequence": 3,
  "pack": {
    "packId": "pack_lp_packprobe",
    "version": "0.1.0",
    "contentDigest": "sha256:30b6a027616d0b4adccd99cd6e753361168407dc2d23a5df23a33fb204ab2542",
    "formatVersion": "2.0",
    "derivedFrom": null,
    "installId": "inst_f71d0e731c31",
    "mutations": { "count": 0, "digest": null, "lastAppliedAt": null },
  },
  "deployment": {
    "deploymentId": "dep_01KZH95139846JA1YYW0DYTMSG",
    "deploymentRunId": "run_01KZH951PJPKVC82FW78D0HMWX",
    "workspaceKeyId": "wsk_cec3ec133da6",
    "environment": "development",
    "visibility": "workspace",
    "runtimeHost": "logicpacks-managed",
    "sdkVersion": null,
    "firstSeenAt": "2026-08-08T18:11:20.000Z",
    "ageDays": 0,
  },
  "conditions": {
    "providers": [],
    "runtime": {
      "language": "node",
      "languageVersion": "22.22.1",
      "os": "linux",
      "arch": "x64",
      "containerized": false,
    },
    "dependencies": [],
    "agent": { "role": "installer", "provider": "unknown", "model": "unknown" },
    "surface": "logicpacks",
    "locale": "unknown",
    "timezone": "Europe/Berlin",
  },
  "payload": { "probePath": "/healthz", "statusCode": 200, "timeToHealthyMs": 329, "attempts": 1 },
}
```

### The manifest-less path still works

`lp-verify-egress.sh`, unchanged from the previous wave, was re-run against a
`--from`/`--command` deployment. Every denial and every control it recorded
still holds. Such a deployment also emits tier-1 events, with `packId` and
`version` null and a real `contentDigest`:

```
{"packId":null,"version":null,"contentDigest":"sha256:7b03973c197ffdf8bc7da06f2ff9a4f6204e795f9e2c1e9d4f48e2f2818a6f3e",
 "formatVersion":null,"derivedFrom":null,"installId":"inst_74ba12e6a6ac",
 "mutations":{"count":0,"digest":null,"lastAppliedAt":null}}
```

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

Everything a deploy created, including the three things this wave added — the
timer drop-in, the observation table and the telemetry directory:

```
[lp] telemetry for 'packprobe-1786212676' is at /var/lib/lp-telemetry/packprobe-1786212676/events.ndjson (19 events)
[lp] removing timer drop-in directory /etc/systemd/system/lp-heartbeat@packprobe-1786212676.timer.d
[lp] removing egress observation table inet lp_egress_packprobe_1786212676
[lp] removing loopback alias 127.90.0.1/32
[lp] removing drop-in directory /etc/systemd/system/lp-workspace@packprobe-1786212676.service.d
[lp] removing user lp-packprobe-1786212676
[lp] removing workspace directory /srv/lp-workspaces/lp-packprobe-1786212676
[lp] teardown complete for workspace 'packprobe-1786212676'
[lp] removing telemetry directory /var/lib/lp-telemetry/packprobe-1786212676
[lp] removing shared unit /etc/systemd/system/lp-heartbeat@.service (no deployments left)
[lp] removing shared unit /etc/systemd/system/lp-heartbeat@.timer (no deployments left)
[lp] deployment 'packprobe-1786212676' removed
```

The shared timer templates and `/var/lib/lp-telemetry` itself are removed once
no deployment is left that could use them, so a host with nothing deployed
carries none of this. `--keep-data` keeps the workspace directory _and_ the
event file — the events are the deployment's record, and deleting them by
default while keeping the build would be the wrong half to save.

The earlier form, for a deployment with no manifest and no telemetry:

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

Re-confirmed after this wave, which additionally checks the two further kinds
of host state a deployment can leave behind:

```
lp- users: 0   lp- groups: 0   lp- units: 0   lp- procs: 0
/srv: chase          /var/lib/lp-*: gone      loopback: 127.0.0.1/8
nft tables: table ip nat; table ip filter; table ip6 nat; table ip6 filter; table ip raw
nft lp tables: 0     ports 21000-21999: 0
disk: 290G total, 224G used, 67G available — unchanged
```

The five `nft` tables are the pre-existing `iptables-nft` ones belonging to
docker and the host's own firewall; none was read, written or reloaded. The
observation tables this tooling adds are separate `inet lp_egress_<id>` tables,
which is why removing one cannot disturb them.

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
- **Reaching anything the manifest did not declare**, under the default
  `--egress pack`. The allow list is the declared hosts and nothing else.
- **A pack forging its own telemetry.** The event file is root-owned and outside
  the workspace; the deployment cannot read or append to it.
- **Silently running weaker than declared.** A manifest asking for something
  this host cannot honour fails the deploy with the field named.

### Does NOT protect against

- **Outbound access to the public internet** under `--egress public`. A
  deployment can call anything routable, including scanning other hosts. That
  mode is now the deliberate override rather than the default — the default for
  a pack is its own declared list — but the override still draws the boundary at
  "not this host and not this network".
- **A declared host whose DNS record moves.** The allow list is resolved once, at
  deploy time. The pack then gets denials for something it declared; those are
  visible as `egress.denied` with `declaredInManifest: true`, and the fix is a
  redeploy. Re-resolving on a timer would need the allow list to be rewritten
  and the unit reloaded under a running deployment, which is not done here.
- **Per-port egress rules.** `permissions.network[].ports` is not enforceable
  by systemd's address filter, so a declared host is reachable on every port.
  Warned at deploy and recorded as `portRestrictionsEnforced: false`.
- **DNS-based exfiltration.** `127.0.0.53/32` is open whenever anything is
  declared, and systemd-resolved will forward whatever it is asked to resolve.
- **A pack that binds a unix socket** somewhere shared. The IP filter is an IP
  filter; `AF_UNIX` is untouched by it.
- **Anything the previous layer already does not cover** — kernel exploits, CPU
  starvation, disk quota, journal flooding, or a malicious `run` file. See
  `infra/host/README.md`.
- **The host's own exposure.** `t3code.service` still runs as root, and the
  services on `0.0.0.0` are still on `0.0.0.0`. This work stops _deployments_
  reaching them; it does not fix them.
- **Public exposure of a deployment.** The reported URL is loopback-only. Putting
  a deployment behind the existing `apache2`/`cloudflared` is deliberately out of
  scope — that config belongs to someone else.
- **Telemetry above tier 1.** Lifecycle, health, heartbeat, silence and egress
  denials are emitted. Nothing classifies a failure, fingerprints one, computes a
  `conditionsDelta`, runs the manifest's `verification.checks`, or executes
  `requirements.setupSteps` — so `failure.observed`, `verification.run` and
  `knowledge.checkpoint_failed` are all still unimplemented. `docs/deployment.md`
  carries the current line between what emits and what does not.
- **Delivery.** Events are appended to a file and nothing collects them. There is
  no transport, no `receivedAt`, no dedup on `eventId`, no buffer bound and no
  `telemetry.dropped` counter, because inventing a wire format before there is a
  collector fixes the wrong half.
- **Building the pack.** `runtime.commands.install` and `build` are never run.
  The pack must arrive built; installing dependencies would need network access
  and a writable tree at deploy time, and neither is granted.

## Requirements

Root (for `useradd`, `systemctl` and `ip addr`), systemd with cgroup v2 and BPF
available, `rsync`, `curl`, `ss`, `ip` and `jq`. `nft` is optional: without it
the deploy still runs and says so, and `egress.denied` is the one event that
goes missing.

The IP filter fails **open** on a system without BPF cgroup support: systemd
logs a warning and the unit still runs. `lp-verify-egress.sh` is the check that
it is actually in force, and `lp-verify-pack-telemetry.sh` is the check that the
manifest path and the events work; both should be run on any new host before
anything real is deployed to it.
