# Product Event Schema

This document covers the first product analytics event model for #31. Product
events are append-only facts used for analytics, reporting, audits, credit
accounting, collaboration views, and leaderboards. They are not the source of
truth for authorization, provider execution, or tenant runtime state.

The schema lives in `packages/contracts/src/productEvents.ts` so server,
runtime, and future dashboard code share the same event envelope without adding
runtime logic to `packages/contracts`.

## Shared Shape

Every product event carries:

- `id`: globally unique product event id.
- `occurredAt` and `receivedAt`: when the source observed the fact and when the
  control plane received it.
- `source`: `web`, `server`, `provider-runtime`, `billing`, `collaboration`, or
  `system`.
- `visibility`: whether the event is internal-only, tenant-visible, or
  organization-visible.
- `actor`: a user, system component, or provider.
- `context`: tenant id plus nullable organization, workspace, project, thread,
  turn, message, provider account, and provider session ids.
- `retention`: analytics TTL, audit TTL, text/secret flags, and redaction mode.
- `payload`: one of the cataloged event payloads below.

The context intentionally favors stable identifiers and counts over raw prompt,
response, file, or secret content. Text-bearing analytics must opt in through
the retention flags and should normally store hashes or aggregate dimensions
instead of user content.

## Event Catalog

| Kind                            | Purpose                                                  |
| ------------------------------- | -------------------------------------------------------- |
| `prompt.submitted`              | User submitted a provider prompt or plan instruction.    |
| `response.started`              | Provider response generation began.                      |
| `response.completed`            | Provider response completed successfully.                |
| `response.failed`               | Provider response failed with an error class.            |
| `token_usage.recorded`          | Provider token/context usage was observed.               |
| `credits.reserved`              | Credits were reserved before a billable operation.       |
| `credits.consumed`              | Credits were consumed after usage reconciliation.        |
| `credits.refunded`              | Reserved or consumed credits were returned.              |
| `collaboration.joined`          | User joined a workspace or thread collaboration surface. |
| `collaboration.left`            | User left or went offline from collaboration.            |
| `collaboration.invited`         | Invite was created for tenant/workspace/project access.  |
| `collaboration.invite_accepted` | Invite was accepted and membership became active.        |
| `collaboration.message_sent`    | Collaboration message metadata was recorded.             |
| `workflow.task_assigned`        | Work item was assigned to a user.                        |
| `workflow.delivery_created`     | Deliverable/report/review package was created.           |
| `workflow.delivery_accepted`    | Deliverable was accepted.                                |
| `workflow.delivery_rejected`    | Deliverable was rejected or sent back for changes.       |
| `message.created`               | Tenant thread message metadata was created.              |
| `message.edited`                | Tenant thread message metadata changed.                  |
| `message.redacted`              | Message content was hidden by retention or moderation.   |

## Downstream Dependencies

Cost reporting needs `token_usage.recorded` and credit events keyed by tenant,
organization, provider, model, provider account, provider session, thread, and
turn.

Team dashboards and leaderboards need prompt, response, collaboration,
workflow, and message counts grouped by tenant, workspace, project, user,
provider, model, and time bucket.

Audit and support surfaces need organization-visible or internal events for
invite acceptance, delivery decisions, provider failures, credit adjustments,
and redactions. They should link back to source records rather than relying on
analytics events as the canonical state.

Exports should include metadata events by default. Events whose retention flags
indicate prompt text, response text, or secret material require explicit export
permission and redaction review.

## Retention And Privacy

The v1 defaults should treat product events as metadata-only unless a specific
feature requires text capture. Recommended policy:

- analytics aggregates: retain for 24 months
- organization audit views: retain for 7 years where applicable
- raw provider text: avoid storing in product events
- secrets and provider credentials: never store in product events
- redactions: preserve the event with `message.redacted` and metadata, not the
  removed content

Aggregation jobs should read append-only events into daily tenant, workspace,
project, user, provider, model, and workflow rollups. Dashboards and exports
should query rollups first and fall back to raw events only for drill-down or
audit views.
