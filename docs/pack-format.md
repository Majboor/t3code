# The `.pack` format

A pack is a workspace turned into something a stranger can install. Somebody
builds a payment flow inside a T3 workspace, asks their agent to "make this a
pack", and the result is a self-describing artefact that another person — or
another person's agent — can find, understand, set up and run.

Everything else in the pack ecosystem is a reader or a writer of this format.
The CLI writes it. The marketplace indexes and ranks it. Pack mode searches it so
a coding agent can decide whether an existing pack solves the problem in front of
it. The maintenance agent appends to it as deployments teach it things. The
deploy surface reads it to know what to start, what to expose and what to chart.
That makes the format the keystone: a mistake here is a mistake in four products.

## The interface is the carrier; the knowledge is the product

The sections that describe *shape* — identity, requirements, interfaces, runtime,
permissions — say what the pack is and what it needs. They matter, and they are
not what anyone is buying. A model can already write a billing integration. What
it cannot write is what broke in the last four hundred billing integrations,
because that is not in any codebase: it is in the aftermath.

So a manifest that declares a perfect interface with nothing learned behind it
describes a template, and a template is something the consuming agent could have
generated for itself. Two sections carry the part that does not commoditise:

- **`knowledge`** — the failure modes production has already paid for, and the
  integration knowledge an installing agent needs and cannot read off the source.
- **`verification`** — what production says about whether any of it works, as
  signals rather than as a badge.

Both are **required even when empty**, alongside `requirements` and
`permissions`. An empty `knowledge` is an honest and useful claim: this pack has
run nowhere and learned nothing yet. Making it required is what stops the
knowledge from being the section everybody skips.

Every field in both is shaped so that a **machine writing it while watching a
deployment** can fill it. Nothing in the format asks an author to volunteer their
edge cases, because they will not.

Contracts: [`packages/contracts/src/pack.ts`](../packages/contracts/src/pack.ts).

## What a `.pack` is on disk

**A pack is a directory** named `<name>.pack`, containing a manifest called
`pack.json` at its root plus the files that manifest points at. The
distributable form is a deterministic gzipped tar of that directory, named
`<publisher>-<name>-<version>.pack.tgz`.

```
stripe-checkout.pack/
  pack.json              # the manifest — the only file with a schema
  handover.md            # what the agent wrote on its way out
  README.md              # for humans browsing the marketplace
  LICENSE
  source/                # the extracted code
  schemas/               # JSON Schemas for declared inputs and outputs
  examples/
  assets/icon.svg
```

### Why a directory and not a single file

A single-file format (everything inlined into one JSON, or an opaque archive)
was the obvious alternative and it loses on the two things this product needs
most.

- **Diffing.** Releases are read as changes, not as objects. A directory diffs,
  so an approver sees "this release changed `permissions.network`, added a
  failure mode and touched three files in `source/`". An opaque blob has to be
  unpacked before anyone can say anything about it, and each look degenerates
  into re-reading everything. This matters more once the maintenance agent is
  proposing scoped repairs against a running pack: the approval it asks for is a
  diff, and a format that cannot produce one cannot be maintained by an agent
  under human approval.
- **Authoring.** The pack is produced incrementally by an agent working inside a
  workspace, and appended to for as long as it is deployed. Writing files into a
  directory is something an agent already does well with the tools it has.
  Producing a single valid archive in one shot, and editing it afterwards, is
  not.

A directory is also git-friendly, which means a pack can live in the repository
it was extracted from and be reviewed in an ordinary pull request before it is
ever published.

### Why one manifest and not a set of convention files

The opposite mistake would be pure convention: `handover.md` here, `env.example`
there, permissions inferred from source. Every consumer would then have to
reimplement the same guessing, and the guesses would drift apart.

So there is exactly one schema-bearing file, `pack.json`, and it **names the
paths of its companion files** rather than assuming them. `handover.md` is a
convention, not a rule — `provenance.handover.path` is the truth. A Python pack
laid out its own way stays valid. `PACK_HANDOVER_FILENAME` and its siblings are
exported for tooling that wants to scaffold the conventional shape, not to
constrain readers.

### Why JSON and not TOML or YAML

Agents emit JSON reliably, Effect Schema decodes it directly, and it has one
unambiguous canonical form — which matters because the signature covers the
canonicalised manifest. Comments are the real loss; the manifest compensates
with `purpose`, `description` and `summary` fields wherever a comment would
otherwise have been wanted. Those fields also feed search and agent context,
which a comment never could.

### The archive form

The archive is transport only. It carries the same directory, and
`contents.files` lists every file with its size and SHA-256 so an extractor can
verify what it got before running anything. `contents.archiveSha256` pins the
archive itself. Nothing consumes the archive that could not equally consume the
directory.

## Versioning the format

`formatVersion` is the first field of every manifest and the first field any
reader touches. `PackManifestEnvelope` exists precisely for that: it decodes the
version and ignores everything else, so a manifest from the future produces
"this pack needs a newer T3" rather than forty missing-field errors.

The rule for bumping: **a new version is minted when a reader written against
the previous one could silently misread a manifest.** Adding an optional field
is not that. Changing what an existing field means, or making an absent field
significant, is. `PackFormatVersion` is a literal union so an unknown version is
a decode failure rather than a warning.

### `1.0` → `2.0`

The current version is `2.0`. The bump was forced by `verification`, which
changed *meaning* rather than shape: in `1.0` it was a reviewer's decision
(`unverified` / `pending` / `verified` / `rejected` / `revoked`), and in `2.0` it
is a record of what the pack has survived in production. A `1.0` reader handed a
`2.0` manifest would read a statement about production behaviour as a statement
about human review, which is exactly the silent misread the rule exists to
prevent. `PACK_SUPERSEDED_FORMAT_VERSIONS` lists `1.0` so a migrator can tell "a
version we retired" from "a version from the future" — opposite errors for a
consumer.

A `1.0` manifest maps forward mechanically:

| `1.0` | `2.0` |
| --- | --- |
| everything except `verification` | unchanged |
| *(absent)* | `knowledge: {}` — a `1.0` pack carried no knowledge, and saying so is more honest than inventing some |
| `verification.status: "unverified"` / `"pending"` | `verification.record` with every count `0` and `measuredAt` set to the migration time |
| `verification.status: "verified"` | `verification.record` zeroed, plus one `attestations` entry: `attestedBy` from `verifier`, `attestedAt` from `verifiedAt`, and `did` derived from the passing checks (`permissions-reviewed` → `reviewed-permissions`, `secret-scan` → `scanned-secrets`, `runtime-smoke-test` → `ran-checks`, …) |
| `verification.status: "rejected"` / `"revoked"` | an `advisories` entry with `severity: "revoked"` for a revocation and `"critical"` for a rejection, carrying the original `reason` and timestamp |
| `checks[].outcome: "waived"` | dropped — a waiver was a property of the review process, and there is no review to waive against |

The migration deliberately **loses the verified badge**. A `1.0` `verified` pack
becomes a pack with one attestation and no production behind it, which is what it
always was. Nothing carries a ranking forward, because carrying it forward would
be importing the exact self-attestation this version removed.

### Additions since `2.0`

Everything added since — `conditions.rot`, `failureModes[].standing`,
`accounts[].cost` and `services[].cost`, `record.scope` — is optional, and none
of it changes what an existing field means, so no bump was minted. The one that
came closest is `record.scope`: it names a meaning `verification.record` already
had, and its absence is defined as `lineage`, which is what every record written
before it existed was. A `2.0` reader that has never heard of it keeps reading
those records correctly. Release history and publication times were added
*outside* the manifest for the reasons in "Releases and publication", so they
change nothing a manifest reader parses.

## Manifest anatomy

Sections are grouped by the question they answer, in the order a consumer asks
them.

| Section | Question |
| --- | --- |
| `identity` | Who made this, what is it called, which version, under what licence |
| `provenance` | Where did it come from, when, and what did the agent say about it |
| `capability` | What does it actually do |
| `knowledge` | What does it know that I do not |
| `requirements` | What must I supply before it will run |
| `interfaces` | How do I touch it |
| `runtime` | How does it start and what does it listen on |
| `permissions` | What will it reach for |
| `verification` | What has production said about it |
| `visibility` | Who is allowed to see it |
| `integration` | How do I get another agent to use it |
| `analytics` | What will it report once it is running |
| `contents`, `signature` | Which bytes are these, and who says so |

### Identity

`id` is opaque and permanent. `name`, `displayName`, publisher and even
ownership can all change; the id does not, which is what lets install records,
analytics series and the accumulated scar record survive a rename or a transfer.
Names are unique per publisher, not globally, so `acme/stripe-checkout` and
`waleed/stripe-checkout` can coexist — the alternative is a global namespace
land-grab on day one.

