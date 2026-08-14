# Deployment and the telemetry contract

Two things live here. The first is short: how a pack gets from a built
directory to a running service, and what the isolation boundary is. The second
is the point of the document — the data a deployment must emit so that a
failure observed in **one** deployment becomes knowledge carried by **every**
deployment of that pack.

The second is not analytics. It is the input to the loop:

> The analytics page **is the loop**, not a dashboard. It's the telemetry
> surface. Build it as the loop's input from day one.

A dashboard answers "how is my deployment doing". This contract answers "what
does this pack now know that it did not know yesterday, and who else needs it".
Those are different schemas, and designing the first and hoping the second falls
out is how you end up with charts nobody can act on.

---

## Part 1 — What a deployment is

A deployment is one pack's build, running as a dedicated unprivileged user
inside a systemd sandbox, reachable on a private loopback address, allowed to
reach the public internet and nothing on the host.

The runner lives in `infra/deploy/` and its interface, the isolation guarantees
and the real evidence for them are in `infra/deploy/README.md` and
`infra/host/README.md`. The parts that matter to telemetry:

| Property    | Value                                                           | Why telemetry cares                                                                        |
| ----------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Identity    | `lp-<workspace-id>`, uid < 1000, no shell                       | Every event is attributable to one workspace without trusting the pack                     |
| Filesystem  | Read-only host, one writable directory                          | A deployment can buffer events to disk but cannot forge another's                          |
| Network     | `IPAddressDeny=any` plus a computed public allow list           | `egress.denied` is observable, and a pack cannot quietly ship data to a host service       |
| Supervision | `systemd` `Restart=on-failure`, `MemoryMax`, `TasksMax`         | Crashes, OOM kills and restart counts are facts the runtime already holds                  |
| Lifecycle   | `up`, `stop`, `restart`, `down`                                 | Start, stop and removal are known moments, not inferred from traffic                       |
| Manifest    | `--pack <dir.pack>`, and a refusal if the host cannot honour it | Every event carries a `packId`, a `contentDigest` and a declared surface                   |
| Observation | A per-deployment timer, and a log-only `nftables` rule          | A crash, a silence and a denied destination are all observable from outside the deployment |

Everything in Part 2 that is marked **runtime-emitted** is derivable from this
layer alone, with no cooperation from the pack. That is deliberate and it is the
single most important design constraint in this document.

---

## Part 2 — The telemetry contract

### The constraint that shapes everything

Knowledge capture has to be a byproduct of the system running, not a chore for
pack authors. Nobody writes down their edge cases voluntarily, and a contract
that depends on them doing so produces an empty knowledge base with a beautiful
schema.

So events are specified in three tiers, by who emits them:

| Tier            | Emitter                                | Cooperation needed      | Coverage                                                         |
| --------------- | -------------------------------------- | ----------------------- | ---------------------------------------------------------------- |
| **1. Runtime**  | The deploy runner and the supervisor   | None                    | Every deployment, always                                         |
| **2. Contract** | The runtime, reading the pack manifest | Manifest is well-formed | Every pack that declares interfaces, setup steps or verification |
| **3. Pack**     | Code inside the pack                   | Author instruments it   | Best signal, worst coverage                                      |

**The loop must produce findings from tier 1 alone.** Tier 2 makes findings
specific. Tier 3 makes them semantic. A design that only works at tier 3 is a
design that only works for packs whose authors were already diligent, which is
the population that never needed the loop.

### The envelope

Every event, every tier, same envelope.

```jsonc
{
  "schemaVersion": "1.0", // additive-only; consumers ignore unknown fields
  "eventId": "evt_01JZ...", // ULID; the idempotency key for at-least-once delivery
  "type": "failure.observed",
  "occurredAt": "2026-08-08T17:26:28.412Z", // deployment clock
  "receivedAt": "2026-08-08T17:26:29.004Z", // control-plane clock
  "sequence": 148, // monotonic per deploymentRunId
  "pack": {
    /* PackRef */
  },
  "deployment": {
    /* DeploymentRef */
  },
  "conditions": {
    /* Conditions */
  },
  "payload": {
    /* per-type */
  },
}
```

