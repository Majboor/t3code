import assert from "node:assert/strict";

import { it } from "@effect/vitest";

import { EventId, ThreadId, type ProviderEvent } from "@t3tools/contracts";

import { mapToRuntimeEvents } from "./GlmAdapter.ts";

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
