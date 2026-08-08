# The `.pack` format

A pack is a workspace turned into something a stranger can install. Somebody
builds a payment flow inside a T3 workspace, asks their agent to "make this a
pack", and the result is a self-describing artefact that another person — or
another person's agent — can find, understand, set up and run.

Everything else in the pack ecosystem is a reader or a writer of this format.
The CLI writes it. The marketplace indexes, ranks and verifies it. Pack mode
searches it so a coding agent can decide whether an existing pack solves the
problem in front of it. The deploy surface reads it to know what to start, what
to expose and what to chart. That makes the format the keystone: a mistake here
is a mistake in four products.

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

- **Review.** A pack is meant to be verified by a human reviewer, and the review
  outcome is the marketplace's core trust signal. A directory diffs, so a
  reviewer sees "this release changed `permissions.network` and three files in
  `source/`". An opaque blob has to be unpacked before anyone can say anything
  about it, and re-reviews degenerate into re-reading everything.
- **Authoring.** The pack is produced incrementally by an agent working inside a
  workspace. Writing files into a directory is something an agent already does
  well with the tools it has. Producing a single valid archive in one shot, and
  editing it afterwards, is not.

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
significant, is. The initial release is `1.0`, and `PackFormatVersion` is a
literal union so an unknown version is a decode failure rather than a warning.

## Manifest anatomy

Sections are grouped by the question they answer, in the order a consumer asks
them.

| Section | Question |
| --- | --- |
| `identity` | Who made this, what is it called, which version, under what licence |
| `provenance` | Where did it come from, when, and what did the agent say about it |
| `capability` | What does it actually do |
| `requirements` | What must I supply before it will run |
| `interfaces` | How do I touch it |
| `runtime` | How does it start and what does it listen on |
| `permissions` | What will it reach for |
| `verification` | Has anyone checked it |
| `visibility` | Who is allowed to see it |
| `integration` | How do I get another agent to use it |
| `analytics` | What will it report once it is running |
| `contents`, `signature` | Which bytes are these, and who says so |

### Identity

`id` is opaque and permanent. `name`, `displayName`, publisher and even
ownership can all change; the id does not, which is what lets install records,
analytics series and verification decisions survive a rename or a transfer.
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

Signing is optional in `1.0` — see the open questions.

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
  with signup URL, required scopes and a `costsMoney` flag. `providesEnvironment`
  links an account to the variables it hands out.
- `services` — infrastructure the consumer must run (Postgres, Redis, SMTP).
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

### Verification

`verification` is a tagged union: `unverified`, `pending`, `verified`,
`rejected`, `revoked`. Union rather than a status string plus optional fields,
so a `verified` state without a verifier, a timestamp and the list of what was
actually checked is unrepresentable.

**The publisher may only write `unverified`.** Every other state is owned by the
registry, which overwrites this block on publish. A self-asserted badge is worth
nothing, and a format that lets a manifest claim `verified` invites exactly that
forgery. Checks are a closed set of ids (`secret-scan`, `permissions-reviewed`,
`build-reproducible`, …) with `pass` / `fail` / `waived` outcomes, so "verified"
means something specific and a waiver is visible rather than silent.
`expiresAt` exists because verification is pinned to bytes and a year-old review
of a live dependency tree is not a fact about today.

### Visibility

`workspace` (private to its origin), `tenant`, `organization`, `unlisted`
(reachable by link, absent from search) and `public`. The scoped variants carry
their own id so an installer can refuse a pack that wandered outside its
boundary. `unlisted` exists because "share this with one client" and "put this
in the marketplace" are different requests and collapsing them forces publishers
to choose between over-sharing and not sharing.

### Integration

`integration.prompt` is required and inline: the copyable block a user pastes
into Lovable, Replit, Cursor or another agent to have it start using the pack. It
is inline rather than a file path because a search result must be immediately
actionable without a second fetch. `variants` allow per-target rewrites — the
same instructions land differently in a tool that owns its own hosting than in
one that does not. `followUpQuestions` are what the consuming agent should ask
its user before wiring anything up.

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