`version` is strict semver. Version *ranges* are a separate type used only by
dependencies, because a release is always one exact point.

`summary` is capped at 200 characters and is not optional. It is what a search
result shows and what an agent reads while scanning twenty candidates; a pack
that cannot say what it is in one line is not discoverable at any price.

`categories` are a closed set (facets only work when everyone picks from the
same list); `tags` are free-form slugs for everything the closed set misses.

#### Keys

Two different key concepts, doing two different jobs:

- **Publisher signing key** (`identity.publisher.signingKeyId` / `publicKey`,
  and the top-level `signature`). A long-lived Ed25519 keypair owned by the user
  or organisation. The private half never leaves them; the public half is
  registered once with the marketplace. It answers *did this release really come
  from this account*, which is the question a marketplace cannot answer with an
  account password alone once packs can be mirrored or side-loaded. The
  signature covers the canonical manifest with the `signature` block removed,
  plus `contents.archiveSha256`, so metadata and payload cannot be swapped
  independently.
- **Workspace key** (`PackWorkspaceKeyId`). A stable, non-reversible handle for
  the workspace a pack came from. It travels *instead of* the workspace id so a
  public pack can prove two releases share an origin without leaking tenancy,
  and so a workspace-private pack can be pinned to its home: an installer
  presented with `visibility.scope === "workspace"` checks the key id it holds
  before unpacking anything.
- **Deployment key** (`PackDeploymentKeyId`). The same idea one level down, for a
  running deployment. Knowledge cites it so a public pack can claim a failure was
  seen in three independent deployments — the claim that makes a sighting more
  than an anecdote — without naming any of the installations it was seen in.

Signing is still optional — see the open questions.

### Provenance

`workspace`, `extractedAt`, `extractedBy` and `handover` are all required.
`extractedBy` is a union with an `agent` variant carrying provider, model and
the user it acted for, because in practice an agent cut the pack and pretending
otherwise loses the only accountability trail there is.

**The handover is required.** A pack whose author cannot say what they built,
what they tried and what they left undone is a zip file with metadata. The prose
lives in a file so it can be long; only `handover.summary` travels in the
manifest, so search and agent context stay cheap.

`source` records the commit, branch and whether the tree was dirty. `derivedFrom`
names the parent pack when this one is a fork, so credit survives a rename.

### Capability

`does` is one imperative sentence and is the first thing a searching agent
reads. `nonGoals` is the sleeper feature: listing what a pack deliberately does
*not* do is cheap for the author and is the fastest way for a consumer to rule a
candidate out. `inputs` and `outputs` are deliberately coarse — enough to judge
fit before reading code, with `schemaPath` for the cases worth pinning down.
They do not try to replace the interface definitions further down.

### Knowledge — the section the format exists for

`knowledge` holds two arrays, `failureModes` and `integration`, and both are
written by whatever observed the thing rather than by an author recalling it.

Every entry — in either array — carries three blocks in common:

- **`conditions`** — the context it was seen under. Never global; see below.
- **`origin`** — which release introduced it and what produced it.
- an **`id`** that is stable across releases, so a repeat sighting, a fix and a
  regression check point at the same fact rather than at three versions of a
  story.

#### Failure modes

What has actually gone wrong: the edge cases, race conditions and provider quirks
somebody already paid for.

- `symptom` is what it looks like from outside, because that is all a consumer
  matching against its own incident has. `trigger` is the mechanism, and
  `triggerKinds` is a closed set (`retry`, `idempotency`, `race-condition`,
  `provider-deprecation`, `clock-skew`, …) chosen to describe *mechanism* rather
  than component: "webhook retries are not idempotent" generalises across
  providers and "Stripe broke" does not.
- `attributedTo` is a union — `provider`, `dependency`, `host`, `pack` — because
  the four have different half-lives. A provider quirk can vanish with a console
  release; a dependency fault is closed by a version bump; only a fault in the
  pack's own code is one the maintainer can fix alone.
- `severity` is an ordered scale a consumer thresholds on. `silent` is the
  separate flag that matters most: a failure nothing in the running system
  reports is worth more written down than a loud one, because the loud one gets
  noticed by whoever is on call and the quiet one is found by a customer months
  later.
- `detection` stores **how to recognise it again** — the signal and the literal
  pattern or error code. This is what turns a note about the past into a guard on
  the present, and it is what lets the maintenance agent close the loop without a
  human re-describing the symptom.
- `resolution` is a union: `fixed` (with the release carrying the fix, so an
  installer can tell whether it already has it), `mitigated`, `upstream`, or
  `open`. `open` still requires `currentAdvice`. A knowledge base that records
  only victories is a marketing asset, not a scar record.
- `firstSeenAt`, `lastSeenAt` and `deploymentsAffected` are the volume behind the
  claim, read against the totals in `verification.record`.
- `standing` answers *is this still true?* — the same question integration
  knowledge has always been able to answer and a failure mode could not, which
  left "is this credential step still right" answerable and "is this fix still
  holding" not.

  It is a **different type** from `PackKnowledgeStanding`, and the two were
  compared field by field before being kept apart. Their arithmetic is inverted:
  a confirmation of an instruction is somebody following it and getting the
  screen it promised, and the matching event for a failure mode is somebody
  being hurt by it again. Sharing one struct would make `confirmedInInstalls`
  mean *it worked* on one entry and *it broke* on the next — a field that reads
  fine and silently inverts any threshold set on it. `PackFailureStanding`
  therefore counts `heldInDeployments` against `recurredInDeployments`, in
  deployments rather than installs, because the population the question is about
  is the deployments that took the resolution: a fix nobody has installed is not
  holding, it is untested. Its `state` is `recurring`, `holding`, `dormant` (no
  sightings and no explanation, which covers both "the provider fixed it" and
  "nobody walks that path") or `obsolete` (the surface it described is gone).

  `resolution` and `standing` are separate on purpose. `resolution` is what was
  done; `standing` is whether that worked. A `fixed` entry whose fix keeps
  failing in the field is the single most useful sentence this section can say,
  and without the second field it says the opposite.

#### Integration knowledge

What an installing agent needs and cannot get by reading the code. A common
envelope — `id`, `title`, `conditions`, `origin`, `standing`, `commonMistake`,
`preventsFailureModeIds` — plus a tagged `detail` in one of four kinds. The split
exists so a marketplace ranking a thousand packs can read a date and a condition
without opening four different shapes.

- **`credential-retrieval`** — the canonical case, and the demo. *"Go to the
  console, Developers → API keys, create a restricted key with Checkout Sessions
  set to Write and Payment Intents to Read"* is in no repository, is frequently
  not in the provider's own documentation, changes without notice, and is
  hallucinated confidently by every model asked. It exists only in the aftermath
  of somebody doing it. The variant carries the `environmentVariable` it fills
  (tying it to the declared requirement so neither drifts), the `service`, the
  `credentialKind`, an ordered `navigation`, the `scopes` with a **required**
  flag each, and `rotation` — what to do when the key expires, which is the next
  time any of this matters.
- **`wiring`** — a prompt addressed to the installing agent, not to a reader of
  documentation, optionally naming the interface it wires and the files it
  touches.
- **`pattern`** — a `rule` with a required `rationale`, because a rule without
  one is the first thing an agent optimises away.
- **`boundary`** — the decisions that are safe to customise versus the ones that
  must not be touched, each with a `latitude` of `safe-to-change`,
  `change-with-care` or `frozen`. A `frozen` decision links the `failureModeId`
  that froze it wherever one exists: *"do not touch this"* is an assertion, and
  *"do not touch this, here is what happened the last time somebody did"* is
  knowledge — and only the second survives an agent with a good reason of its own.

Two envelope fields carry more weight than their size suggests.
`commonMistake` records what a model produces instead when it has to guess,
because the failure being prevented is a *confident wrong answer* rather than a
missing one, and an agent shown the wrong answer can recognise itself about to
give it. `standing` counts `confirmedInInstalls` against
`contradictedInInstalls`, so a console redesign shows up as contradictions
outrunning confirmations before anyone files a report. A `superseded` entry stays
in the manifest on purpose: knowing what the path used to be beats silence when
an agent is looking at an older console. Its counterpart on failure modes is
`PackFailureStanding`, described above, and the two are deliberately not the
same shape.

#### Conditions — attached per claim, never per pack

This is the first thing that breaks at scale, so it is structural rather than
advisory.

Key-retrieval steps correct for a standard-tier US account may be wrong for an
enterprise tier, another region, or an older console — and that path is not in
anyone's test environment, so it fails silently on the user's screen. "Verified
packs get re-checked" catches knowledge that *changed*; it does nothing about
knowledge that is *different somewhere else*. At install volume, wrong knowledge
propagates faster than right knowledge.

