/**
 * GlmAdapter (Layers) - Effect Layer implementation for the GLM-5.3
 * (LogicPacks) provider adapter.
 *
 * Bridges `GlmAcpManager`'s raw `ProviderEvent`s (emitted over a Node
 * `EventEmitter`, same bridge pattern `CodexAdapter.ts` uses for
 * `CodexAppServerManager`) into this codebase's `ProviderRuntimeEvent` stream.
 *
 * @module GlmAdapter
 */
import { randomUUID } from "node:crypto";
import { Effect, Layer, Option, Queue, Stream } from "effect";

import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  UserId,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type UserInputQuestion,
} from "@t3tools/contracts";

import { LogicPacksGateway } from "../../gateway/Services/LogicPacksGateway.ts";
import { GlmAcpManager } from "../../glmAcpManager.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { GlmAdapter, type GlmAdapterShape } from "../Services/GlmAdapter.ts";

const PROVIDER = "glm" as const;
const OPENCODE_BINARY = "opencode";

function toRequestError(threadId: string, method: string, cause: unknown): ProviderAdapterError {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (message.includes("Unknown session for thread")) {
    return new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId, cause });
  }
  return new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: message, cause });
}

/**
 * Maps one raw GLM `ProviderEvent` (from `GlmAcpManager`) to zero, one, or two
 * `ProviderRuntimeEvent`s — the same fan-out shape `CodexAdapter.ts`'s
 * `mapToRuntimeEvents` uses.
 */
/**
 * Identity function typed as the full `ProviderRuntimeEvent` union.
 *
 * Assigning an object literal to a *variable* annotated `Omit<Union, K>` does
 * not distribute over the union the way TypeScript needs to discriminate it
 * (`Omit` is not distributive), so the naive `const base: Omit<...> = {...}`
 * approach fails to check correctly here even though it works as a *return
 * type* annotation elsewhere in this codebase. Passing the literal as a
 * function *argument* typed as the union does get proper discriminated
 * narrowing — this is that workaround, applied at each construction site.
 */
function asRuntimeEvent(e: ProviderRuntimeEvent): ProviderRuntimeEvent {
  return e;
}

/**
 * Per-thread accumulator for the assistant's own message.
 *
 * ACP streams assistant text as plain `content.delta`-shaped chunks with no
 * item lifecycle of their own (unlike tool calls, which get an explicit
 * `tool_call`/`tool_call_update`) — there is no ACP signal for "the assistant
 * message is done" short of the whole turn ending (`acp/stop`). T3's own
 * projector, however, expects an `item.started`/`item.completed` pair (like
 * Codex's `item/started`+`item/completed` for the assistant-message item) to
 * actually persist the message — deltas alone are display-only streaming and
 * are never themselves interpreted as "a message happened." Without this,
 * every raw event maps correctly and reaches the queue (verified live), but
 * no assistant message ever lands in the thread's projection.
 */
interface AssistantMessageState {
  started: boolean;
  text: string;
}
const assistantMessageState = new Map<string, AssistantMessageState>();