`occurredAt` and `receivedAt` are both required and both kept. A deployment that
loses connectivity buffers to disk and replays; without the pair you cannot tell
a burst of failures from a replayed hour, and "seventeen deployments failed at
once" is a very different finding from "one deployment failed seventeen times
and reconnected".

`sequence` exists so gaps are visible. Missing telemetry that looks like silence
is worse than missing telemetry that looks like loss.

### Attribution — `PackRef`

```jsonc
{
  "packId": "pack_01J9Z0C4Q3",        // opaque, permanent; survives rename and transfer
  "version": "1.2.0",                  // semver — a promise about behaviour
  "contentDigest": "sha256:9f3c...",   // the bytes that actually ran
  "formatVersion": "1.0",
  "derivedFrom": { "packId": "pack_01H...", "version": "0.9.1" } | null,
  "installId": "inst_01JA...",         // this pack inside one host app; stable across redeploys
  "mutations": {
    "count": 3,                        // agent-applied repairs since install
    "digest": "sha256:1b7e...",        // digest of the applied patch set
    "lastAppliedAt": "2026-07-30T09:04:00.000Z"
  }
}
```

**`version` alone is not attribution.** A version is a promise about outcome and
the maintenance agent is expected to rewrite freely underneath it as long as the
promise holds. Attributing a failure to `1.2.0` when three repairs have been
applied on top blames code that never ran, and the resulting proposal is a patch
against a file that no longer looks like that. `contentDigest` plus `mutations`
is what makes a finding land on the right bytes.

`derivedFrom` is what lets a finding reach forks. A failure in
`acme/stripe-checkout@1.2.0` is a candidate finding for every pack derived from
it, at lower confidence.

### Attribution — `DeploymentRef`

```jsonc
{
  "deploymentId": "dep_01JB...",       // stable for the life of the deployment
  "deploymentRunId": "run_01JC...",    // new on every process start
  "workspaceKeyId": "wsk_7f3a91",      // non-reversible handle; never the workspace id
  "environment": "production" | "preview" | "development",
  "visibility": "workspace" | "tenant" | "organization" | "unlisted" | "public",
  "runtimeHost": "logicpacks-managed" | "sdk-embedded" | "self-hosted",
  "sdkVersion": "0.4.2" | null,
  "firstSeenAt": "2026-05-02T10:00:00.000Z",
  "ageDays": 98
}
```

`workspaceKeyId` rather than `workspaceId` for the same reason the pack format
made that choice: two events can be proved to share an origin without leaking
tenancy. That is what makes telemetry acceptable in the enterprise-private case,
which is the case where fifty internal micro apps have the same rot problem at
smaller scale and the loop works with no network effects at all.

`runtimeHost` exists because of the SDK strategy. If Replit or Lovable ships
packs through an SDK, the observation layer is lost unless the SDK reports back.
Everything in this document is the SDK's contract too, not just the managed
runtime's — which is why the envelope is versioned and additive-only. You cannot
force an upgrade on someone else's platform.

`ageDays` and `firstSeenAt` are here so that "how many deployments are still
running at 30 / 60 / 90 days" is a query and not an archaeology project. It is
cheap to record now and impossible to reconstruct later.

### `Conditions` — the part that is usually missing

Verification catches _changed_. It does not catch _different_. Key-retrieval
steps that are correct for a standard-tier US account may be wrong for
enterprise tier, another region, or an older console — and that path is not in
the test environment, so it fails silently on the user's screen.

```jsonc
{
  "providers": [{
    "id": "stripe",
    "accountTier": "standard" | "enterprise" | "sandbox" | "trial" | "unknown",
    "region": "us" | "eu" | "ap" | "unknown",     // the account's home region
    "consoleVersion": "2026-q2" | "unknown",       // whatever the console self-reports
    "apiVersion": "2026-03-31" | "unknown",
    "authMode": "restricted-key" | "secret-key" | "oauth" | "platform-key" | "unknown"
  }],
  "runtime": {
    "language": "node", "languageVersion": "22.11.0",
    "os": "linux", "arch": "x64", "containerized": false
  },
  "dependencies": [
    { "name": "stripe", "version": "17.4.0", "resolvedFrom": "lockfile" }
  ],
  "agent": {
    "role": "installer" | "maintainer",
    "provider": "claudeAgent", "model": "claude-opus-5"
  },
  "surface": "logicpacks" | "replit" | "lovable" | "cursor" | "local",
  "locale": "en-GB",
  "timezone": "Europe/London"
}
```

