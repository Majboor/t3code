import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import { EventId, ThreadId, type ProviderEvent } from "@t3tools/contracts";

import { describeResetEta, mapToRuntimeEvents } from "./GlmAdapter.ts";

const threadId = ThreadId.make("thread-1");
const createdAt = "2026-09-17T20:33:40.300Z";

function permissionRequestEvent(
  requestKind: "command" | "file-read" | "file-change" | undefined,
  toolCallTitle?: string,
): ProviderEvent {
  return {
    id: EventId.make("event-1"),
    kind: "request",
    provider: "glm",
    threadId,
    createdAt,
    method: "session/request_permission",
    requestId: "req-1" as ProviderEvent["requestId"],
    ...(requestKind ? { requestKind } : {}),
    payload: toolCallTitle ? { toolCall: { title: toolCallTitle } } : {},
  };
}

/**
 * Regression test for a real, live-reproduced bug: `GlmAdapter.ts` used to
 * hardcode `requestType: "dynamic_tool_call"` for every GLM permission
 * request regardless of `event.requestKind` (which `glmAcpManager.ts`
 * already classifies correctly from the ACP toolCall's own `kind`). Neither
 * the server's `ProviderRuntimeIngestion.ts` projector nor the web client's
 * `session-logic.ts` `derivePendingApprovals` has ever recognized
 * `"dynamic_tool_call"` as a `requestType`, so every GLM approval request
 * silently vanished from the pending-approvals list - the turn sat blocked
 * forever with no visible approve/reject UI, confirmed live via a real
 * pending row in `projection_pending_approvals` with
 * `payload_json: {"requestId":"...","requestType":"dynamic_tool_call"}` and
 * no `requestKind`, which `derivePendingApprovals` requires to render.
 */
it("maps a file-change GLM permission request to file_change_approval, not dynamic_tool_call", () => {
  const events = mapToRuntimeEvents(permissionRequestEvent("file-change", "write"));
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "request.opened");
  const payload = events[0]!.payload as { requestType: string; detail?: string };
  assert.equal(payload.requestType, "file_change_approval");
  assert.equal(payload.detail, "write");
});

it("maps a command GLM permission request to command_execution_approval", () => {
  const events = mapToRuntimeEvents(permissionRequestEvent("command"));
  const payload = events[0]!.payload as { requestType: string };
  assert.equal(payload.requestType, "command_execution_approval");
});

it("maps a file-read GLM permission request to file_read_approval", () => {
  const events = mapToRuntimeEvents(permissionRequestEvent("file-read"));
  const payload = events[0]!.payload as { requestType: string };
  assert.equal(payload.requestType, "file_read_approval");
});

it("falls back to command_execution_approval (ask, don't silently allow) when requestKind is missing", () => {
  const events = mapToRuntimeEvents(permissionRequestEvent(undefined));
  const payload = events[0]!.payload as { requestType: string };
  assert.equal(payload.requestType, "command_execution_approval");
});

/**
 * `glmAcpManager.ts`'s `elicitation/create` handler already shapes its
 * "request" event's payload as `{questions: [UserInputQuestion]}` — these
 * tests only cover this file's own job of relaying that payload into a
 * `user-input.requested`/`user-input.resolved` `ProviderRuntimeEvent`,
 * mirroring `CodexAdapter.ts`'s `item/tool/requestUserInput` mapping. See
 * `glmAcpManager.test.ts` for the actual schema->question mapping logic.
 */
it("maps a raw elicitation/create request event to user-input.requested with its questions intact", () => {
  const question = {
    id: "color",
    header: "Which color should I use?",
    question: "Favorite color",
    options: [
      { label: "red", description: "red" },
      { label: "green", description: "green" },
    ],
    multiSelect: false,
  };
  const event: ProviderEvent = {
    id: EventId.make("event-2"),
    kind: "request",
    provider: "glm",
    threadId,
    createdAt,
    method: "elicitation/create",
    requestId: "req-2" as ProviderEvent["requestId"],
    payload: { questions: [question] },
  };

  const events = mapToRuntimeEvents(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "user-input.requested");
  const payload = events[0]!.payload as { questions: ReadonlyArray<unknown> };
  assert.deepEqual(payload.questions, [question]);
});