`PackConditions` is therefore attached to **every failure mode and every
integration entry individually**, never once per manifest. Two entries in the
same pack are routinely verified years and tiers apart, and a global block would
quietly relabel the older one as having been checked under the newer one's
conditions.

- `observedAt` is the **only required field**, because it is the one thing the
  observing agent always has and because undated knowledge cannot be aged out.
- `accountTier`, `regions`, `consoleVersion` and `apiVersion` are the axes the
  failures actually run along; `other` takes an `axis`/`value` pair from the same
  closed `PackConditionAxis` set for anything else.
- `observedAcrossDeployments` separates an anecdote from a fact. One sighting and
  forty sightings are different claims and a reader is entitled to know which it
  is looking at.
- `untestedAxes` is the honest half. An absent axis means "not recorded"; naming
  an axis here means "recorded, and we know we never varied it". That is the
  difference between an agent that asserts and one that can say *"verified on
  standard-tier US in July — yours may differ"*, which converts a trust-destroying
  failure into a mild caveat.
- `rot` is how fast what was true at `observedAt` stops being true.

#### Rot rate — a date is not a shelf life

`observedAt` alone cannot age anything. It gives every reader a number of days
and leaves each of them to pick a threshold, and any single threshold is wrong
in both directions at once: six weeks kills a console path and means nothing at
all to an idempotency rule. So the rate travels with the entry rather than
living in the reader.

`conditions.rot` is a two-variant union, and which variant is present is itself
information:

- **`observed`** — a `halfLifeDays` fitted to contradictions arriving against
  this entry's age, with `fromInstalls` and `measuredAt` beside it. This is the
  variant the format is betting on, for the same reason as everything else in
  `knowledge`: it is computed from installs the runtime already counts, and it
  needs nobody to sit down and estimate. `fromInstalls` is required because a
  half-life fitted to three installs is a guess wearing a number.
- **`assumed`** — no fit yet, so the entry names its `surface` and the reader
  applies `PACK_SURFACE_HALF_LIFE_DAYS`. The surface is something the observing
  agent already knows: it just walked a console, or read an API response, or
  edited the host codebase.

| `surface` | half-life | why |
| --- | --- | --- |
| `console-navigation` | 45 days | redesigned without notice and without a version number |
| `provider-api` | 180 days | versioned, with deprecation windows |
| `provider-policy` | 90 days | plans, limits and pricing move on their own schedule |
| `sdk-surface` | 120 days | versioned, but the pack may not be pinned |
| `host-codebase` | 60 days | the codebase it was installed into keeps being edited |
| `protocol-invariant` | *never* | at-least-once delivery will not be redesigned next quarter |

`protocol-invariant` maps to `null` rather than to a very large number, because
"does not rot" and "rots slowly" are different claims and a reader thresholding
on a number cannot tell them apart. Keeping the two variants distinct matters
for the same reason: *measured across 200 installs* and *the default for console
paths* support very different confidence, and a reader handed one number would
trust the second as hard as the first.

This is what makes `knowledge-conditions-stale` computable. The rule is
`age > halfLife` against the entry's own rate, so it fires on a two-month-old
console path and stays quiet on a two-year-old delivery guarantee, rather than
firing on both or neither.

#### How knowledge propagates

`origin.introducedIn` names the release that first carried the entry, and
`origin.source` names what produced it — `maintenance-agent`,
`deployment-telemetry`, `install-report`, `human-report` or `inherited`. The
machine-written variants are listed first because they are the ones the format
bets on; anything that depends on an author sitting down to write is a source
that stays empty.

A failure caught in one deployment is versioned into the pack and inherited by
everyone: the maintenance agent appends the entry with `introducedIn` set to the
release carrying it, and an installer diffing the version it runs against the
version it is offered can answer *"what did the last four hundred deployments
learn that I do not know yet"* without reading either manifest in full. The
`inherited` source variant does the same across pack boundaries — a dependency's
scar is the dependant's scar, and it points back at the pack, version and entry
id it came from. `origin.supersedes` replaces an earlier entry rather than sitting
beside it: a console path that moved is a correction, not a second fact, and a
manifest that keeps both is how an agent ends up reciting last year's menu.
`origin.deploymentKeyIds` cites the deployments behind a sighting by opaque
handle, so a public pack can claim three independent sightings without naming who
was running it.

#### What the maintenance agent actually writes

Every required field in this section is something the agent already holds at the
moment it notices something: an id it mints, a symptom it read off a signal, the
deployment conditions it was already running under, its own clock, and its own
count of affected deployments. Nothing requires reflection. That is the whole
design constraint — knowledge capture is a byproduct of the runtime working, not
a chore for pack authors — and it is why `trigger` is capped at 4,000 characters
rather than left open: an agent writing twenty of these must not bloat a manifest
a search index has to hold in memory.

### Requirements — the section that decides reusability

This is the part the whole format exists for. A pack that works perfectly in its
author's workspace and cannot tell you it needs a Stripe key is not reusable; it
is a bug report waiting to happen.

- `environment` — every variable, with `secret` and `required` as *separate*
  required booleans. A publishable Stripe key is required and not secret; a
  webhook signing secret is both. `secret` drives storage and redaction, so
  collapsing them would either over-protect config or under-protect keys.
  `obtainUrl` is the difference between a pack that installs and one that stalls
  on the first missing value, and `pattern` lets an installer reject an
  obviously-wrong paste before anything runs.
- `accounts` — third-party accounts the consumer must hold *in their own name*,
  with signup URL, required scopes and a cost. `providesEnvironment` links an
  account to the variables it hands out.
- `services` — infrastructure the consumer must run (Postgres, Redis, SMTP),
  each with its own cost.
- `toolchain`, `packs` — what must be installed, and which other packs this one
  depends on.
- `setupSteps` — ordered, each with optional `command`, `verifyCommand` and
  `satisfies`. `satisfies` closes the loop between "you need `STRIPE_SECRET_KEY`"
  and "here is how you get one"; `verifyCommand` is what lets a consuming agent
  check its own work instead of declaring victory. `manual: true` marks the steps
  a machine cannot do — signing up, passing KYC, clicking a confirmation email.
- `preflightCommand` — one command that exits zero when everything above is in
  place, so an agent can answer "can this run yet?" without interpreting the
  list itself.

`requirements` is **required even when empty**. `"requirements": {}` is an
affirmative claim that the pack needs nothing supplied, which is a different
statement from an absent section, and one a reviewer can hold the publisher to.

#### What it costs to run

`costsMoney` on `accounts` was the whole cost model, which made every pack that
needs a Postgres or a bucket look free. A summary built from it undercounts by
exactly the infrastructure the pack cannot run without.

`PackRunningCost` is therefore attached to **every requirement kind that can
actually bill**, which after going through them one at a time is two of them:

| kind | carries cost | why |
| --- | --- | --- |
| `accounts` | yes | the original case; `costsMoney` is kept beside it so existing readers keep working, and the two must agree |
| `services` | yes | a database or an object store is a bill whether it comes from a provider or from the consumer's own hosting |
| `environment` | no | a value is free; the account that issues it is what charges, and that is declared on the account |
| `toolchain` | no | interpreters and build tools; a toolchain that must be paid for is a licence, and a licence is an account |
| `packs` | no | a dependency states its own costs in its own manifest, and a copy here goes stale the next time it reprices |

`model` is `free`, `free-tier`, `metered`, `subscription` or `paid-plan` —
because "free until 5GB", "pennies per request" and "there is no plan under $99"
rule a pack out for different readers, and one boolean collapses all three into
the least useful of them. `billedOn` says what the meter counts and
`freeTierLimit` says where the surprise arrives.

There is deliberately **no price**. Prices move quarterly, a manifest is frozen
at extraction, and a stale number a consumer budgets against is worse than no
number, so the format names the shape of the bill and links to whoever is
allowed to state its size.

On a service, `model: "free"` claims *nothing beyond infrastructure you are
already paying for* — a claim about this pack's usage, not about the software's
licence. An absent `cost` is not that claim: it is unknown, and unknown is not
free, which is why `requirement-cost-undeclared` exists as a readiness warning
and why any summary built on this has to count the silences separately.

### Interfaces

A pack may be a web app, a TUI, an HTTP API, a library, a CLI — or an MCP
server. `interfaces` is a non-empty array of a tagged union, not a `hasWebUi`
flag, because a headless payments API and a dashboard are not the same product
and a marketplace that assumes a front end cannot list the first one. A pack can
expose several at once: the worked example below is an API, a return page, a CLI
and an MCP server.

MCP is a first-class interface kind rather than an integration detail. Packs are
searched and installed by agents; being callable as a set of tools is one of the
main ways a pack gets consumed, not a footnote.