Two rules, both load-bearing:

1. **Every field is present. `"unknown"` is a value, absence is not.** The whole
   purpose is to let the system say _"verified on standard-tier US — yours may
   differ"_ instead of asserting confidently. That sentence is only constructible
   if you recorded that it _was_ standard-tier US, and the caveat is only honest
   if "we could not determine the tier" is representable and distinguishable
   from "nobody thought to record it".
2. **Conditions are categories, never identities.** `accountTier: "enterprise"`,
   never an account id. `region: "eu"`, never a customer name. A condition
   envelope has to be shareable outside the workspace that produced it or the
   loop cannot propagate anything.

At plugin-install volume, wrong knowledge propagates faster than right
knowledge. Conditions are the mechanism that keeps a finding scoped to where it
was actually observed, and it is the first thing that breaks at scale if it is
added later.

### Event catalogue

#### Lifecycle — tier 1, runtime-emitted

| Type                     | Payload                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `deployment.provisioned` | `uid`, `unit`, `memoryMaxBytes`, `tasksMax`, `egressMode`, `allowedPrefixCount`, `buildSizeBytes`              |
| `deployment.started`     | `deploymentRunId`, `startCommandDigest`, `bindAddress`, `port`, `coldStartMs`, `isRedeploy`                    |
| `deployment.healthy`     | `probePath`, `statusCode`, `timeToHealthyMs`, `attempts`                                                       |
| `deployment.unhealthy`   | `probePath`, `lastStatusCode`, `consecutiveFailures`, `unhealthyForMs`                                         |
| `deployment.stopped`     | `reason`: `operator` \| `redeploy` \| `crash` \| `oom` \| `removed`, `exitCode`, `signal`, `uptimeSeconds`     |
| `deployment.removed`     | `uptimeTotalSeconds`, `restartsTotal`, `reason`                                                                |
| `deployment.heartbeat`   | `uptimeSeconds`, `memoryCurrentBytes`, `tasksCurrent`, `ipIngressBytes`, `ipEgressBytes`, `restartsSinceStart` |
| `deployment.went_quiet`  | **Synthesised by the control plane** after 3 missed heartbeats: `lastHeartbeatAt`, `missedIntervals`           |

`deployment.healthy` is not a vanity metric. It is the negative control that
every finding depends on — see "What the maintenance agent needs", point 6.

`deployment.went_quiet` is synthesised, not emitted, because the interesting
signal is an _absence_. If most deployments go quiet within eight weeks the loop
starves regardless of how good the mechanism is, and that is a risk you can only
watch if silence is a first-class event.

#### Failure — tier 1 and 2, the core of the contract

```jsonc
// failure.observed
{
  "failureId": "fail_01JD...",
  "fingerprint": "fp_2c81a4...",
  "class": "provider-contract",
  "severity": "fatal" | "degraded" | "recovered",
  "surface": { "kind": "api", "operationId": "createCheckoutSession" } | null,
  "evidence": {
    "statusCode": 400,
    "providerErrorCode": "parameter_unknown",
    "providerRequestId": "req_9aQ2...",
    "headers": { "stripe-version": "2026-03-31" },   // allow-listed keys only
    "stackDigest": "sha256:44ac...",
    "redactedMessage": "Received unknown parameter: automatic_tax[liability]"
  },
  "occurrenceCount": 12,
  "firstSeenAt": "2026-08-08T17:20:01.000Z",
  "lastSeenAt": "2026-08-08T17:26:28.000Z",
  "recoveredAfterMs": null,
  "conditionsDelta": [
    { "path": "dependencies.stripe", "from": "17.3.0", "to": "17.4.0" },
    { "path": "providers[stripe].apiVersion", "from": "2025-11-20", "to": "2026-03-31" }
  ]
}
```

`class` is a closed set, because the class is what decides whether a repair is
even conceivable:

| Class                  | Meaning                                                                 | Repairable by an agent?                                 |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------- |
| `provider-contract`    | Third party returned a status, shape or code the pack did not expect    | Often                                                   |
| `provider-auth`        | Credential rejected, expired, or missing a scope                        | Rarely — usually a knowledge fix                        |
| `provider-deprecation` | Explicit sunset signal: deprecation header, `410`, warning field        | Yes, and predictably                                    |
| `dependency-drift`     | An installed version no longer matches what the pack was proven against | Often                                                   |
| `model-deprecation`    | A named model or endpoint is gone or renamed                            | Yes                                                     |
| `integration-contract` | Host app and pack disagree about the declared interface                 | Sometimes                                               |
| `config-missing`       | A declared requirement was never supplied                               | No — it is an install defect                            |
| `knowledge-stale`      | A documented step did not match reality                                 | No code fix; the knowledge is the fix                   |
| `runtime-crash`        | Unhandled fault inside the pack                                         | Sometimes                                               |
| `resource-exhausted`   | OOM kill, `TasksMax`, disk                                              | Rarely                                                  |
| `egress-denied`        | Sandbox blocked a destination                                           | Yes — usually a wrong `permissions.network` declaration |
| `verification-failed`  | A declared check failed outside an install                              | Depends on the check                                    |

Three fields do the heavy lifting:

- **`fingerprint`** is a stable hash over `(class, normalizedMessage,
stackDigest, provider + status + errorCode, surface)`. It is what collapses
  ten thousand occurrences across two hundred deployments into one thing that
  can be reasoned about. Without it you have logs. Logs do not propagate.
- **`conditionsDelta`** is what turns an observation into a hypothesis. "It
  broke" is not actionable; "it broke, same pack digest, and the pinned
  dependency moved 17.3.0 → 17.4.0 six hours earlier" is a repair brief.
  Computed against the last `deployment.healthy` or passing `verification.run`
  for the same surface.
- **`occurrenceCount` with `firstSeenAt`/`lastSeenAt`** is client-side
  pre-aggregation. A crash loop must arrive as one event with a count, not as
  ten thousand events, or the transport becomes the outage.

```jsonc
// failure.resolved
{
  "fingerprint": "fp_2c81a4...",
  "resolvedBy": "self-recovery" | "repair-applied" | "config-change"
              | "provider-side" | "unknown",
  "durationMs": 384102,
  "repairId": "rep_01JE..." | null
}
```

A failure that resolves itself is a different fact from one that needed a fix,
and both are different from one that is still open. Findings that never close
are how a knowledge base fills with stale warnings.

```jsonc
// egress.denied  — tier 1, from the sandbox
{
  "destination": { "host": "api.stripe.com" | null, "address": "127.0.0.1", "port": 3900 },
  "deniedBy": "ip-filter",
  "count": 6,
  "declaredInManifest": false
}
```

Two jobs. It is a security signal, and it is a _requirements_ signal: a pack
repeatedly denied to a destination it genuinely needs has a wrong
`permissions.network` block, and that is a proposable repair with an obvious
diff. `declaredInManifest` is what separates the two readings.

#### Knowledge and verification — tier 2

| Type                          | Payload                                                                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `verification.run`            | `trigger`: `install` \| `schedule` \| `pre-repair` \| `post-repair`, `checks[]` of `{ id, outcome: pass\|fail\|waived, durationMs }`, `overall` |
| `knowledge.checkpoint_failed` | `stepId`, `satisfies[]`, `manual`, `verifyCommandExitCode`, `observed`, `expected`                                                              |
| `install.completed`           | `durationMs`, `stepsTotal`, `stepsCompleted`, `manualStepsCompleted`, `assistedBy`                                                              |
| `install.abandoned`           | `abandonedAtStepId`, `stepsCompleted`, `stepsTotal`, `idleForMs`, `lastError`                                                                   |

`knowledge.checkpoint_failed` is the highest-value event in this document and
the one least likely to appear by accident.

The motivating case: an agent asked how to get an API key will confidently
invent a path through the provider's console. The real path — _"Settings → API →
generate a restricted key with these two scopes"_ — is in no repository, often
not in the docs, and changes without notice. A pack that carries it is carrying
the thing that does not commoditize. But that knowledge is exactly the kind that
rots silently, because when it is wrong the user simply cannot find the page and
gives up. Nothing crashes.

