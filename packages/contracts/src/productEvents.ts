import { Schema } from "effect";

import {
  MessageId,
  NonNegativeInt,
  OrganizationId,
  ProductEventId,
  ProjectId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
  UserId,
  WorkspaceId,
} from "./baseSchemas.ts";
import { ProviderKind } from "./orchestration.ts";

export const ProductEventSource = Schema.Literals([
  "web",
  "server",
  "provider-runtime",
  "billing",
  "collaboration",
  "system",
]);
export type ProductEventSource = typeof ProductEventSource.Type;

export const ProductEventVisibility = Schema.Literals(["internal", "tenant", "organization"]);
export type ProductEventVisibility = typeof ProductEventVisibility.Type;

export const ProductEventActor = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user"),
    userId: UserId,
  }),
  Schema.Struct({
    type: Schema.Literal("system"),
    name: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("provider"),
    provider: ProviderKind,
  }),
]);
export type ProductEventActor = typeof ProductEventActor.Type;

export const ProductEventContext = Schema.Struct({
  tenantId: TenantId,
  organizationId: Schema.NullOr(OrganizationId),
  workspaceId: Schema.NullOr(WorkspaceId),
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(ThreadId),
  turnId: Schema.NullOr(TurnId),
  messageId: Schema.NullOr(MessageId),
  providerAccountId: Schema.NullOr(ProviderAccountId),
  providerSessionId: Schema.NullOr(ProviderSessionId),
});
export type ProductEventContext = typeof ProductEventContext.Type;

export const ProductEventRetention = Schema.Struct({
  analyticsTtlDays: NonNegativeInt,
  auditTtlDays: NonNegativeInt,
  containsPromptText: Schema.Boolean,
  containsResponseText: Schema.Boolean,
  containsSecretMaterial: Schema.Boolean,
  redaction: Schema.Literals(["none", "hashed-content", "metadata-only"]),
});
export type ProductEventRetention = typeof ProductEventRetention.Type;

export const ProductPromptEventPayload = Schema.Struct({
  kind: Schema.Literal("prompt.submitted"),
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  interactionMode: Schema.Literals(["default", "plan"]),
  attachmentCount: NonNegativeInt,
  promptCharacters: NonNegativeInt,
});
export type ProductPromptEventPayload = typeof ProductPromptEventPayload.Type;

export const ProductResponseEventPayload = Schema.Struct({
  kind: Schema.Literals(["response.started", "response.completed", "response.failed"]),
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  durationMs: NonNegativeInt,
  errorClass: Schema.optional(TrimmedNonEmptyString),
});
export type ProductResponseEventPayload = typeof ProductResponseEventPayload.Type;

export const ProductTokenUsageEventPayload = Schema.Struct({
  kind: Schema.Literal("token_usage.recorded"),
  provider: ProviderKind,
  model: TrimmedNonEmptyString,
  inputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  reasoningTokens: NonNegativeInt,
  cachedInputTokens: NonNegativeInt,
  totalTokens: NonNegativeInt,
});
export type ProductTokenUsageEventPayload = typeof ProductTokenUsageEventPayload.Type;

export const ProductCreditEventPayload = Schema.Struct({
  kind: Schema.Literals(["credits.reserved", "credits.consumed", "credits.refunded"]),
  creditAmount: NonNegativeInt,
  currency: TrimmedNonEmptyString,
  billingAccountId: Schema.NullOr(TrimmedNonEmptyString),
  reason: TrimmedNonEmptyString,
});
export type ProductCreditEventPayload = typeof ProductCreditEventPayload.Type;

export const ProductCollaborationEventPayload = Schema.Struct({
  kind: Schema.Literals([
    "collaboration.joined",
    "collaboration.left",
    "collaboration.invited",
    "collaboration.invite_accepted",
    "collaboration.message_sent",
  ]),
  participantUserId: UserId,
  inviteId: Schema.optional(TrimmedNonEmptyString),
  messageCharacters: Schema.optional(NonNegativeInt),
});
export type ProductCollaborationEventPayload = typeof ProductCollaborationEventPayload.Type;

export const ProductWorkflowEventPayload = Schema.Struct({
  kind: Schema.Literals([
    "workflow.task_assigned",
    "workflow.delivery_created",
    "workflow.delivery_accepted",
    "workflow.delivery_rejected",
  ]),
  workflowId: TrimmedNonEmptyString,
  assigneeUserId: Schema.NullOr(UserId),
  status: TrimmedNonEmptyString,
});
export type ProductWorkflowEventPayload = typeof ProductWorkflowEventPayload.Type;

export const ProductMessageEventPayload = Schema.Struct({
  kind: Schema.Literals(["message.created", "message.edited", "message.redacted"]),
  role: Schema.Literals(["user", "assistant", "system"]),
  messageCharacters: NonNegativeInt,
});
export type ProductMessageEventPayload = typeof ProductMessageEventPayload.Type;

export const ProductEventPayload = Schema.Union([
  ProductPromptEventPayload,
  ProductResponseEventPayload,
  ProductTokenUsageEventPayload,
  ProductCreditEventPayload,
  ProductCollaborationEventPayload,
  ProductWorkflowEventPayload,
  ProductMessageEventPayload,
]);
export type ProductEventPayload = typeof ProductEventPayload.Type;

export const ProductEvent = Schema.Struct({
  id: ProductEventId,
  occurredAt: TrimmedNonEmptyString,
  receivedAt: TrimmedNonEmptyString,
  source: ProductEventSource,
  visibility: ProductEventVisibility,
  actor: ProductEventActor,
  context: ProductEventContext,
  retention: ProductEventRetention,
  payload: ProductEventPayload,
});
export type ProductEvent = typeof ProductEvent.Type;

export const PRODUCT_EVENT_CATALOG = [
  "prompt.submitted",
  "response.started",
  "response.completed",
  "response.failed",
  "token_usage.recorded",
  "credits.reserved",
  "credits.consumed",
  "credits.refunded",
  "collaboration.joined",
  "collaboration.left",
  "collaboration.invited",
  "collaboration.invite_accepted",
  "collaboration.message_sent",
  "workflow.task_assigned",
  "workflow.delivery_created",
  "workflow.delivery_accepted",
  "workflow.delivery_rejected",
  "message.created",
  "message.edited",
  "message.redacted",
] as const satisfies readonly ProductEventPayload["kind"][];

export type ProductEventKind = (typeof PRODUCT_EVENT_CATALOG)[number];