`operationId` on API operations is the join key for analytics — see below.
Interfaces reference the runtime service that hosts them by `serviceId` so ports
are declared exactly once.

### Runtime

`runtime.commands` is a fixed lifecycle (`install`, `build`, `start`, `dev`,
`test`, `migrate`, `healthcheck`) rather than a free-form list of named scripts.
Every downstream surface needs to answer the same handful of questions, and an
open-ended array would force each of them to guess which entry means "start".
All are optional at the schema level because a `library` pack has nothing to
start; a pack exposing anything else must declare `start`, which is enforced as
a publish-readiness rule rather than a schema rule (see below).

`services[].binding` is a union — `fixed`, `environment` or `dynamic` — because
"port 3000", "whatever `PORT` says" and "the runtime assigns one" need different
handling at deploy time and a nullable number cannot tell them apart.
`exposure` tells the deploy surface whether to route public traffic.

### Permissions

Declarative, so it can be reviewed now and enforced later.

- `network` is per destination, with `purpose` and optional `dataClasses`. A
  reviewer reads "card data goes to Stripe" instead of inferring it from source.
  Host patterns allow one leading `*.` because real services span subdomains,
  but a bare `*` is rejected: a permission that allows everything communicates
  nothing.
- `filesystem` is anchored to a **named root** (`pack`, `data`, `tmp`,
  `workspace`, `home`, `absolute`) rather than a raw path, so a sandbox can map
  the roots however it likes and `absolute` stands out as the one case a
  reviewer has to argue with.
- `secrets` lists what is read at runtime; `process` declares subprocess
  spawning.
- `elevated` is the escape hatch for anything the model above cannot express —
  raw sockets, native modules, the Docker socket — and every entry carries a
  required `justification`, because these are exactly the requests a human
  should read before approving.

Like requirements, `permissions` is present even when empty, so that enforcement
can eventually treat anything undeclared as a violation rather than an omission.

### Verification — earned, not awarded

The `1.0` model was a human reviewer stamping a badge. That model does not work,
for reasons that are not fixable by tightening it:

- **Manual review does not scale.** One reviewer per release is a cost that grows
  with the library and never stops.
- **Self-attestation means nothing.** A publisher asserting its own quality is
  not evidence, and a format that lets a manifest claim `verified` invites
  exactly that forgery.
- **A tier is coarser than the decision.** An agent wiring up a payment flow and
  an agent wiring up a changelog widget want different bars, and one badge cannot
  serve both. The consumer here is an agent, which can handle the nuance a badge
  throws away.

So `2.0` surfaces the underlying signals and lets the consumer threshold them.
The one honest form of verification is the one earned from production: tests
passing across deployments, install success rate, breakages caught, time in
service.

**`record`** — the scar record, required on every manifest and zeroed on a pack
that has never run. A clean record has to be *visibly* clean rather than absent,
because "no breakages" and "no deployments" are the two ends of the judgement
this section supports and an omitted block reads like the good one.

It carries raw counts and never rates: `installsAttempted` against
`installsSucceeded`, `deploymentsAttempted` against `deploymentsSurviving`,
`cumulativeServiceDays` and `longestServiceDays`, `breakagesCaught` against
`breakagesFixed`, and an optional `survival` cohort at day 30 / 60 / 90. The
consumer is an agent and can divide; a stored ratio hides the denominator that
decides whether the ratio means anything. Nine installs in ten succeeding is a
fact — nine in ten with the ten unstated is a claim. `measuredAt` is required,
because a count with no as-of moment is unusable.

#### Whose signals are these — the version's or the pack's?

The answer is neither, because the question contains two different signals that
had been forced onto one axis.

**Knowledge accumulates per pack.** An entry in `knowledge` carries
`origin.introducedIn`, so it is already dated by release and already travels
forward: `1.2.0` genuinely knows what `1.0.0` learned, and a reader who wants
"what did this release teach" subtracts. Nothing is inherited that was not
literally carried, so there is nothing to fix here.

**Behaviour belongs to the release that ran.** Deployments, survival and service
days are facts about bytes that executed, and a rewrite between minor versions
inherits none of them honestly. So each release carries its own
`PackRelease.signals` — a `PackScarRecord` with `scope: "release"` — in the
registry's release history.

**`verification.record` stays the lineage total**, now saying so explicitly via
`record.scope` (absent means `lineage`, which is what it has always meant, so no
existing manifest changes meaning). Both numbers are published and neither is
hidden behind the other: the dashboard reads *"29 of 37 deployments still
running across every release; 8 of 11 on this one"*.

The decision is to show both rather than to pick, and it is worth being explicit
about what that gets wrong:

- **It leans on the reader.** Two numbers can be misread as one; a publisher
  quoting the lineage figure for a day-old release is doing something the format
  permits.
- **It cannot tell a rewrite from a typo fix.** Semver is the only signal for
  how much continuity a release inherits, and semver is author-declared. A
  `1.2.1` that rewrote the webhook handler still sits inside a lineage record it
  did not earn. That is the residual laundering path, and it is smaller than the
  one before — the per-release column makes the newness visible — but it is not
  closed.
- **A fresh release still looks untested, because it is.** The per-release
  column on a two-day-old release reads near-zero. That was the argument against
  per-version signals, and the answer here is that it is true and should be
  visible, sitting next to the line's record rather than instead of it.
- **Knowledge inheritance is wrong in the other direction.** A release that
  deleted the code a failure mode described still carries the entry, because
  nothing withdraws knowledge. `origin.supersedes` handles corrections and not
  removals.

Two of these numbers are chosen deliberately against the publisher's interest.
`deploymentsSurviving` is the only one that cannot be inflated by trying again,
and `knowledgeContradictions` counts installs that followed the carried knowledge
and found it wrong — the provider-churn alarm, and the number a publisher would
rather not publish. The survival cohort exists because deployments that go quiet
in the first month teach nothing: it measures whether the knowledge behind the
pack is still being fed.

**`checks`** — tests that run on install and keep running after. Each carries
`runsOn` (`install`, `deploy`, `schedule`, `upgrade`), the counts `runs` and
`passes`, and `deploymentsCovered` so repetition on one machine is not read as
coverage in the field. Counts rather than a pass/fail badge, because a check that
ran four hundred times and failed twice, a check that has never run, and a check
that passed once on the author's laptop are three different facts.
`guardsFailureModeId` is what turns a check into evidence: a check that exists
*because something broke*, still passing across four hundred deployments, says
more about this pack than any review of its source.

**`attestations`** — the surviving way to say "we ran it", kept deliberately
secondary and deliberately specific. It names who did what, on what, and when:
`attestedBy`, an `attestedAt`, a `did` list drawn from a closed set
(`installed-from-clean`, `ran-checks`, `deployed-to-production`, …), and its own
`conditions` — which is what stops "we ran it" from being read as "it runs". It
carries no ranking of its own and nothing downstream sorts by it.

**`advisories`** — the one part of the reviewer-owned badge worth keeping. A pack
found to be dangerous has to be withdrawable without waiting for production to
notice, so a registry can issue a `revoked`, `critical` or `warning` advisory with
a reason, affected version ranges and an optional link to the failure mode behind
it. It is a separate field rather than a low value on the earned scale because
"nobody has run this yet" and "this was pulled" are opposite claims and no single
scale holds both.

Ownership: the runtime writes `record` and `checks`, the registry writes
`advisories`, and the publisher may write `attestations` and nothing that ranks.

`PackSummary` carries the same signals flattened, so pack mode can lead with
*"there's a pack for this, it's running in 29 deployments and it handles the
webhook idempotency case that breaks most implementations"* — a warning about
what the agent is about to get wrong — rather than with a badge.

### Visibility

`workspace` (private to its origin), `tenant`, `organization`, `unlisted`
(reachable by link, absent from search) and `public`. The scoped variants carry
their own id so an installer can refuse a pack that wandered outside its
boundary. `unlisted` exists because "share this with one client" and "put this
in the marketplace" are different requests and collapsing them forces publishers
to choose between over-sharing and not sharing.

`PackVisibilityScope` names the five without their ids, for the places that
reason about width rather than about which workspace, and
`PACK_VISIBILITY_WIDTH` orders them so that *publication* and *withdrawal* have
one definition across the CLI, the registry and the dashboard. `tenant` and
`organization` share a width: two different walls of the same height.

### Releases and publication — outside the manifest, and why

A manifest describes exactly one release and can say nothing about its siblings.
The obvious fix — a `releases` array inside the manifest — is wrong, and wrong
in a way worth writing down:

- A manifest is **frozen at extraction** and covered by `signature`, which
  hashes the canonical manifest. A publish time written inside it would have to
  be either written before it was true or written after signing, which means
  either wrong or unsigned.