So `requirements.setupSteps` must be _executed and checked_ at install, not
merely rendered as prose. Each step's `verifyCommand` firing is what converts "a
human quietly gave up" into a typed event with a condition envelope attached —
and the condition envelope is what turns it from "this is broken" into "this is
broken on enterprise tier in the EU". That is the difference between a warning
that destroys trust and a caveat that preserves it.

`install.abandoned` is the same principle applied to the whole install. The
silence _is_ the test; this makes the silence emit something. And
`install.completed.durationMs` is what answers whether the second install of a
pack was faster than the first, which is the cheapest possible evidence that
accumulated knowledge is doing anything at all.

#### Loop output — emitted by the control plane, not by deployments

These are what the contract exists to produce. They are listed here because a
telemetry schema that does not say what it is feeding is just logging.

```jsonc
// finding.opened
{
  "findingId": "find_01JF...",
  "fingerprint": "fp_2c81a4...",
  "packId": "pack_01J9Z0C4Q3",
  "affectedVersions": ">=1.1.0 <1.3.0",
  "affectedDigests": ["sha256:9f3c...", "sha256:aa10..."],
  "deploymentCount": 7,
  "distinctWorkspaceCount": 3,
  "conditionEnvelope": {
    "invariant": { "providers[stripe].apiVersion": "2026-03-31" },
    "varying":   { "providers[stripe].region": ["us", "eu"] },
    "unobserved": ["providers[stripe].accountTier=enterprise"]
  },
  "scope": "local" | "shared",
  "confidence": 0.72
}
```

```jsonc
// repair.proposed
{
  "repairId": "rep_01JE...",
  "findingId": "find_01JF...",
  "kind": "code" | "dependency" | "knowledge" | "manifest",
  "diff": "…",                        // scoped to the declared surface
  "blastRadius": { "interfaces": ["createCheckoutSession"], "breaking": false },
  "conditionsGuard": { "providers[stripe].apiVersion": ">=2026-03-31" },
  "verificationPlan": ["webhook-idempotency", "checkout-happy-path"],
  "rationale": "…",
  "autoApplicable": false,
  "requiresApprovalFrom": "workspace-owner"
}
```

```jsonc
// repair.outcome
{ "repairId": "rep_01JE...", "outcome": "applied" | "rejected" | "rolled-back",
  "approvedBy": "user_...", "verification": { "overall": "pass" },
  "resolvedFindings": ["find_01JF..."] }

// knowledge.propagated  — the loop closing
{ "findingId": "find_01JF...", "packVersionFrom": "1.2.0", "packVersionTo": "1.2.1",
  "deploymentsNotified": 41, "deploymentsUpdated": 12, "forksNotified": 3 }
```

`knowledge.propagated` is the number worth making public. Anyone can post
"shipped another app". Almost nobody can post "this broke, the agent caught it,
and it propagated to three other apps" — and that sentence is a query against
this event, or it is a claim.

### Local versus shared: the promotion rule

Expect roughly a third of failures to be general enough to matter to anyone
else. The schema's job is not to improve that ratio, it is to keep the other two
thirds from being broadcast as if they were universal.

The rule has to be written down, because "wrong knowledge propagates faster than
right knowledge" is a volume problem and defaults decide it:

| State       | Condition                                                                                 | Effect                                                             |
| ----------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `local`     | Seen in one `workspaceKeyId`                                                              | Visible only to that workspace. Default.                           |
| `shared`    | Seen in ≥2 distinct `workspaceKeyId`s **with a consistent `conditionEnvelope.invariant`** | Attached to the pack; propagates to installs matching the envelope |
| `universal` | `shared`, and reproduced under ≥2 distinct values for every field in `varying`            | Propagates to all installs                                         |

A finding never promotes on occurrence count alone. Ten thousand failures in one
workspace is one workspace's problem — usually its configuration. Two failures
in two workspaces under the same conditions is a fact about the pack.

`conditionEnvelope.unobserved` is deliberately part of the record. It is what
lets the system say _"not seen on enterprise tier — we have no data there"_
rather than implying coverage it does not have.

### What the maintenance agent needs

Turning an observed failure into a proposed repair needs eight things. Each maps
to fields above; anything missing turns the agent from a repair engine into a
rewrite engine.

1. **A stable identity for what broke** — `fingerprint`. Without it the agent
   cannot tell recurrence from novelty, and re-proposes the same fix forever.
