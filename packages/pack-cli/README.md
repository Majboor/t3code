# @t3tools/pack-cli

A tool for a coding agent. It finds, inspects, scaffolds and publishes packs.

You are the primary consumer, not a person at a terminal. Every command writes
one JSON object to stdout and exits zero, or writes one JSON error object and
exits non-zero. `--human` swaps the JSON for text.

```
t3-pack search <query> [--limit n] [--category c] [--tag t]
t3-pack show <name|publisher/name>[@version] [--version v]
t3-pack init <name> [--dir d] [--publisher p] [--summary s] [--does d]
t3-pack validate [--dir d]
t3-pack publish [--dir d] [--dry-run]
t3-pack version (--set <semver> | --bump major|minor|patch) [--dir d]
t3-pack help
```

Global flags: `--human`, `--registry <path>`, `--server <url>`, `--token <t>`.
The registry defaults to `$T3CODE_PACK_REGISTRY`, then `$T3CODE_HOME/packs`,
then `~/.t3code/packs`. With `--server` the same registry is read through a T3
server over the SDK instead of off local disk.

`t3-pack help` returns this surface as JSON, including the exit codes, so you can
read it instead of this file.

## When to reach for this instead of writing the code

Search **before** generating any integration that touches a third-party
provider: payments, auth, webhooks, email, storage, anything with an API key.

A package gives you a library. A pack gives you the integration — the auth flow,
the key retrieval, the webhook handling, and the decisions between the SDK and
the app. The part you cannot derive from source is what a pack carries:

- **Failure modes** production already paid for, with how to detect each one
  again and whether it is fixed, mitigated or still open.
- **Integration knowledge**: the console path to the right credential with the
  right scopes, the wiring prompt, the patterns, and the decisions that must not
  be changed — each with the conditions it was observed under and, often, the
  wrong answer a model gives when it has to guess.

Do not pitch a pack as a way to write less code. Pitch it as the thing that is
already correct in the case you are about to get wrong. `search` gives you a
composed `suggestion.line` for exactly that, plus the numbers behind it.

## The JSON shapes

Every invocation:

```json
{ "ok": true, "command": "search", "result": { } }
{ "ok": false, "command": "show", "error": { "code": "pack-not-found", "message": "…", "detail": { } } }
```

In JSON mode both go to stdout. In `--human` mode the error goes to stderr.

| Exit | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | success                                                            |
| 2    | usage — the command was wrong, rewrite it                          |
| 3    | pack or manifest not found — widen the search                      |
| 4    | manifest invalid, or written for another format version            |
| 5    | not publishable — `error.detail` carries the full readiness report |
| 6    | that version is already recorded                                   |
| 7    | registry or io failure                                             |

### `search`

```json
{
  "query": "webhook idempotency",
  "registry": "/home/you/.t3code/packs",
  "scanned": 12,
  "returned": 1,
  "unreadable": [{ "directory": "old.pack", "reason": "…" }],
  "results": [
    {
      "ref": {
        "id": "pack_01J",
        "name": "stripe-checkout",
        "version": "1.2.0",
        "publisher": "acme",
        "qualified": "acme/stripe-checkout@1.2.0"
      },
      "displayName": "Stripe Checkout",
      "summary": "…",
      "does": "…",
      "categories": ["payments"],
      "tags": ["stripe"],
      "nonGoals": ["…"],
      "interfaceKinds": ["api", "web", "cli", "mcp"],
      "license": "Apache-2.0",
      "visibility": "public",

      "setup": {
        "environment": [
          {
            "name": "STRIPE_SECRET_KEY",
            "purpose": "…",
            "secret": true,
            "required": true,
            "obtainUrl": "…"
          }
        ],
        "accounts": [{ "service": "stripe", "costsMoney": true }],
        "services": [],
        "toolchain": [],
        "dependsOnPacks": [],
        "setupSteps": 2,
        "manualSteps": 1,
        "preflightCommand": "…"
      },

      "signals": {
        "measuredAt": "2026-08-07T18:00:00.000Z",
        "installsAttempted": 41,
        "installsSucceeded": 37,
        "deploymentsAttempted": 37,
        "deploymentsSurviving": 29,
        "cumulativeServiceDays": 2940,
        "longestServiceDays": 188,
        "breakagesCaught": 2,
        "breakagesFixed": 1,
        "knowledgeContradictions": 1,
        "survival": { "cohortSize": 37, "aliveAtDay30": 31 },
        "checks": [
          {
            "id": "webhook-idempotency",
            "guardsFailureModeId": "…",
            "runs": 812,
            "passes": 810,
            "deploymentsCovered": 29
          }
        ],
        "attestations": [],
        "advisories": []
      },

      "handles": [
        {
          "id": "webhook-retry-double-charge",
          "symptom": "…",
          "trigger": "…",
          "triggerKinds": ["retry", "idempotency"],
          "severity": "critical",
          "silent": true,
          "resolution": "fixed",
          "fixedIn": "1.1.0",
          "deploymentsAffected": 11,
          "conditions": {
            "observedAt": "…",
            "accountTier": "standard",
            "regions": ["us"],
            "untestedAxes": ["plan"],
            "caveat": "Observed on standard-tier us in June 2026 … Yours may differ."
          }
        }
      ],
      "openFailureModes": [],
      "knowledge": {
        "failureModes": 2,
        "openFailureModes": 1,
        "integrationEntries": 3,
        "credentialGuides": 1,
        "oldestObservedAt": "2026-06-18T22:40:00.000Z",
        "contradicted": 0
      },
      "installCommand": "t3 pack install acme/stripe-checkout@1.2.0",

      "score": 11,
      "matched": ["webhook", "idempotency"],
      "suggestion": {
        "line": "There's a pack for this. acme/stripe-checkout@1.2.0 is running in 29 deployments, the longest of them for 188 days and handles the retry and idempotency case that breaks most implementations.",
        "caveats": ["…"],
        "evidence": {
          "deploymentsSurviving": 29,
          "leadingFailureModeId": "webhook-retry-double-charge"
        }
      }
    }
  ]
}
```