- A manifest can only look **backwards**. `1.0.0` cannot know that `1.2.0` will
  exist, so the reader who most needs "am I reading the newest one" — someone
  holding an old manifest — is exactly the reader an in-manifest list cannot
  serve.
- Both halves of this keep moving after the bytes stop. Visibility changes when
  somebody clicks publish; per-release signals change every day a deployment
  survives.

So release history is a **registry projection**, `PackReleaseHistory`: a
`packId`, a stated `latestVersion` (stated rather than inferred from the
ordering, for the old-manifest reader above), and the releases newest first.
Each `PackRelease` carries:

- `version` and `cutAt`, where `cutAt` matches that release's own
  `provenance.extractedAt`;
- `publications`, the visibility log;
- `signals`, what that release alone earned — see the verification section.

Nothing here is a release *note*. What a release is worth reading for is already
in the format: the failure modes it closed (`resolution.inVersion`) and the
knowledge it introduced (`origin.introducedIn`). A prose note would be a fourth
place to say it and the only one nobody updates.

#### `publications` — a log, not a `publishedAt`

`provenance.extractedAt` is when the pack was cut. It is routinely days away
from when anyone could see it, and it is the wrong date for every sentence that
begins *"published"*.

The log is ordered oldest first, and each entry says the release moved to a
scope at an instant. Widening and narrowing are the same kind of entry, so
nothing has to be closed out or back-dated, and the two questions a reader
actually asks both stay answerable:

- *When did this become visible to me?* — the earliest entry whose scope is at
  least as wide as the reader's.
- *Where does it stand now?* — the last entry.

A single timestamp can answer neither once a pack has been withdrawn. A release
that was public for a month and then pulled back is not the same object as one
that was never published — installs made in that window are still running and
cannot be recalled — and the log is what keeps that distinction sayable. An
empty log is itself a claim: cut, and shown to nobody.

### Integration

`integration.prompt` is required and inline: the copyable block a user pastes
into Lovable, Replit, Cursor or another agent to have it start using the pack. It
is inline rather than a file path because a search result must be immediately
actionable without a second fetch. `variants` allow per-target rewrites — the
same instructions land differently in a tool that owns its own hosting than in
one that does not. `followUpQuestions` are what the consuming agent should ask
its user before wiring anything up.

This section is the **carrier**, and `knowledge.integration` is the product.
`integration.prompt` says how to invoke the pack and is authored once at
extraction; `knowledge.integration` says what goes wrong while doing so, is
written by whatever observed it, and carries the conditions it was true under.
Keeping them apart is what stops an accumulated scar record from being flattened
back into a prompt that nobody updates.

### Analytics

Packs declare what they emit so a deployment dashboard can show traffic without
anyone configuring it.

- `events` — named, sourced (`frontend` / `backend` / `job` / `cli`), with
  properties each carrying a required `pii` flag that drives redaction and
  retention downstream.
- `meteredOperations` — API traffic is **referenced by `operationId`**, not
  restated as routes. The interface section is the single definition of each
  endpoint; analytics only says which ones to count. A path can change without
  orphaning a dashboard.
- `metrics` — ready-made charts (`count`, `unique-users`, `sum`, `latency-p95`,
  `error-rate`) whose sources point at declared events or operation ids.

`analytics` is optional, unlike requirements and permissions: a pack that emits
nothing is a normal pack, and an absent section is not a security claim.

## Valid versus publishable

Two tiers, deliberately.

**Schema validity** is what `PackManifest` decodes. It is kept permissive enough
that a half-finished pack still opens — a pack with no `start` command, no
signature and an empty integration prompt is a *valid* manifest, because tooling
must be able to load it in order to tell its author what is missing. A schema
that refused to parse work-in-progress would make the authoring experience
hostile.

**Publish readiness** is the second tier, reported as a `PackReadinessReport`
with coded `PackReadinessIssue`s: `start-command-missing`,
`handover-empty`, `elevated-capability-unjustified`, `analytics-operation-unknown`
(a metered operation id no interface declares), `interface-service-unknown`,
`secret-value-in-manifest`, and so on. Errors block publishing; warnings do not.
This is where the cross-field rules live, and keeping them out of the schema
means each of them can carry a message aimed at a human.

The knowledge rules live here too, and most of them are warnings on purpose — a
pack has to be publishable before it can earn anything:

- `knowledge-absent` and `verification-record-unmeasured` — nothing has run
  behind this. A warning, but a loud one: it is the difference between a proven
  capability and a template.
- `knowledge-conditions-stale` — an entry whose age has passed its own
  `conditions.rot` half-life, so the threshold is per-entry rather than one
  constant applied to console paths and delivery guarantees alike.
- `requirement-cost-undeclared` — an account or service with no `cost`. A
  warning rather than an error, because unknown cost is a normal state for a
  freshly cut pack; loud, because a summary can only read silence as unknown and
  a reader will read it as free.
- `knowledge-contradicted` — `standing.contradictedInInstalls` has outrun
  `confirmedInInstalls`, so the entry is being repeated after the field stopped
  agreeing with it.
- `knowledge-reference-unknown` — a `failureModeId`, `checkId` or `interfaceId`
  pointing at something nothing declares. These cross-links are the ones a
  machine writes, so they are the ones most likely to dangle.
- `credential-knowledge-unlinked` — credential knowledge naming an
  `environmentVariable` that `requirements.environment` does not declare.
- `customisation-boundary-unexplained` — a `frozen` decision with neither a
  `failureModeId` nor a reason that survives reading.
- `failure-mode-open-critical`, `check-never-run`, `advisory-open`.

## Worked example

A payment flow extracted from a working storefront workspace, six months and
thirty-seven deployments later — the motivating case for the whole format. The
interesting part is not the interface; it is `knowledge` and `verification`, and
in particular the restricted-key entry, which is the piece no model would have
produced and no reader could have got from the source.