2. **A boundary** — `surface` / `operationId`, joined to the manifest's declared
   interfaces. Repairs are scoped to the declared surface. A failure with no
   surface can only be answered by an unbounded rewrite, which is exactly what
   "an agent with write access to production" must never be allowed to be.
3. **What the code actually was** — `contentDigest` + `mutations`. Otherwise the
   diff is against source that was already replaced.
4. **What changed** — `conditionsDelta` plus the last passing `verification.run`.
   A repair needs a before, not just an after.
5. **Where it reproduces** — `conditionEnvelope`. Without it, the agent proposes
   a global fix for a regional problem, which is the exact failure mode the
   conditions mechanism exists to prevent.
6. **A negative control** — deployments on the same digest under _different_
   conditions that did **not** fail. This is why `deployment.healthy` and
   passing `verification.run` events are mandatory rather than optional: without
   successes in the corpus every failure looks universal, and the first repair
   the agent proposes breaks everyone it was working for.
7. **A way to be checked** — `verificationPlan`, drawn from the manifest's
   declared checks. A proposal that cannot be verified cannot be approved by a
   human either, because there is nothing to approve _against_.
8. **A blast radius and an approver** — `blastRadius`, `requiresApprovalFrom`.
   The agent proposes; a human approves. That is a property of the contract, not
   a UI decision, which is why the fields are in the event and not in a form.

Note what the agent is **not** given: raw request bodies, credentials, customer
data, or another workspace's identity. If a repair genuinely cannot be proposed
without those, the correct output is a `knowledge-stale` finding for a human,
not a wider grant.

### Redaction and boundaries

- **No raw request or response bodies. Ever.** `redactedMessage` only, passed
  through a redactor before it leaves the deployment.
- **Allow-listed headers only.** `stripe-version` yes, `authorization` never.
- **Secrets are redacted at source** using the manifest's
  `requirements.environment[].pattern`, so a key pasted into an error string
  never reaches the wire. The pack format already requires those patterns; this
  is the second job they do.
- **`providerRequestId` is kept.** It is opaque, it is the one field that makes a
  provider support ticket possible, and losing it costs a whole class of repair.
- **Shared findings are scrubbed to fingerprint + condition envelope + repair.**
  The originating deployment is never named, not even to the pack's publisher.
  Anything less and telemetry gets switched off in exactly the enterprise
  deployments where the loop is most useful.
- **Retention differs by tier.** Raw events: 30 days. Aggregated fingerprints and
  findings: indefinite. The knowledge is the asset; the events are the exhaust.

### Transport

- At-least-once, deduplicated on `eventId`. Exactly-once is not worth the
  complexity when idempotency is one field.
- Deployments buffer to their own writable directory and replay on reconnect,
  bounded by size, dropping oldest first — with a `telemetry.dropped` counter, so
  loss is measurable rather than invisible.
- **Telemetry must never block the application.** Under back-pressure a
  deployment degrades to lifecycle plus failure events and drops tier-3 events
  first. A pack that goes down because its telemetry endpoint went down has
  inverted the entire value proposition.
- `schemaVersion` is additive-only and consumers ignore unknown fields, because
  SDK-embedded deployments run on platforms whose upgrade schedule is not yours.

### Relationship to what already exists

- **`docs/pack-format.md` `analytics`** declares what a pack _chooses_ to emit —
  its own named events, metered `operationId`s, ready-made metrics. That is
  tier 3, and it is optional. This document specifies tiers 1 and 2, which are
  not. The two join on `packId`, `version` and `operationId`.
- **`docs/product-events.md`** is the control plane's own product analytics —
  prompts, credits, collaboration. Different envelope, different retention,
  different consumer. Deployment telemetry crosses a trust boundary that product
  events do not, which is why it gets its own contract rather than an extra
  variant of that union.
- **`docs/observability.md`** covers the server's traces and metrics. Operational,
  in-process, and not attributed to a pack version. Not this.

### What the deploy runner emits today

Tier 1, all of it, and nothing above tier 1.

The runner in `infra/deploy/` takes a `.pack` directory, derives the start
command, runtime, port and egress rules from its manifest, and writes
newline-delimited JSON to `/var/lib/lp-telemetry/<id>/events.ndjson` — root-owned
and outside the workspace, so a deployment can neither forge its own events nor
read another's. `infra/deploy/README.md` carries the real captured stream.