/** Exported for `GlmAdapter.test.ts` - not part of the adapter's public Layer surface. */
export function mapToRuntimeEvents(event: ProviderEvent): ReadonlyArray<ProviderRuntimeEvent> {
  const base = {
    eventId: EventId.make(randomUUID()),
    provider: PROVIDER,
    threadId: event.threadId,
    createdAt: event.createdAt,
    ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
    ...(event.itemId !== undefined ? { itemId: RuntimeItemId.make(event.itemId) } : {}),
    ...(event.requestId !== undefined ? { requestId: RuntimeRequestId.make(event.requestId) } : {}),
  };

  if (event.kind === "error") {
    return [
      asRuntimeEvent({
        ...base,
        type: "runtime.error",
        payload: { message: event.message ?? "GLM provider error.", class: "provider_error" as const },
      }),
    ];
  }

  if (event.kind === "session" && event.method === "thread/started") {
    return [asRuntimeEvent({ ...base, type: "thread.started", payload: {} })];
  }

  if (event.kind === "request" && event.method === "session/request_permission") {
    // `event.requestKind` is already correctly classified from the ACP
    // toolCall's own `kind` by `glmAcpManager.ts`'s `toolCallKindToRequestKind`
    // - map it to the canonical `requestType` string the shared projector
    // (`ProviderRuntimeIngestion.ts`'s `requestKindFromCanonicalRequestType`)
    // and the web client (`session-logic.ts`'s `requestKindFromRequestType`)
    // both already recognize. Sending the old always-"dynamic_tool_call"
    // literal here meant every GLM permission request silently vanished from
    // `derivePendingApprovals` client-side - neither function has ever known
    // that string - so the turn sat blocked with no visible approval UI.
    const requestParams = event.payload as { toolCall?: { title?: string } } | undefined;
    return [
      asRuntimeEvent({
        ...base,
        type: "request.opened",
        payload: {
          requestType: canonicalRequestTypeFromRequestKind(event.requestKind),
          ...(requestParams?.toolCall?.title ? { detail: requestParams.toolCall.title } : {}),
        },
      }),
    ];
  }

  if (event.method === "session/request_permission/decision") {
    return [
      asRuntimeEvent({
        ...base,
        type: "request.resolved",
        payload: {
          requestType: canonicalRequestTypeFromRequestKind(event.requestKind),
          decision: (event.payload as { decision?: string } | undefined)?.decision,
        },
      }),
    ];
  }

  // ACP `elicitation/create` (mode: "form"), already mapped by
  // `glmAcpManager.ts`'s `mapElicitationFormSchema` to a single
  // `UserInputQuestion` — mirrors Codex's `item/tool/requestUserInput` ->
  // `user-input.requested` mapping in `CodexAdapter.ts`. There is no
  // confirmed live evidence `opencode acp` ever sends this (see this file's
  // prior `respondToUserInput` comment, kept below for context); this case
  // exists so that IF it ever is sent and the schema is mappable, it reaches
  // the same UI Codex's structured questions use, instead of silently
  // erroring or being dropped.
  if (event.kind === "request" && event.method === "elicitation/create") {
    const payload = event.payload as { questions?: ReadonlyArray<UserInputQuestion> } | undefined;
    const questions = payload?.questions;
    if (!questions || questions.length === 0) {
      return [];
    }
    return [asRuntimeEvent({ ...base, type: "user-input.requested", payload: { questions } })];
  }

  if (event.method === "elicitation/create/answered") {
    const payload = event.payload as { answers?: Record<string, unknown> } | undefined;
    return [
      asRuntimeEvent({
        ...base,
        type: "user-input.resolved",
        payload: { answers: payload?.answers ?? {} },
      }),
    ];
  }

  if (event.method === "turn/started") {
    return [asRuntimeEvent({ ...base, type: "turn.started", payload: {} })];
  }

  if (event.method === "process/stderr") {
    return [asRuntimeEvent({ ...base, type: "runtime.warning", payload: { message: event.message ?? "" } })];
  }

  if (event.method === "process/error" || event.method === "session/exited") {
    return [
      asRuntimeEvent({
        ...base,
        type: "session.exited",
        payload: { reason: event.message, recoverable: false },
      }),
    ];
  }

  if (event.method === "session/closed") {
    return [
      asRuntimeEvent({
        ...base,
        type: "session.exited",
        payload: { reason: event.message, recoverable: true, exitKind: "graceful" as const },
      }),
    ];
  }

  const payload = event.payload as Record<string, unknown> | undefined;

  if (event.method === "acp/agent_message_chunk" || event.method === "acp/agent_thought_chunk") {
    const content = payload?.content as { type?: string; text?: string } | undefined;
    if (content?.type !== "text" || !content.text) return [];

    const events: ProviderRuntimeEvent[] = [];
    if (event.method === "acp/agent_message_chunk") {
      const state = assistantMessageState.get(event.threadId) ?? { started: false, text: "" };
      if (!state.started) {
        state.started = true;
        events.push(
          asRuntimeEvent({ ...base, type: "item.started", payload: { itemType: "assistant_message", status: "inProgress" } }),
        );
      }
      state.text += content.text;
      assistantMessageState.set(event.threadId, state);
    }

    events.push(
      asRuntimeEvent({
        ...base,
        type: "content.delta",
        payload: {
          streamKind: event.method === "acp/agent_thought_chunk" ? "reasoning_text" : "assistant_text",
          delta: content.text,
        },
      }),
    );
    return events;
  }

  if (event.method === "acp/tool_call") {
    return [
      asRuntimeEvent({
        ...base,
        type: "item.started",
        payload: {
          itemType: toolCallItemType(payload?.kind as string | undefined),
          status: "inProgress",
          title: payload?.title as string | undefined,
        },
      }),
    ];
  }

  if (event.method === "acp/tool_call_update") {
    const status = payload?.status as string | undefined;
    const runtimeStatus = status === "completed" ? "completed" : status === "failed" ? "failed" : "inProgress";
    const isTerminal = runtimeStatus === "completed" || runtimeStatus === "failed";
    return [
      asRuntimeEvent({
        ...base,
        type: isTerminal ? "item.completed" : "item.updated",
        payload: {
          itemType: toolCallItemType(payload?.kind as string | undefined),
          status: runtimeStatus,
          title: payload?.title as string | undefined,
          data: payload,
        },
      }),
    ];
  }

  if (event.method === "acp/stop") {
    const stopReason = payload?.stopReason as string | undefined;
    const state = stopReason === "cancelled" ? "cancelled" : stopReason === "refusal" || stopReason === "max_turn_requests" ? "failed" : "completed";
    const events: ProviderRuntimeEvent[] = [];
    const assistantState = assistantMessageState.get(event.threadId);
    if (assistantState?.started) {
      events.push(
        asRuntimeEvent({
          ...base,
          type: "item.completed",
          payload: { itemType: "assistant_message", status: "completed", detail: assistantState.text.slice(0, 4000), data: { text: assistantState.text } },
        }),
      );
    }
    assistantMessageState.delete(event.threadId);
    events.push(asRuntimeEvent({ ...base, type: "turn.completed", payload: { state, stopReason: stopReason ?? null } }));
    return events;
  }

  // Unhandled acp/* notifications (available_commands_update, plan_*, mode/config
  // updates, usage_update, compaction_*) are deliberately dropped for v1 — none
  // are load-bearing for "GLM is a selectable, working provider."
  return [];
}