```json
{
  "formatVersion": "2.0",
  "identity": {
    "id": "pack_01J9Z0C4Q3",
    "name": "stripe-checkout",
    "version": "1.2.0",
    "displayName": "Stripe Checkout",
    "summary": "Hosted Stripe checkout with webhook reconciliation.",
    "description": "Extracted from a working storefront: session creation, redirect, webhook.",
    "publisher": {
      "type": "organization",
      "handle": "acme",
      "displayName": "Acme",
      "signingKeyId": "key_ed25519_01",
      "publicKey": "bXktcHVibGljLWtleQ==",
      "contactUrl": "https://acme.example/support"
    },
    "license": "Apache-2.0",
    "categories": ["payments", "commerce"],
    "tags": ["stripe", "checkout", "webhooks"],
    "homepageUrl": "https://acme.example/packs/stripe-checkout",
    "repositoryUrl": "https://github.com/acme/stripe-checkout"
  },
  "provenance": {
    "workspace": {
      "workspaceKeyId": "wsk_7f3a91",
      "workspaceId": "workspace-storefront",
      "tenantId": "tenant-acme",
      "title": "Storefront"
    },
    "extractedAt": "2026-08-07T09:12:00.000Z",
    "extractedBy": {
      "type": "agent",
      "provider": "claudeAgent",
      "model": "claude-opus-5",
      "onBehalfOfUserId": "user-1"
    },
    "handover": {
      "path": "handover.md",
      "summary": "Session creation, redirect and webhook reconciliation, minus the cart UI.",
      "generatedAt": "2026-08-07T09:12:00.000Z"
    },
    "source": {
      "repositoryUrl": "https://github.com/acme/storefront",
      "branch": "main",
      "commitSha": "9a1f2c4",
      "dirty": false
    }
  },
  "capability": {
    "does": "Turns a cart total into a paid Stripe order.",
    "useCases": ["One-off product checkout", "Subscription upgrade flow"],
    "nonGoals": ["Does not store cards", "Does not handle refunds or disputes"],
    "inputs": [
      {
        "name": "cart",
        "kind": "http-request",
        "description": "Line items and currency for the order being paid.",
        "schemaPath": "schemas/cart.json",
        "required": true
      }
    ],
    "outputs": [
      {
        "name": "payment-completed",
        "kind": "webhook",
        "description": "Fires once Stripe confirms the payment intent succeeded."
      }
    ]
  },
  "knowledge": {
    "failureModes": [
      {
        "id": "webhook-retry-double-charge",
        "symptom": "A buyer is charged twice for one cart within a few seconds.",
        "trigger": "Stripe redelivers payment_intent.succeeded when the first delivery times out. Handlers keyed on the event id alone still create a second order because the order write and the event write are not in one transaction.",
        "triggerKinds": ["retry", "idempotency", "race-condition"],
        "attributedTo": { "kind": "provider", "service": "stripe", "apiVersion": "2026-04-10" },
        "severity": "critical",
        "silent": true,
        "detection": {
          "signal": "reconciliation-mismatch",
          "match": "orders.payment_intent_id count > 1",
          "checkId": "webhook-idempotency"
        },
        "resolution": {
          "kind": "fixed",
          "inVersion": "1.1.0",
          "change": "Insert the event id into a processed_events table inside the same transaction as the order write, and return 200 on conflict.",
          "checkId": "webhook-idempotency"
        },
        "standing": {
          "state": "holding",
          "heldInDeployments": 26,
          "recurredInDeployments": 0,
          "lastCheckedAt": "2026-08-07T06:00:00.000Z"
        },
        "firstSeenAt": "2026-05-02T04:19:00.000Z",
        "lastSeenAt": "2026-06-18T22:40:00.000Z",
        "deploymentsAffected": 11,
        "conditions": {
          "observedAt": "2026-06-18T22:40:00.000Z",
          "accountTier": "standard",
          "regions": ["us", "eu-west-1"],
          "apiVersion": "2026-04-10",
          "observedAcrossDeployments": 11,
          "untestedAxes": ["plan"],
          "rot": { "basis": "assumed", "surface": "protocol-invariant" }
        },
        "origin": {
          "introducedIn": "1.1.0",
          "source": {
            "kind": "maintenance-agent",
            "provider": "claudeAgent",
            "model": "claude-opus-5",
            "runId": "run_01J9ZMAINT"
          },
          "recordedAt": "2026-05-02T05:00:00.000Z",
          "deploymentKeyIds": ["dep_1f8c", "dep_44ae"]
        }
      },
      {
        "id": "restricted-key-missing-read-scope",
        "symptom": "Reconciliation returns 403 while checkout itself keeps working.",
        "trigger": "A restricted key created with only checkout_sessions:write passes install, because nothing reads payment intents until the first reconcile run hours later.",
        "triggerKinds": ["permission-denied", "misconfiguration"],
        "attributedTo": { "kind": "provider", "service": "stripe" },
        "severity": "medium",
        "detection": { "signal": "provider-error-code", "match": "resource_missing|permission_error" },
        "resolution": {
          "kind": "open",
          "currentAdvice": "Run `checkout reconcile --since 1h` immediately after install so a missing scope fails while the console is still open."
        },
        "standing": {
          "state": "recurring",
          "heldInDeployments": 0,
          "recurredInDeployments": 4,
          "lastCheckedAt": "2026-08-07T06:00:00.000Z"
        },
        "firstSeenAt": "2026-07-11T13:05:00.000Z",
        "deploymentsAffected": 4,
        "conditions": {
          "observedAt": "2026-07-11T13:05:00.000Z",
          "accountTier": "standard",
          "regions": ["us"],
          "consoleVersion": "2026.07",
          "untestedAxes": ["account-tier", "region"],
          "rot": { "basis": "assumed", "surface": "console-navigation" }
        },
        "origin": {
          "introducedIn": "1.2.0",
          "source": { "kind": "install-report", "target": "cursor" },
          "recordedAt": "2026-07-11T14:00:00.000Z"
        }
      }
    ],
    "integration": [
      {
        "id": "stripe-restricted-key",
        "title": "Create the restricted Stripe key the pack actually needs",
        "detail": {
          "kind": "credential-retrieval",
          "environmentVariable": "STRIPE_SECRET_KEY",
          "service": "stripe",
          "credentialKind": "restricted-key",
          "consoleUrl": "https://dashboard.stripe.com/apikeys",
          "navigation": [
            {
              "action": "Open Developers → API keys in the Stripe dashboard.",
              "url": "https://dashboard.stripe.com/apikeys",
              "expect": "A table headed Standard keys with a Restricted keys section beneath it."
            },
            {
              "action": "Choose Create restricted key, not Reveal on the standard secret key.",
              "expect": "A permission list with every resource set to None by default."
            },
            {
              "action": "Set Checkout Sessions to Write and Payment Intents to Read, leave the rest at None, then create.",
              "expect": "The key is shown once, prefixed rk_live_ rather than sk_live_."
            }
          ],
          "scopes": [
            {
              "name": "checkout_sessions:write",
              "purpose": "Creates the hosted session the buyer is redirected to.",
              "required": true
            },
            {
              "name": "payment_intents:read",
              "purpose": "Reconciles orders against Stripe after a missed webhook.",
              "required": true
            }
          ],
          "rotation": "Restricted keys are not rotated by Stripe. Create the replacement, deploy, then delete the old key from the same screen."
        },
        "conditions": {
          "observedAt": "2026-07-30T09:00:00.000Z",
          "accountTier": "standard",
          "regions": ["us"],
          "consoleVersion": "2026.07",
          "observedAcrossDeployments": 26,
          "untestedAxes": ["account-tier", "region", "locale"],
          "rot": {
            "basis": "observed",
            "surface": "console-navigation",
            "halfLifeDays": 63,
            "fromInstalls": 27,
            "measuredAt": "2026-08-07T18:00:00.000Z"
          }
        },
        "origin": {
          "introducedIn": "1.0.0",
          "source": { "kind": "human-report", "reportedByUserId": "user-1" },
          "recordedAt": "2026-03-04T11:00:00.000Z",
          "supersedes": "stripe-secret-key-legacy"
        },
        "standing": {
          "state": "holding",
          "confirmedInInstalls": 26,
          "contradictedInInstalls": 1,
          "lastConfirmedAt": "2026-07-30T09:00:00.000Z"
        },
        "commonMistake": "Models send the installer to Settings → API keys and tell them to copy the standard secret key, which grants the whole account and is the wrong key entirely.",
        "preventsFailureModeIds": ["restricted-key-missing-read-scope"]
      },
      {
        "id": "wire-webhook-before-cart",
        "title": "Mount the webhook route before touching the cart page",
        "detail": {
          "kind": "wiring",
          "prompt": "Mount POST /api/checkout/webhook with the raw request body, verify the signature, then persist the event id and the order in one transaction. Only once that round-trips should you add the cart button that calls /api/checkout/sessions.",
          "interfaceId": "checkout-api",
          "touches": ["source/server.ts", "source/webhook.ts"]
        },
        "conditions": {
          "observedAt": "2026-07-30T09:00:00.000Z",
          "observedAcrossDeployments": 26
        },
        "origin": {
          "introducedIn": "1.1.0",
          "source": { "kind": "deployment-telemetry", "signal": "checkout.payment_succeeded" },
          "recordedAt": "2026-05-03T08:00:00.000Z"
        },
        "preventsFailureModeIds": ["webhook-retry-double-charge"]
      },
      {
        "id": "checkout-customisation-boundary",
        "title": "What is safe to change in the checkout flow",
        "detail": {
          "kind": "boundary",
          "decisions": [
            {
              "subject": "Success and cancel URLs, currency, and the line item labels.",
              "latitude": "safe-to-change",
              "reason": "Read from configuration and never used to key anything."
            },
            {
              "subject": "The processed_events insert inside the order transaction.",
              "latitude": "frozen",
              "reason": "Removing it reintroduces duplicate charges under webhook retries.",
              "failureModeId": "webhook-retry-double-charge",
              "path": "source/webhook.ts"
            }
          ]
        },
        "conditions": { "observedAt": "2026-07-30T09:00:00.000Z" },
        "origin": {
          "introducedIn": "1.1.0",
          "source": { "kind": "maintenance-agent", "provider": "claudeAgent", "model": "claude-opus-5" },
          "recordedAt": "2026-05-03T08:00:00.000Z"
        }
      },
      {
        "id": "idempotency-pattern",
        "title": "Key idempotency on the provider event id, not the order id",
        "detail": {
          "kind": "pattern",
          "rule": "Every handler writes the provider event id to a uniquely indexed table in the same transaction as the effect it causes, and treats a conflict as success.",
          "rationale": "Retries are the provider's normal behaviour, so at-least-once delivery has to be absorbed rather than avoided.",
          "example": "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING"
        },
        "conditions": {
          "observedAt": "2026-07-30T09:00:00.000Z",
          "apiVersion": "2026-04-10",
          "observedAcrossDeployments": 26
        },
        "origin": {
          "introducedIn": "1.1.0",
          "source": {
            "kind": "inherited",
            "packId": "pack_01H0PARENT",
            "packName": "payments-core",
            "packVersion": "0.4.1",
            "entryId": "idempotency-pattern"
          },
          "recordedAt": "2026-05-03T08:00:00.000Z"
        }
      }
    ]
  },
  "requirements": {
    "environment": [
      {
        "name": "STRIPE_SECRET_KEY",
        "purpose": "Server-side Stripe API calls.",
        "secret": true,
        "required": true,
        "example": "sk_live_...",
        "obtainUrl": "https://dashboard.stripe.com/apikeys",
        "pattern": "^sk_(test|live)_[A-Za-z0-9]+$"
      },
      {
        "name": "STRIPE_WEBHOOK_SECRET",
        "purpose": "Verifies webhook signatures.",
        "secret": true,
        "required": true
      },
      {
        "name": "CHECKOUT_SUCCESS_URL",
        "purpose": "Where Stripe returns the buyer after payment.",
        "secret": false,
        "required": true,
        "defaultValue": "https://example.com/thanks"
      }
    ],
    "accounts": [
      {
        "service": "stripe",
        "displayName": "Stripe",
        "purpose": "Processes the payment and hosts the checkout page.",
        "signupUrl": "https://dashboard.stripe.com/register",
        "requiredScopes": ["checkout_sessions:write", "payment_intents:read"],
        "costsMoney": true,
        "cost": {
          "model": "metered",
          "billedOn": "A percentage of every payment processed.",
          "pricingUrl": "https://stripe.com/pricing"
        },
        "providesEnvironment": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
      }
    ],
    "services": [
      {
        "kind": "postgres",
        "name": "orders",
        "purpose": "Stores orders and their payment state.",
        "versionRange": ">=14",
        "connectionEnvVar": "DATABASE_URL",
        "cost": {
          "model": "free-tier",
          "billedOn": "Storage and connection hours, wherever it is hosted.",
          "freeTierLimit": "Managed Postgres is typically free to about 500MB and then is not."
        }
      }
    ],
    "toolchain": [{ "name": "node", "versionRange": ">=22" }],
    "setupSteps": [
      {
        "title": "Create Stripe API keys",
        "instructions": "Open the Stripe dashboard, create a restricted key, paste it when asked.",
        "satisfies": ["STRIPE_SECRET_KEY"],
        "manual": true
      },
      {
        "title": "Register the webhook endpoint",
        "instructions": "Point Stripe at /api/checkout/webhook and copy the signing secret.",
        "command": "stripe listen --forward-to localhost:3000/api/checkout/webhook",
        "verifyCommand": "node scripts/verify-webhook.mjs",
        "satisfies": ["STRIPE_WEBHOOK_SECRET"]
      }
    ],
    "preflightCommand": "node scripts/preflight.mjs"
  },
  "interfaces": [
    {
      "kind": "api",
      "id": "checkout-api",
      "title": "Checkout API",
      "protocol": "http",
      "serviceId": "web",
      "basePath": "/api/checkout",
      "specPath": "schemas/openapi.json",
      "operations": [
        {
          "operationId": "create-session",
          "method": "POST",
          "path": "/sessions",
          "summary": "Creates a Stripe checkout session for a cart.",
          "authentication": "session",
          "requiresEnvironment": ["STRIPE_SECRET_KEY"]
        },
        {
          "operationId": "stripe-webhook",
          "method": "POST",
          "path": "/webhook",
          "summary": "Receives payment lifecycle events from Stripe.",
          "authentication": "signature"
        }
      ]
    },
    {
      "kind": "web",
      "id": "checkout-ui",
      "title": "Checkout return page",
      "serviceId": "web",
      "basePath": "/checkout",
      "framework": "react",
      "requiresAuthentication": false
    },
    {
      "kind": "cli",
      "id": "checkout-cli",
      "title": "Order tools",
      "binary": "checkout",
      "commands": [
        {
          "name": "reconcile",
          "usage": "checkout reconcile --since 24h",
          "summary": "Replays unmatched Stripe events against local orders."
        }
      ]
    },
    {
      "kind": "mcp",
      "id": "checkout-mcp",
      "title": "Checkout tools for agents",
      "transport": "stdio",
      "command": "node dist/mcp.js",
      "tools": [{ "name": "create-session", "summary": "Creates a checkout session." }]
    }
  ],
  "runtime": {
    "target": "node",
    "versionRange": ">=22",
    "commands": {
      "install": { "command": "npm ci" },
      "build": { "command": "npm run build" },
      "start": { "command": "node dist/server.js", "description": "Serves the API and return page." },
      "dev": { "command": "npm run dev" },
      "test": { "command": "npm test" },
      "migrate": { "command": "npm run db:migrate" },
      "healthcheck": { "command": "curl -fsS localhost:3000/healthz" }
    },
    "services": [
      {
        "id": "web",
        "title": "Checkout server",
        "protocol": "http",
        "binding": { "type": "environment", "envVar": "PORT", "defaultPort": 3000 },
        "exposure": "public",
        "healthPath": "/healthz"
      }
    ],
    "container": { "dockerfilePath": "Dockerfile", "composePath": "compose.yaml" }
  },
  "permissions": {
    "network": [
      {
        "host": "api.stripe.com",
        "purpose": "Creates checkout sessions and reads payment intents.",
        "ports": [443],
        "required": true,
        "dataClasses": ["payment", "pii"]
      },
      {
        "host": "*.stripe.com",
        "purpose": "Redirects the buyer to the hosted checkout page.",
        "dataClasses": ["none"]
      }
    ],
    "acceptsInboundNetwork": true,
    "filesystem": [
      {
        "root": "data",
        "path": "receipts",
        "access": "read-write",
        "purpose": "Caches generated receipt PDFs."
      }
    ],
    "secrets": [
      { "name": "STRIPE_SECRET_KEY", "purpose": "Signs Stripe API calls." },
      { "name": "STRIPE_WEBHOOK_SECRET", "purpose": "Verifies inbound webhook signatures." }
    ],
    "process": { "spawnsSubprocesses": true, "commands": ["node scripts/preflight.mjs"] }
  },
  "verification": {
    "record": {
      "measuredAt": "2026-08-07T18:00:00.000Z",
      "scope": "lineage",
      "installsAttempted": 41,
      "installsSucceeded": 37,
      "deploymentsAttempted": 37,
      "deploymentsSurviving": 29,
      "survival": { "cohortSize": 37, "aliveAtDay30": 31, "aliveAtDay60": 27, "aliveAtDay90": 22 },
      "cumulativeServiceDays": 2940,
      "longestServiceDays": 188,
      "firstDeployedAt": "2026-02-01T10:00:00.000Z",
      "breakagesCaught": 2,
      "breakagesFixed": 1,
      "knowledgeContradictions": 1
    },
    "checks": [
      {
        "id": "webhook-idempotency",
        "title": "Replays a duplicate payment_intent.succeeded and expects one order.",
        "command": "npm run test:idempotency",
        "runsOn": ["install", "schedule"],
        "guardsFailureModeId": "webhook-retry-double-charge",
        "runs": 812,
        "passes": 810,
        "deploymentsCovered": 29,
        "lastRunAt": "2026-08-07T06:00:00.000Z",
        "lastOutcome": "pass"
      },
      {
        "id": "restricted-key-scopes",
        "title": "Calls both Stripe endpoints the pack needs with the supplied key.",
        "command": "node scripts/verify-key.mjs",
        "runsOn": ["install"],
        "runs": 37,
        "passes": 33,
        "deploymentsCovered": 37,
        "lastRunAt": "2026-08-05T12:00:00.000Z",
        "lastOutcome": "pass"
      }
    ],
    "attestations": [
      {
        "attestedAt": "2026-08-07T18:00:00.000Z",
        "attestedBy": { "type": "user", "userId": "user-reviewer", "displayName": "Acme Platform" },
        "did": ["installed-from-clean", "ran-checks", "deployed-to-production"],
        "conditions": {
          "observedAt": "2026-08-07T18:00:00.000Z",
          "accountTier": "standard",
          "regions": ["us"]
        },
        "note": "Installed into an unrelated Next.js storefront from a clean checkout."
      }
    ]
  },
  "visibility": { "scope": "public" },
  "integration": {
    "prompt": "Add the stripe-checkout pack. Ask the user for STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET and CHECKOUT_SUCCESS_URL, then POST the cart to /api/checkout/sessions and redirect the buyer to the returned URL. Handle the /api/checkout/webhook callback to mark the order paid.",
    "installCommand": "t3 pack install acme/stripe-checkout@1.2.0",
    "variants": [
      {
        "target": "lovable",
        "prompt": "Create a checkout button that POSTs the cart to /api/checkout/sessions."
      }
    ],
    "snippets": [
      {
        "title": "Create a session",
        "language": "typescript",
        "code": "const { url } = await createCheckoutSession({ items });"
      }
    ],
    "followUpQuestions": ["Which currency should orders settle in?"]
  },
  "analytics": {
    "events": [
      {
        "name": "checkout.session_created",
        "source": "backend",
        "description": "A checkout session was created for a cart.",
        "properties": [
          { "name": "amount_minor", "type": "number", "pii": false },
          { "name": "buyer_email", "type": "string", "pii": true }
        ]
      },
      {
        "name": "checkout.payment_succeeded",
        "source": "backend",
        "description": "Stripe confirmed the payment intent."
      }
    ],
    "meteredOperations": ["create-session", "stripe-webhook"],
    "metrics": [
      {
        "id": "sessions-created",
        "title": "Checkout sessions created",
        "kind": "count",
        "source": { "type": "event", "event": "checkout.session_created" }
      },
      {
        "id": "webhook-latency",
        "title": "Webhook latency",
        "kind": "latency-p95",
        "source": { "type": "operation", "operationId": "stripe-webhook" },
        "unit": "ms"
      }
    ],
    "sink": { "kind": "t3" }
  },
  "contents": {
    "readmePath": "README.md",
    "licensePath": "LICENSE",
    "iconPath": "assets/icon.svg",
    "sourceRoot": "source",
    "examplesRoot": "examples",
    "archiveSha256": "0011223344556677889900112233445566778899001122334455667788990011"
  },
  "signature": {
    "keyId": "key_ed25519_01",
    "algorithm": "ed25519",
    "publicKey": "bXktcHVibGljLWtleQ==",
    "manifestSha256": "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    "contentsSha256": "0011223344556677889900112233445566778899001122334455667788990011",
    "signature": "c2lnbmF0dXJlLWJ5dGVz",
    "signedAt": "2026-08-07T18:05:00.000Z"
  }
}
```