| Event                    | Emitted | By what, and when                                                                                                                   |
| ------------------------ | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `deployment.provisioned` | yes     | The runner, once the user, address, port, filter and build exist                                                                    |
| `deployment.started`     | yes     | The runner on deploy and on `start`/`restart`; the timer for a restart nobody asked for                                             |
| `deployment.healthy`     | yes     | The runner's first successful probe, and every later recovery from unhealthy                                                        |
| `deployment.unhealthy`   | yes     | A failed probe, from the runner during `up` and from the timer afterwards                                                           |
| `deployment.stopped`     | yes     | The runner for `operator`/`redeploy`/`removed`; the timer for `crash` and `oom`, read from `ExecMainCode`/`ExecMainStatus`/`Result` |
| `deployment.removed`     | yes     | The runner, during `down`, before anything is deleted                                                                               |
| `deployment.heartbeat`   | yes     | A per-deployment `systemd` timer, from `MemoryCurrent`, `TasksCurrent`, `IPIngressBytes`, `IPEgressBytes` and `NRestarts`           |
| `deployment.went_quiet`  | yes     | Synthesised by the same timer after three missed intervals                                                                          |
| `egress.denied`          | yes     | A log-only `nftables` rule at the output hook, aggregated per destination per tick                                                  |

Three of those are worth a note.

**`deployment.went_quiet` is synthesised on the deployment host, not by the
control plane.** This document specified the control plane as the synthesiser,
and that is still right once one exists — but a file of newline-delimited JSON
has no clock of its own, so nothing downstream can tell a deployment that
stopped emitting from a deployment that was never deployed. Something on this
side has to notice the gap and write it down. The timer unit is separate from
the deployment's unit and outlives it, which is the only reason the absence is
observable at all.

**`egress.denied` was listed here as _not available_,** because the cgroup BPF
filter discards a denied packet silently. The `netfilter` route named in that
row works: `NF_INET_LOCAL_OUT` fires before the cgroup egress program, so a
log-only rule matched on the deployment's uid sees the SYN the filter is about
to drop and can report the destination the filter cannot. `declaredInManifest`
is computed by re-resolving the manifest's hosts at emission time, which is what
makes "the record moved under a fixed allow list" a visible, repairable finding
rather than an unexplained outage.

**A run boundary is recorded even when nobody asked for one.** `deploymentRunId`
is derived from the unit's main-process start timestamp, so a crash and a
supervisor restart that happened while nothing was watching are still one stop
and one start, rather than silently merging into the run before them.

#### What is attributed, and what is `unknown`

Every event carries the full envelope: `schemaVersion`, a ULID `eventId`, a
per-deployment monotonic `sequence`, `PackRef`, `DeploymentRef` and `Conditions`.
Attribution is by `contentDigest` — a SHA-256 over every file in the pack — on
every event, for the reason this document gives: a version is a promise about
behaviour, and a finding attributed to a version can land on code that never ran.

`receivedAt` is `null` on every event, deliberately. The envelope requires the
pair and the second half is the control plane's clock; writing the deployment's
clock into it would destroy the exact distinction the pair exists to make.

Following the rule that `"unknown"` is a value and absence is not, these are
recorded as `unknown` rather than omitted, and this is why:

| Field                     | Value                                                                   | Why                                                                                                                                                                        |
| ------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conditions.providers[]`  | one entry per `requirements.accounts[].service`, every axis `"unknown"` | The runner never talks to a provider, so it can record that an account is required and nothing about the account                                                           |
| `conditions.dependencies` | `[]`                                                                    | No lockfile reader. This is the cheapest remaining win — `conditionsDelta` is what turns an observation into a hypothesis, and dependency drift is its most common content |
| `conditions.agent`        | `role: "installer"`, provider and model `"unknown"`                     | No agent is involved in a deploy today                                                                                                                                     |
| `conditions.locale`       | `"unknown"`                                                             | Not a property of the host worth guessing at                                                                                                                               |
| `pack.mutations`          | `count: 0`                                                              | Nothing applies repairs yet, so zero is true rather than a placeholder                                                                                                     |
| `deployment.sdkVersion`   | `null`                                                                  | `runtimeHost` is `logicpacks-managed`; no SDK is in the path                                                                                                               |

A deployment made the old way — `--from <dir> --command <cmd>`, no manifest —
still emits every tier-1 event, with `packId`, `version` and `formatVersion`
`null` and a real `contentDigest`. The bytes are always identifiable even when
the pack is not.

#### What still does not emit

| Event                                     | Why not                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `failure.observed`                        | Needs classification and fingerprinting. The raw material is there — exit codes, signals, `Result=oom-kill`, denied destinations — but a `fingerprint` is a stable hash over a _normalised_ message, and there is no normaliser. Emitting unfingerprinted failures would fill the corpus with rows that cannot be collapsed, which is worse than emitting none |
| `failure.resolved`                        | Nothing tracks an open failure to close                                                                                                                                                                                                                                                                                                                        |
| `verification.run`                        | The manifest's `verification.checks[]` are read but never executed. This is the next honest step and it is small: the commands are declared, the sandbox can run them, and `runsOn: ["deploy"]` already says when                                                                                                                                              |
| `knowledge.checkpoint_failed`             | `requirements.setupSteps` are not executed at all. This document calls it the highest-value event here; it needs an install flow, and this runner deploys something already installed                                                                                                                                                                          |
| `install.completed` / `install.abandoned` | Same reason: there is no install flow to instrument                                                                                                                                                                                                                                                                                                            |
| Everything in tier 3                      | The pack's own instrumentation. Nothing in the runtime can produce it                                                                                                                                                                                                                                                                                          |
| `telemetry.dropped`                       | There is no transport, so there is no back-pressure to count                                                                                                                                                                                                                                                                                                   |

And the transport itself does not exist. Events are appended to a file; nothing
collects them, nothing deduplicates on `eventId`, nothing bounds the file's size
or drops oldest-first. That is a deliberate stopping point rather than an
oversight — the contract says a deployment buffers to disk and replays, and disk
is the half that has to exist before a collector can be written against it.
Inventing a wire format now would mean inventing the collector's contract twice.

Two enforcement gaps are recorded in the events rather than left to the reader:

- `permissions.network[].ports` cannot be enforced by systemd's address filter,
  so `deployment.provisioned` carries `portRestrictionsEnforced: false` whenever
  a manifest names ports. The deployment is reachable to a declared host on every
  port, and the telemetry says so.
- The egress allow list is resolved once at deploy time. A record that moves
  afterwards produces `egress.denied` with `declaredInManifest: true` — correct,
  and the signal that a redeploy is needed, but not a repair.

### What this does not do

- **It does not make failures general.** Roughly two thirds are expected to be
  local. This contract records the distinction honestly; it does not improve the
  ratio, and the ratio is the thing the business case depends on.
- **It cannot see a silent wrong answer.** Crashes, contract violations and
  explicit checks are observable. A pack that returns a well-formed but incorrect
  result emits nothing at all. That is the largest blind spot here and it is not
  closable by better schema design — it needs the pack's own assertions, which is
  tier 3, which is the tier with the worst coverage.
- **Conditions are self-reported and mostly `unknown` at the start.** A pack that
  cannot read a provider's console version records `unknown`, and early on that
  will be most of them. The value comes from the fields that _can_ be read
  cheaply — dependency versions, API version headers, runtime versions — and
  grows only as integrations learn to report the rest.
- **Fingerprints drift.** A provider that rewords an error message splits one
  finding into two. Normalisation reduces it; nothing eliminates it.
- **Abandonment and success look identical.** A deployment that stops emitting
  may have been retired on purpose or given up on in frustration. The 30/60/90
  numbers cannot distinguish them without asking.
- **`conditionsDelta` is correlation.** It says what changed near a failure, not
  what caused it. The maintenance agent proposes; the verification plan and the
  human are what make the proposal safe.
- **Only tier 1 is implemented, and only on the managed runtime.** Nine event
  types are emitted to a file on one host. There is no transport, no collector,
  no failure classification, no verification execution and no install flow, so
  none of the loop output in this document — findings, repairs, propagation —
  has any input yet beyond lifecycle facts. The section above is the current
  line between what emits and what does not, and it is the one part of this
  document that should be re-read before trusting any of the rest.