/**
 * Inverse of `glmAcpManager.ts`'s `toolCallKindToRequestKind` - turns the
 * three-way `ProviderRequestKind` back into the canonical `requestType`
 * string vocabulary both `ProviderRuntimeIngestion.ts` and the web client's
 * `session-logic.ts` switch on. `undefined` (no `requestKind` on the event)
 * falls back to the command-approval gate, same "ask, don't silently allow"
 * posture as `toolCallKindToRequestKind`'s own default case.
 */
function canonicalRequestTypeFromRequestKind(
  requestKind: "command" | "file-read" | "file-change" | undefined,
): CanonicalRequestType {
  switch (requestKind) {
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "command":
    default:
      return "command_execution_approval";
  }
}

function toolCallItemType(kind: string | undefined): "command_execution" | "file_change" | "unknown" {
  if (kind === "execute") return "command_execution";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  return "unknown";
}

const makeGlmAdapter = Effect.fn("makeGlmAdapter")(function* () {
  const gateway = yield* LogicPacksGateway;
  const manager = yield* Effect.acquireRelease(
    Effect.sync(() => new GlmAcpManager()),
    (manager) =>
      Effect.tryPromise(() => manager.stopAll()).pipe(Effect.catch(() => Effect.void)),
  );

  const startSession: GlmAdapterShape["startSession"] = Effect.fn("startSession")(function* (input) {
    if (input.provider !== undefined && input.provider !== PROVIDER) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
      });
    }
    if (!input.cwd) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "GLM sessions require a working directory.",
      });
    }

    // GLM's credential is the calling user's own LogicPacks gateway API key,
    // not an OAuth account — there is deliberately no `userId` field on
    // `ProviderSessionStartInput` (it's provider-agnostic), so this is
    // threaded through `providerLaunchEnvironment.env` by the orchestration
    // layer the same way Codex/Claude thread `CODEX_HOME`/tenancy overrides.
    const userIdRaw = input.providerLaunchEnvironment?.env?.T3CODE_GLM_USER_ID;
    if (!userIdRaw) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "startSession",
        issue: "Missing T3CODE_GLM_USER_ID in providerLaunchEnvironment — cannot resolve a gateway account.",
      });
    }
    const userId = UserId.make(userIdRaw);

    const apiKeyOption = yield* gateway.getApiKey(userId).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `Failed to resolve this user's LogicPacks gateway account: ${cause.message}`,
            cause,
          }),
      ),
    );
    if (Option.isNone(apiKeyOption)) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: "This user has no LogicPacks gateway account yet — cannot start a GLM session.",
      });
    }

    const gatewayBaseUrl = process.env.T3CODE_GATEWAY_URL;
    if (!gatewayBaseUrl) {
      return yield* new ProviderAdapterProcessError({
        provider: PROVIDER,
        threadId: input.threadId,
        detail: "T3CODE_GATEWAY_URL is not configured on this instance.",
      });
    }

    return yield* Effect.tryPromise({
      try: () =>
        manager.startSession({
          threadId: input.threadId,
          cwd: input.cwd!,
          opencodeBinaryPath: OPENCODE_BINARY,
          gatewayBaseUrl,
          apiKey: apiKeyOption.value,
        }),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: input.threadId,
          detail: `Failed to start GLM adapter session: ${cause instanceof Error ? cause.message : String(cause)}.`,
          cause,
        }),
    });
  });

  const sendTurn: GlmAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    if (!input.input) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "GLM turns require text input (attachments are not yet supported).",
      });
    }
    return yield* Effect.tryPromise({
      try: () =>
        manager.sendTurn(input.threadId, input.input!, {
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          ...(input.modelSelection?.provider === "glm"
            ? { model: input.modelSelection.model }
            : {}),
        }),
      catch: (cause) => toRequestError(input.threadId, "session/prompt", cause),
    });
  });

  const interruptTurn: GlmAdapterShape["interruptTurn"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.interruptTurn(threadId),
      catch: (cause) => toRequestError(threadId, "session/cancel", cause),
    });

  const respondToRequest: GlmAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.tryPromise({
      try: () => manager.respondToRequest(threadId, requestId, decision),
      catch: (cause) => toRequestError(threadId, "session/request_permission", cause),
    });

  // ACP does define a distinct mechanism for the agent to ask the user a
  // structured question mid-turn — `elicitation/create` (a real client-side
  // RPC, confirmed in the SDK's schema, tied to a session and optionally a
  // tool call) — but live testing against `opencode acp` (three prompts,
  // including one explicitly instructing it to "ask me a clarifying
  // question") never invoked it: OpenCode's own agent loop always asks
  // clarifying questions as plain `agent_message_chunk` text and ends the
  // turn with `stopReason: "end_turn"`, indistinguishable from a normal
  // answer. `elicitation/create` is documented as existing for forwarding
  // elicitations from a connected MCP server, not necessarily for the
  // agent's own conversational questions, so there is no confirmed live
  // evidence this path is ever exercised in production.
  //
  // `glmAcpManager.ts`'s `elicitation/create` handler nonetheless maps the
  // narrow "single boolean/enum-string/enum-array form field" case onto
  // T3's existing `user-input.requested`/`user-input.resolved` machinery
  // (see `mapElicitationFormSchema`'s docstring for the exact scope; url
  // mode and everything else is declined cleanly instead), so this now
  // actually resolves the pending elicitation rather than always failing.
  const respondToUserInput: GlmAdapterShape["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.tryPromise({
      try: () => manager.respondToElicitation(threadId, requestId, answers),
      catch: (cause) => toRequestError(threadId, "elicitation/create", cause),
    });

  const stopSession: GlmAdapterShape["stopSession"] = (threadId) =>
    Effect.tryPromise({
      try: () => manager.stopSession(threadId),
      catch: (cause) => toRequestError(threadId, "stopSession", cause),
    });

  const listSessions: GlmAdapterShape["listSessions"] = () => Effect.sync(() => manager.listSessions());
  const hasSession: GlmAdapterShape["hasSession"] = (threadId) => Effect.sync(() => manager.hasSession(threadId));
  const stopAll: GlmAdapterShape["stopAll"] = () =>
    Effect.tryPromise(() => manager.stopAll()).pipe(Effect.catch(() => Effect.void));

  // `readThread`: ACP genuinely supports reconstructing this — `session/load`
  // (confirmed live: `agentCapabilities.loadSession: true`, and
  // `sessionCapabilities.list`/`resume`/`close` are all advertised too)
  // replays a session's full prior history as `session/update` notifications
  // before its RPC response resolves, even from a brand-new subprocess with no
  // memory of the original one (verified: hard-killed the original process,
  // spawned a fresh one, called `session/load`, got the exact prior turn
  // replayed, and the session was then genuinely continuable). But nothing in
  // this codebase currently calls `readThread` for any provider (grepped: only
  // adapter implementations and their tests reference it), so there is no real
  // consumer to build and verify a `ProviderThreadSnapshot` translation
  // against. Shipping an unverified translation layer would itself be a faked
  // capability. Deferred until a real caller exists — not "not supported",
  // "not yet built against a spec."
  const readThreadNotWired = Effect.fn("readThread")(function* (threadId: string) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "readThread",
      detail:
        "GLM readThread is deferred: ACP's session/load can supply this (verified live), but no caller in this codebase consumes ProviderThreadSnapshot yet to build/verify a translation against.",
    });
  });

  // `rollbackThread`: no ACP primitive rewinds a session's history at all.
  // `session/fork`'s own docstring is explicit: it "creates a new session
  // based on the context of an existing one, allowing operations like
  // generating summaries without affecting the original session's history" —
  // a branch, not a rewind, and it doesn't touch the original session either
  // way. There is no delete-last-N-messages or checkpoint-restore method in
  // the spec. Forcing "rollback N turns" onto fork would silently do the
  // wrong thing (create a sibling session instead of rewinding this one), so
  // this is left unsupported rather than mapped to something that lies about
  // what happened.
  const rollbackThreadNotSupported = Effect.fn("rollbackThread")(function* (threadId: string) {
    return yield* new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "rollbackThread",
      detail:
        "GLM (ACP) has no rewind/rollback primitive — session/fork branches to a new session without altering the original, it does not rewind history.",
    });
  });

  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();

  const registerListener = Effect.fn("registerListener")(function* () {
    const services = yield* Effect.context<never>();
    const listenerEffect = Effect.fn("listener")(function* (event: ProviderEvent) {
      const events = mapToRuntimeEvents(event);
      if (events.length > 0) yield* Queue.offerAll(runtimeEventQueue, events);
    });
    const listener = (event: ProviderEvent) => listenerEffect(event).pipe(Effect.runPromiseWith(services));
    manager.on("event", listener);
    return listener;
  });

  yield* Effect.acquireRelease(registerListener(), (listener) =>
    Effect.sync(() => {
      manager.off("event", listener);
    }).pipe(Effect.andThen(Queue.shutdown(runtimeEventQueue))),
  );

  return {
    provider: PROVIDER,
    // `sendTurn` genuinely wires `session/set_config_option(configId: "model")`
    // (same verified mechanism as plan mode). Previously left "unsupported"
    // because the only switch targets tested (the two non-default GLM
    // variants) were down at Kitani with genuine 502s, so no full "model A
    // succeeds, then model B succeeds" round trip could be observed.
    //
    // Flipped to "in-session" on 2026-09-17 after the effort-tier feature
    // required genuine mid-session switching to DeepSeek models (which ARE
    // healthy) and produced the missing proof: with the flag still
    // "unsupported", `ProviderCommandReactor` force-reinjects
    // `activeSession.model` into every turn regardless of what's requested —
    // verified this directly (3 consecutive turns dispatched with
    // modelSelection targeting GLM, DeepSeek-thinking, DeepSeek-flash all
    // showed `z-ai/glm-5.3-flash-uncensored` in the gateway's own `requests`
    // table — the switch had silently NO effect). After flipping this flag,
    // the same 3-turn sequence showed the gateway billing each turn against
    // its actual requested model — see the Cherry note's effort-tier section
    // for the exact request rows.
    capabilities: { sessionModelSwitch: "in-session" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread: (threadId) => readThreadNotWired(threadId),
    rollbackThread: (threadId) => rollbackThreadNotSupported(threadId),
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies GlmAdapterShape;
});

export const GlmAdapterLive = Layer.effect(GlmAdapter, makeGlmAdapter());