Read the two knowledge entries against each other. The failure mode is what
production paid for and the maintenance agent wrote down; the credential entry is
what a human once worked out in a console and twenty-six installs have since
confirmed. Neither is derivable from the source, both carry the conditions they
held under, and both name the release that introduced them so an installer can
tell what it inherits by upgrading. The `frozen` boundary decision points back at
the failure mode that froze it, so the pack can tell an agent *why* not to
refactor the thing it is about to refactor.

The minimal end of the range is much shorter — identity, provenance with a
handover, one sentence of capability, `"knowledge": {}`, `"requirements": {}`, one
interface, a runtime target, `"permissions": {}`, a zeroed `verification.record`,
a visibility scope and an integration prompt. That pack is honest about having
learned nothing, which is the correct thing for it to say on the day it is cut.
See `packages/contracts/src/pack.test.ts` for both ends decoded.

## Open questions

These need a product decision before the CLI, marketplace and deploy waves can
be built on top. They are called out rather than guessed at because each one
changes the format.

1. **Does a pack carry source, or a reference to it?** The format currently
   assumes the code travels inside the directory. A pack that is a thin pointer
   at a git repository is a different distribution model with different
   verification and licensing implications, and the two cannot be bolted
   together later without a format bump.
2. **Is signing mandatory for public packs?** `signature` is optional, which
   means an unsigned public pack is currently possible. Making it
   mandatory requires deciding where publisher private keys live — on the user's
   machine, or held server-side by T3 — and those are very different trust
   stories.
