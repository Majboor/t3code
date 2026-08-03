import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_EVENT_CATALOG,
  ProductEvent,
  ProductEventId,
  ProjectId,
  ProviderAccountId,
  ProviderSessionId,
  TenantId,
  ThreadId,
  TurnId,
  UserId,
  WorkspaceId,
} from "./index.ts";

const decodeProductEvent = Schema.decodeUnknownSync(ProductEvent);

const baseEvent = {
  id: ProductEventId.make("product-event-1"),
  occurredAt: "2026-05-09T12:00:00.000Z",
  receivedAt: "2026-05-09T12:00:01.000Z",
  source: "server",
  visibility: "tenant",
  actor: {
    type: "user",
    userId: UserId.make("user-1"),
  },
  context: {
    tenantId: TenantId.make("tenant-1"),
    organizationId: null,
    workspaceId: WorkspaceId.make("workspace-1"),
    projectId: ProjectId.make("project-1"),
    threadId: ThreadId.make("thread-1"),
    turnId: TurnId.make("turn-1"),
    messageId: null,
    providerAccountId: ProviderAccountId.make("provider-account-1"),
    providerSessionId: ProviderSessionId.make("provider-session-1"),
  },
  retention: {
    analyticsTtlDays: 730,
    auditTtlDays: 2555,
    containsPromptText: false,
    containsResponseText: false,
    containsSecretMaterial: false,
    redaction: "metadata-only",
  },
} as const;

describe("product event contracts", () => {
  it("decodes prompt events with shared attribution and privacy metadata", () => {
    const parsed = decodeProductEvent({
      ...baseEvent,
      payload: {
        kind: "prompt.submitted",
        provider: "codex",
        model: "gpt-5.4",
        interactionMode: "default",
        attachmentCount: 1,
        promptCharacters: 1200,
      },
    });

    expect(parsed.context.tenantId).toBe("tenant-1");
    expect(parsed.retention.redaction).toBe("metadata-only");
    expect(parsed.payload.kind).toBe("prompt.submitted");
  });

  it("decodes usage and credit events for cost reporting", () => {
    const usage = decodeProductEvent({
      ...baseEvent,
      payload: {
        kind: "token_usage.recorded",
        provider: "claudeAgent",
        model: "claude-sonnet",
        inputTokens: 100,
        outputTokens: 50,
        reasoningTokens: 10,
        cachedInputTokens: 20,
        totalTokens: 160,
      },
    });
    const credits = decodeProductEvent({
      ...baseEvent,
      payload: {
        kind: "credits.consumed",
        creditAmount: 42,
        currency: "t3-credit",
        billingAccountId: "billing-1",
        reason: "provider token usage",
      },
    });

    expect(usage.payload.kind).toBe("token_usage.recorded");
    expect(credits.payload.kind).toBe("credits.consumed");
  });

  it("covers collaboration, workflow, and message catalog entries", () => {
    const collaboration = decodeProductEvent({
      ...baseEvent,
      source: "collaboration",
      payload: {
        kind: "collaboration.message_sent",
        participantUserId: UserId.make("user-2"),
        messageCharacters: 48,
      },
    });
    const workflow = decodeProductEvent({
      ...baseEvent,
      payload: {
        kind: "workflow.delivery_created",
        workflowId: "delivery-1",
        assigneeUserId: UserId.make("user-3"),
        status: "ready-for-review",
      },
    });
    const message = decodeProductEvent({
      ...baseEvent,
      payload: {
        kind: "message.redacted",
        role: "assistant",
        messageCharacters: 0,
      },
    });

    expect(collaboration.payload.kind).toBe("collaboration.message_sent");
    expect(workflow.payload.kind).toBe("workflow.delivery_created");
    expect(message.payload.kind).toBe("message.redacted");
  });

  it("fails closed for negative counters and unknown event kinds", () => {
    expect(() =>
      decodeProductEvent({
        ...baseEvent,
        payload: {
          kind: "token_usage.recorded",
          provider: "codex",
          model: "gpt-5.4",
          inputTokens: -1,
          outputTokens: 0,
          reasoningTokens: 0,
          cachedInputTokens: 0,
          totalTokens: 0,
        },
      }),
    ).toThrow();

    expect(() =>
      decodeProductEvent({
        ...baseEvent,
        payload: {
          kind: "unknown.event",
        },
      }),
    ).toThrow();
  });

  it("keeps the exported catalog in sync with the accepted event kinds", () => {
    expect(PRODUCT_EVENT_CATALOG).toContain("prompt.submitted");
    expect(PRODUCT_EVENT_CATALOG).toContain("credits.consumed");
    expect(PRODUCT_EVENT_CATALOG).toContain("workflow.delivery_created");
    expect(new Set(PRODUCT_EVENT_CATALOG).size).toBe(PRODUCT_EVENT_CATALOG.length);
  });
});