it("drops an elicitation/create request event with no questions instead of emitting an empty prompt", () => {
  const event: ProviderEvent = {
    id: EventId.make("event-3"),
    kind: "request",
    provider: "glm",
    threadId,
    createdAt,
    method: "elicitation/create",
    requestId: "req-3" as ProviderEvent["requestId"],
    payload: {},
  };

  assert.deepEqual(mapToRuntimeEvents(event), []);
});

/**
 * Regression test for a real, live-reproduced bug: opencode's own internal
 * ACP/JSON-RPC handling failures (e.g. a `session/cancel` notification the
 * peer rejected with an "Invalid params" error) land on the subprocess's
 * stderr, which `GlmAdapter.ts` used to forward verbatim as a "Runtime
 * warning" activity — surfacing raw `{jsonrpc, method, params}` protocol
 * internals directly in the user's chat, confirmed live via a
 * `projection_thread_activities` row reading exactly this shape. A genuine
 * stderr line (a real crash, a missing dependency) must still pass through.
 */
it("filters opencode's own internal JSON-RPC handling noise out of process/stderr, but keeps real stderr", () => {
  const noiseEvent: ProviderEvent = {
    id: EventId.make("event-stderr-noise"),
    kind: "notification",
    provider: "glm",
    threadId,
    createdAt,
    method: "process/stderr",
    requestId: "req-stderr-noise" as ProviderEvent["requestId"],
    message:
      'Error handling notification {\n  jsonrpc: "2.0",\n  method: "session/cancel",\n  params: {\n    sessionId: "ses_abc",\n  },\n} {\n  code: -32602,\n  message: "Invalid params",\n}',
    payload: {},
  };
  assert.deepEqual(mapToRuntimeEvents(noiseEvent), []);

  const realStderrEvent: ProviderEvent = {
    ...noiseEvent,
    id: EventId.make("event-stderr-real"),
    message: "npm ERR! missing script: build",
  };
  const events = mapToRuntimeEvents(realStderrEvent);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "runtime.warning");
  assert.deepEqual(events[0]!.payload, { message: "npm ERR! missing script: build" });
});

it("maps an elicitation/create/answered notification to user-input.resolved with the answer map", () => {
  const event: ProviderEvent = {
    id: EventId.make("event-4"),
    kind: "notification",
    provider: "glm",
    threadId,
    createdAt,
    method: "elicitation/create/answered",
    requestId: "req-4" as ProviderEvent["requestId"],
    payload: { answers: { color: "green" } },
  };

  const events = mapToRuntimeEvents(event);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, "user-input.resolved");
  assert.deepEqual(events[0]!.payload, { answers: { color: "green" } });
});

/**
 * Regression coverage for a real, live-reproduced gap: the gateway's 5-hour
 * burst limit returns a normal HTTP 429 that opencode's own error handling
 * did not reliably surface — confirmed via a real turn that logged
 * "AI_APICallError: ... burst limit is used up" and then went silent for the
 * rest of the turn, only ending ~2 minutes later via the generic turn
 * watchdog, with no indication anywhere in the UI of the real cause. This is
 * the message-formatting half of the fix that checks the gateway's usage
 * before ever starting a session; the reset time is rendered as a relative
 * duration (not a formatted clock time) because the server has no reliable
 * way to know the viewer's timezone.
 */
describe("describeResetEta", () => {
  it("renders hours and minutes when both are non-zero", () => {
    const resetsAt = new Date(Date.now() + (2 * 60 + 15) * 60_000).toISOString();
    assert.equal(describeResetEta(resetsAt), " — resets in about 2h 15m");
  });

  it("omits the hours part when under an hour remains", () => {
    const resetsAt = new Date(Date.now() + 45 * 60_000).toISOString();
    assert.equal(describeResetEta(resetsAt), " — resets in about 45m");
  });

  it("omits the minutes part when the remainder rounds to exactly on the hour", () => {
    const resetsAt = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
    assert.equal(describeResetEta(resetsAt), " — resets in about 3h");
  });

  it("returns an empty string when there is no reset time yet", () => {
    assert.equal(describeResetEta(null), "");
  });

  it("returns an empty string once the reset time has already passed", () => {
    const resetsAt = new Date(Date.now() - 60_000).toISOString();
    assert.equal(describeResetEta(resetsAt), "");
  });
});