3. **Are workspace-private packs encrypted at rest to the workspace key?** The
   `PackWorkspaceKeyId` concept supports it, but the format does not yet describe
   envelope encryption. If the marketplace is expected to host private packs it
   cannot read, that has to be designed now.
4. **Who owns a pack when its author leaves an organisation?** `identity.id` is
   permanent and the publisher block is not, so transfer is expressible — but
   what happens to the scar record is undecided, and it is now the valuable half.
   A new publisher inheriting thirty-seven deployments' worth of earned signal
   without inheriting the operator who earned it is a laundering path.
5. **What decides how much of a lineage record a release may claim?** Knowledge
   is now per pack and behaviour per release, with `record.scope` saying which
   is which — but the only signal for how much continuity a release inherits is
   semver, and semver is declared by the author. A `1.2.1` that rewrote the
   webhook handler sits inside a lineage record it did not earn, and nothing in
   the format contradicts it. A content digest diff between releases could, at
   the cost of the registry holding every release's `contents`.
6. **Who is allowed to write `verification.record`?** If the SDK is opened so
   other platforms' agents can install packs, the counts come from runtimes T3
   does not operate, and self-reported production signals are self-attestation
   with extra steps. The telemetry contract behind these numbers is load-bearing
   and the format does not yet say anything about how a count is authenticated.
7. **Do requirements need a machine-checkable satisfaction protocol?**
   `preflightCommand` is a shell command, which means running untrusted code to
   find out whether untrusted code can run. A declarative preflight (check these
   variables are set, this port is free, this URL responds) would be safer but
   less expressive.
8. **Who pays for a pack's external accounts?** `costsMoney` flags that a pack
   costs the consumer money, but there is no model for a pack that is itself paid
   for, revenue-shared, or metered. If monetisation is on the roadmap, pricing
   belongs in identity and it changes what the registry must store.
9. **What does a consumer consent to when they install?** Analytics feed the
   maintenance loop, so `analytics.sink: "t3"` is the default the product wants —
   but a deployment that reports its failures upstream is disclosing its own
   incidents to a marketplace, and the format has no field for that consent. It
   is a privacy decision, not a technical one, and it gates the loop.
10. **How are breaking changes to a pack's own interface signalled?** Semver
    covers the release, but nothing yet states which interfaces changed between
    `1.2.0` and `2.0.0`. A consuming agent upgrading a dependency has to diff two
    manifests to find out.
11. **Is `library` allowed to have no `runtime.commands.start`, or should it be a
    distinct pack kind?** The current answer is a publish-readiness rule, which
    works but leaves `runtime.target: "none"` and an empty command set as a
    representable, meaningless combination.
12. **Should `permissions` be enforced or only reviewed in the first release?**
    The format is written to support enforcement, but shipping enforcement
    without a sandbox that can actually apply it would turn every declaration
    into theatre.

The knowledge sections raise their own, and these are the ones that arrived while
writing them:

13. **What redacts machine-captured knowledge?** A failure mode observed in one
    customer's deployment can carry their table names, their error strings and
    their business logic into a public pack. Machine capture is precisely what
    makes this likely, and there is no redaction marker, no review gate between
    observation and publication, and no way for a deployment to mark its
    telemetry as non-shareable. This is the cost of the design decision that
    makes the loop work, and it is unpaid.
14. **Who is allowed to fit a rot rate, and against what population?**
    `conditions.rot` with `basis: "observed"` is a claim about how fast a fact
    decays, fitted to contradictions the runtime counted. Fitted by whom is
    undecided, and the answer matters: a half-life fitted from one publisher's
    own installs is as self-reported as the counts in question 6, and a
    half-life fitted across the marketplace mixes populations that may rot at
    genuinely different rates. The defaults in `PACK_SURFACE_HALF_LIFE_DAYS` are
    also unmeasured — 45 days for a console path is a considered guess, and the
    first year of contradiction data should replace it.
15. **Who arbitrates contradictory knowledge?** Two deployments can report
    opposite things under identical recorded conditions, which means the
    conditions model is missing an axis nobody has named yet.
    `standing.contradictedInInstalls` counts the disagreement and nothing
    resolves it; the entry keeps asserting itself until a human notices.
16. **Can contributor knowledge stand alongside first-party knowledge?**
    `origin.source` distinguishes where an entry came from, but nothing says
    whether an entry from an outside install ranks equally with one observed on
    infrastructure T3 runs. Deciding late means either retrofitting a trust axis
    or accepting that the scar record is only as good as its least careful
    contributor.
17. **Does an inherited failure mode count towards the dependant's scar record?**
    A pack that inherits a dependency's scar shows a `knowledge.failureModes`
    entry it never personally hit. Counting it inflates the dependant's apparent
    experience; not counting it hides a failure the dependant genuinely carries.
18. **What withdraws knowledge?** `origin.supersedes` corrects an entry and
    nothing removes one. A release that deleted the code a failure mode
    described still carries it, and a `standing.state` of `obsolete` records
    that it cannot recur without taking it out of the reader's way.
19. **Does a release inherit the publication history of the pack, or only its
    own?** `PackRelease.publications` is per release, so a pack that has been
    public for a year and cuts a new release starts that release's log empty
    even though the pack is plainly public. Both readings are defensible: the
    release genuinely has not been published yet, and the consumer plainly can
    see it. The dashboard currently reads the release's own log, which is the
    conservative answer and the one that will look wrong first.
20. **Is `cost` a property of the requirement or of the deployment?** A Postgres
    a consumer already runs costs them nothing extra, and the same declaration
    on a consumer with no database is a new bill. The format states the pack's
    usage and leaves the consumer to price it, which means the cost summary is
    an upper bound for some readers and a lower bound for others, and neither is
    labelled.