There is no trust tier and no verified flag, on purpose. A tier is coarser than
the decision you are making: the bar for a payment flow is not the bar for a
changelog widget. Threshold the raw numbers yourself. The ones that carry the
most weight:

- `signals.deploymentsSurviving` — the only count that cannot be inflated by
  trying again.
- `signals.installsSucceeded` against `installsAttempted` — a denominator you
  can see.
- `knowledge.openFailureModes` and `handles[].severity` — what is still broken
  versus what has been closed.
- `knowledge.contradicted` and `signals.knowledgeContradictions` — installs that
  followed the carried knowledge and found it wrong. The provider-churn alarm.
- `signals.advisories` — non-empty means somebody pulled or flagged this.

**Absent is not zero.** A field the pack does not record is omitted from the
JSON; a field it records as zero is present and zero. `"deploymentsSurviving":
0` means nothing survives, and no `deploymentsSurviving` key means nobody
measured. Do not conflate them.

### `show`

Everything in a `search` result, plus `description`, `useCases`,
`integrationKnowledge` (with `navigation` steps, `scopes`, `rotation`,
`commonMistake`, `standing`, `decisions`), `interfaces`, `runtime`,
`permissions`, `integration` (prompt, variants, snippets, follow-up questions)
and `provenance`.

Read `integrationKnowledge[].commonMistake` before you write anything. It is a
record of what a model produces when it guesses, so you can recognise yourself
about to give the same answer.

Read `conditions.caveat` and repeat it rather than asserting. "Verified on
standard-tier US in July — yours may differ" turns a trust-destroying failure
into a mild one.

### `init`, `validate`, `publish`, `version`

`init` scaffolds `<name>.pack/` with `pack.json`, `handover.md` and `README.md`.
The manifest it writes has an empty `knowledge` section and a zeroed
verification record, which is the honest thing for a pack to say on the day it
is cut. The handover summary and integration prompt are deliberate placeholders
that `validate` will flag.

`validate` returns `{ publishable, errors, warnings, issues[] }` where each issue
is `{ code, severity, path, message }`. Errors block a publish; warnings never
do — a pack has to be publishable before it can earn anything. When it is not
publishable the command exits 5 and the same report is in `error.detail`.

`publish` always publishes **private to the pack's workspace**, whatever the
manifest's `visibility` claims. Cutting a pack and letting other people see it
are two decisions, and the second one is not the manifest's to make. The
response echoes `visibility.claimedInManifest` so you can tell the user what was
overridden.

`version` rewrites `identity.version` on the parsed JSON and records that release
in the registry. Earlier releases are never rewritten: a change is always a new
version. The rewrite touches nothing but the version, so a field this CLI does
not understand cannot be dropped by a bump.

## Layout

| File                                            | What it holds                                                                                                                     |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `manifest.ts`                                   | The **only** module that touches manifest fields, or imports `@t3tools/contracts`. Views, readiness facts, writers, dotted paths. |
| `suggest.ts`                                    | The correctness-framed suggestion and the evidence behind it.                                                                     |
| `readiness.ts`                                  | Publish-readiness rules, over the views rather than the manifest.                                                                 |
| `registry.ts`                                   | Search, get and record over a store.                                                                                              |
| `store.ts`, `store-sdk.ts`                      | Where pack directories live: local disk, or a T3 server through the SDK.                                                          |
| `args.ts`, `commands.ts`, `output.ts`, `bin.ts` | Parse, run, render, exit.                                                                                                         |

The pack format is still moving. Because every field read goes through
`manifest.ts`, a renamed or relocated field is a one-file fix — and until it is
fixed, the reads degrade instead of throwing: what the manifest still carries is
emitted, what it does not is omitted, and `search` keeps answering.
