import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import type { CreateElicitationRequest, ElicitationSchema } from "@agentclientprotocol/sdk";

import {
  buildElicitationAcceptResponse,
  mapElicitationFormSchema,
  planElicitationRequest,
} from "./glmAcpManager.ts";

/**
 * Tests for `glmAcpManager.ts`'s `elicitation/create` mapping logic.
 *
 * IMPORTANT CAVEAT (see the coordinator's task notes and `GlmAdapter.ts`'s
 * `respondToUserInput` comment): there is no confirmed live evidence that
 * `opencode acp` ever actually sends `elicitation/create` — live testing
 * against real prompts never triggered it, and OpenCode's own agent loop
 * asks clarifying questions as plain conversational text instead. These
 * tests verify the mapping/decline logic is correct *if* the request is
 * ever received; they do not (and cannot, without a live `opencode acp`
 * subprocess) verify this path is ever exercised end-to-end in production.
 *
 * These tests exercise `planElicitationRequest`/`buildElicitationAcceptResponse`
 * directly (the pure decision/round-trip logic), not the `elicitation/create`
 * JSON-RPC handler itself — that handler's pending-promise/subprocess wiring
 * is the same proven-live pattern `session/request_permission` already uses
 * (see `GlmAcpManager.startSession`), and is not independently re-verified
 * here.
 */

function formRequest(requestedSchema: ElicitationSchema, message = "Please provide input."): CreateElicitationRequest {
  return {
    mode: "form",
    sessionId: "session-1",
    message,
    requestedSchema,
  } as CreateElicitationRequest;
}

it("maps a single string-enum form elicitation to a single-select question, and round-trips the chosen answer into an accept response", () => {
  const request = formRequest(
    {
      type: "object",
      properties: {
        color: {
          type: "string",
          title: "Favorite color",
          enum: ["red", "green", "blue"],
        },
      },
    },
    "Which color should I use?",
  );

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.equal(plan.question.propertyName, "color");
  assert.equal(plan.question.multiSelect, false);
  assert.equal(plan.question.questionText, "Favorite color");
  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "red", description: "red" },
      { label: "green", description: "green" },
      { label: "blue", description: "blue" },
    ],
  );

  // Simulate the user picking "green" via T3's existing user-input UI —
  // `buildPendingUserInputAnswers` (apps/web/src/pendingUserInput.ts) submits
  // the option's `label`, not a separate value, as the answer.
  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { color: "green" },
  );
  assert.deepEqual(response, { action: "accept", content: { color: "green" } });
});

it("maps a titled single-select enum (oneOf) using the option's title as the label and its own const as the round-tripped value", () => {
  const request = formRequest({
    type: "object",
    properties: {
      size: {
        type: "string",
        oneOf: [
          { const: "s", title: "Small" },
          { const: "l", title: "Large", description: "Extra room" },
        ],
      },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "Small", description: "Small" },
      { label: "Large", description: "Extra room" },
    ],
  );

  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { size: "Large" },
  );
  assert.deepEqual(response, { action: "accept", content: { size: "l" } });
});

it("maps a boolean form field to a Yes/No question and round-trips to a real boolean in the accept response", () => {
  const request = formRequest({
    type: "object",
    properties: {
      confirm: { type: "boolean", title: "Proceed?" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;

  assert.deepEqual(
    [...plan.question.options],
    [
      { label: "Yes", description: "Yes" },
      { label: "No", description: "No" },
    ],
  );

  const accepted = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { confirm: "Yes" },
  );
  assert.deepEqual(accepted, { action: "accept", content: { confirm: true } });

  const declined = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { confirm: "No" },
  );
  assert.deepEqual(declined, { action: "accept", content: { confirm: false } });
});

it("maps a multi-select array field (anyOf) to a multiSelect question and round-trips multiple chosen values", () => {
  const request = formRequest({
    type: "object",
    properties: {
      toppings: {
        type: "array",
        items: {
          anyOf: [
            { const: "cheese", title: "Cheese" },
            { const: "olives", title: "Olives" },
            { const: "mushroom", title: "Mushroom" },
          ],
        },
      },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "ask");
  if (plan.kind !== "ask") return;
  assert.equal(plan.question.multiSelect, true);

  const response = buildElicitationAcceptResponse(
    { propertyName: plan.question.propertyName, multiSelect: plan.question.multiSelect, valueByLabel: plan.question.valueByLabel },
    { toppings: ["Cheese", "Mushroom"] },
  );
  assert.deepEqual(response, { action: "accept", content: { toppings: ["cheese", "mushroom"] } });
});

it("declines a url-mode elicitation instead of erroring", () => {
  const request: CreateElicitationRequest = {
    mode: "url",
    sessionId: "session-1",
    message: "Please sign in via your browser.",
    elicitationId: "elicit-1",
    url: "https://example.com/auth",
  };

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
  if (plan.kind !== "decline") return;
  assert.deepEqual(plan.response, { action: "decline" });
  assert.match(plan.reason, /url/i);
});

it("declines an unrecognized/custom elicitation mode instead of erroring", () => {
  const request = {
    mode: "_vendor-extension-mode",
    sessionId: "session-1",
    message: "Some future elicitation mode.",
  } as unknown as CreateElicitationRequest;

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
  if (plan.kind !== "decline") return;
  assert.deepEqual(plan.response, { action: "decline" });
});

it("declines (does not force a bad UI for) a form schema with more than one property", () => {
  const request = formRequest({
    type: "object",
    properties: {
      first: { type: "string", enum: ["a", "b"] },
      second: { type: "string", enum: ["c", "d"] },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("declines (does not force a bad UI for) a free-text string field with no enum/oneOf", () => {
  const request = formRequest({
    type: "object",
    properties: {
      notes: { type: "string", title: "Notes" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("declines (does not force a bad UI for) a number/integer field", () => {
  const request = formRequest({
    type: "object",
    properties: {
      age: { type: "integer" },
    },
  });

  const plan = planElicitationRequest(request);
  assert.equal(plan.kind, "decline");
});

it("mapElicitationFormSchema returns undefined for a schema with no properties at all", () => {
  assert.equal(mapElicitationFormSchema({ type: "object" }), undefined);
});

it("buildElicitationAcceptResponse declines rather than fabricating a value for an unrecognized answer label", () => {
  const response = buildElicitationAcceptResponse(
    { propertyName: "color", multiSelect: false, valueByLabel: new Map([["red", "red"]]) },
    { color: "purple" },
  );
  assert.deepEqual(response, { action: "decline" });
});