## Worked example

A payment flow extracted from a working storefront workspace — the
motivating case for the whole format.

```json
{
  "formatVersion": "1.0",
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
        "providesEnvironment": ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]
      }
    ],
    "services": [
      {
        "kind": "postgres",
        "name": "orders",
        "purpose": "Stores orders and their payment state.",
        "versionRange": ">=14",
        "connectionEnvVar": "DATABASE_URL"
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
    "status": "verified",
    "verifiedAt": "2026-08-07T18:00:00.000Z",
    "verifier": { "displayName": "T3 Pack Review", "userId": "user-reviewer" },
    "checks": [
      { "id": "manifest-schema", "outcome": "pass" },
      { "id": "secret-scan", "outcome": "pass" },
      { "id": "permissions-reviewed", "outcome": "pass" },
      { "id": "build-reproducible", "outcome": "waived", "note": "Build not yet deterministic." }
    ],
    "expiresAt": "2027-08-07T18:00:00.000Z"
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

The minimal end of the range is much shorter — identity, provenance with a
handover, one sentence of capability, `"requirements": {}`, one interface, a
runtime target, `"permissions": {}`, `unverified`, a visibility scope and an
integration prompt. See `packages/contracts/src/pack.test.ts` for both ends
decoded.

## Open questions

These need a product decision before the CLI, marketplace and deploy waves can
be built on top. They are called out rather than guessed at because each one
changes the format.

1. **Does a pack carry source, or a reference to it?** The format currently
   assumes the code travels inside the directory. A pack that is a thin pointer
   at a git repository is a different distribution model with different
   verification and licensing implications, and the two cannot be bolted
   together later without a format bump.
2. **Is signing mandatory for public packs?** `signature` is optional in `1.0`,
   which means an unsigned public pack is currently possible. Making it
   mandatory requires deciding where publisher private keys live — on the user's
   machine, or held server-side by T3 — and those are very different trust
   stories.
3. **Are workspace-private packs encrypted at rest to the workspace key?** The
   `PackWorkspaceKeyId` concept supports it, but the format does not yet describe
   envelope encryption. If the marketplace is expected to host private packs it
   cannot read, that has to be designed now.
4. **Who owns a pack when its author leaves an organisation?** `identity.id` is
   permanent and the publisher block is not, so transfer is expressible — but
   what happens to an existing verification, and to installs that trusted the old
   publisher key, is undecided.
5. **What exactly does "verified" promise?** The check list is a closed set, but
   whether verification means "reviewed by a human", "passed automated scans" or
   "we will refund you if it breaks" determines the marketplace's liability and
   the effort per review. A `waived` outcome on `build-reproducible` is currently
   compatible with a verified badge; whether that is acceptable is a policy call.
6. **Does verification survive a patch release?** `expiresAt` handles time, not
   content. Re-verifying every patch is expensive; auto-inheriting verification
   across versions is exactly how a supply chain gets attacked.
7. **Do requirements need a machine-checkable satisfaction protocol?**
   `preflightCommand` is a shell command, which means running untrusted code to
   find out whether untrusted code can run. A declarative preflight (check these
   variables are set, this port is free, this URL responds) would be safer but
   less expressive.
8. **Who pays for a pack's external accounts?** `costsMoney` flags that a pack
   costs the consumer money, but there is no model for a pack that is itself paid
   for, revenue-shared, or metered. If monetisation is on the roadmap, pricing
   belongs in identity and it changes what the registry must store.
9. **Where do analytics actually land?** `analytics.sink` allows `t3`, `none` or
   `custom`, but whether the T3 deployment dashboard ingests pack events by
   default — and what the consumer consents to when they install — is
   undecided, and it is a privacy decision, not a technical one.
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
