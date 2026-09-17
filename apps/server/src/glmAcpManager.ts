/**
 * glmAcpManager - Subprocess/protocol manager for the GLM-5.3 (LogicPacks) provider.
 *
 * Mirrors codexAppServerManager.ts's responsibility (one subprocess per ThreadId,
 * session lifecycle, bridging a provider-native event stream into `ProviderEvent`s
 * for `GlmAdapter` to translate into `ProviderRuntimeEvent`s) but is built on the
 * official ACP TypeScript SDK (`@agentclientprotocol/sdk`) instead of hand-rolled
 * JSON-RPC framing, since `opencode acp` is a real Agent Client Protocol server.
 *
 * Unlike Codex/Claude, GLM's credential is not an OAuth account — it is the
 * calling LogicPacks user's own gateway API key (Phase A's `gateway_accounts`
 * table, via `LogicPacksGateway`). Each session gets an ephemeral, per-session
 * OpenCode config (via an `XDG_CONFIG_HOME` override, verified live to work)
 * scoped to exactly that user's key, so usage/billing lands on their own
 * gateway account.
 *
 * @module glmAcpManager
 */
import { type ChildProcessByStdio, type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";

import {
  client,
  ndJsonStream,
  RequestError,
  type ClientConnection,
  type ClientContext,
  type ActiveSession,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type ElicitationSchema,
  type ElicitationPropertySchema,
  type MultiSelectItems,
  type ElicitationContentValue,
} from "@agentclientprotocol/sdk";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
} from "@t3tools/contracts";

const GLM_MODEL_ID = "z-ai/glm-5.3-flash-uncensored";
const GLM_MODEL_SELECTOR = `logicpacks/${GLM_MODEL_ID}`;

/**
 * All gateway-seeded models resold through this provider (3 GLM variants +
 * the 2 DeepSeek models backing the composer's effort tiers), registered in
 * every session's ephemeral OpenCode config so
 * `session/set_config_option(configId: "model")` can select any of them
 * mid-session (verified live: the RPC only accepts values already present in
 * the agent's own provider config, not arbitrary strings). Note this is a
 * plain real-model-id request to the gateway either way — OpenCode strips its
 * own `logicpacks/` selector prefix before calling the upstream `/v1/chat/completions`,
 * so this never touches the gateway's separate `logicpacks/high|medium|low`
 * tier-alias feature (that's for direct API customers without an agent
 * harness; T3 resolves its own tiers to real model ids client-side instead).
 */
const GLM_MODEL_NAMES: Readonly<Record<string, string>> = {
  "z-ai/glm-5.3-flash-uncensored": "GLM-5.3 Flash (Uncensored)",
  "z-ai/glm-5.3-flash": "GLM-5.3 Flash (Censored)",
  "z-ai/glm-5.3": "GLM-5.3",
  "deepseek/deepseek-v4.1-flash-thinking": "DeepSeek V4.1 Flash (thinking)",
  "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash",
};

/** Maps T3's `interactionMode` to the ACP agent's real `mode` config values (verified live via `session/new`'s configOptions). */
function interactionModeToAcpValue(mode: "default" | "plan"): "build" | "plan" {
  return mode === "plan" ? "plan" : "build";
}

interface PendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly options: ReadonlyArray<{ readonly optionId: string; readonly kind: string }>;
  resolve: (outcome: { readonly kind: "selected"; readonly optionId: string } | { readonly kind: "cancelled" }) => void;
}

/**
 * A GLM/ACP `elicitation/create` (mode: "form") request that this adapter has
 * mapped onto T3's existing single-select/multi-select `UserInputQuestion`
 * shape, awaiting the user's answer via `respondToElicitation`.
 *
 * Only the single-flat-field cases `mapElicitationFormSchema` recognizes ever
 * reach this state — everything else is declined synchronously in the
 * `elicitation/create` handler itself and never has a pending entry.
 */
interface PendingElicitation {
  readonly requestId: ApprovalRequestId;
  /** The one `requestedSchema.properties` key this elicitation was mapped from. */
  readonly propertyName: string;
  /** Whether the mapped question is multi-select (ACP `array`/`MultiSelectPropertySchema`). */
  readonly multiSelect: boolean;
  /**
   * Maps each `UserInputQuestion` option's `label` (the exact string T3's web
   * client round-trips back as the answer, per `buildPendingUserInputAnswers`)
   * back to the real ACP schema value it stands for (an enum `const`, or a
   * `true`/`false` for boolean-mode questions).
   */
  readonly valueByLabel: ReadonlyMap<string, ElicitationContentValue>;
  resolve: (
    outcome: { readonly kind: "answered"; readonly answers: ProviderUserInputAnswers } | { readonly kind: "cancelled" },
  ) => void;
}

/** A single-select or multi-select question mapped from an ACP elicitation form schema, in T3's `UserInputQuestion` shape. */
interface MappedElicitationQuestion {
  readonly propertyName: string;
  readonly questionText: string;
  readonly multiSelect: boolean;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly valueByLabel: ReadonlyMap<string, ElicitationContentValue>;
}

/**
 * What this adapter decided to do with one `elicitation/create` request,
 * before any wiring into pending-promise/event-emission machinery — kept as
 * a pure function so the decision logic (what maps, what gets declined, and
 * why) is unit-testable without a live ACP subprocess or SDK transport.
 */
type ElicitationPlan =
  | { readonly kind: "ask"; readonly question: MappedElicitationQuestion }
  | { readonly kind: "decline"; readonly response: CreateElicitationResponse; readonly reason: string };

/**
 * A titled-or-plain enum option, normalized to the `{label, description,
 * value}` shape both `mapElicitationFormSchema`'s string-enum and
 * multi-select-array cases build questions/answers from.
 *
 * ACP's `EnumOption.description` is optional; T3's `UserInputQuestionOption`
 * requires a non-empty `description` (mirrors `CodexAdapter.ts`'s
 * `toUserInputQuestions`, which drops any option missing either field) — so
 * an untitled option's `title` is reused as its `description` here rather
 * than emitting an empty string.
 */
function enumOptionsFromTitled(
  options: ReadonlyArray<{ readonly const: string; readonly title: string; readonly description?: string | null }>,
): ReadonlyArray<{ label: string; description: string; value: string }> {
  return options.map((option) => ({
    label: option.title,
    description: option.description?.trim() || option.title,
    value: option.const,
  }));
}

/** Untitled enum values (plain `enum: string[]`) — the value itself stands in as both label and description. */
function enumOptionsFromPlain(
  values: ReadonlyArray<string>,
): ReadonlyArray<{ label: string; description: string; value: string }> {
  return values.map((value) => ({ label: value, description: value, value }));
}

/**
 * Maps a `StringPropertySchema`'s single-select enum (`enum` or the titled
 * `oneOf`) to normalized options, or `undefined` if the property carries
 * neither (e.g. a free-text field) — free text has no multiple-choice UI to
 * map onto and must be declined, per this integration's scope.
 */
function stringEnumOptions(
  property: Extract<ElicitationPropertySchema, { type: "string" }>,
): ReadonlyArray<{ label: string; description: string; value: string }> | undefined {
  if (property.oneOf && property.oneOf.length > 0) {
    return enumOptionsFromTitled(property.oneOf);
  }
  if (property.enum && property.enum.length > 0) {
    return enumOptionsFromPlain(property.enum);
  }
  return undefined;
}

/**
 * Maps a `MultiSelectPropertySchema.items` definition (`StringMultiSelectItems`'s
 * `enum`, or `TitledMultiSelectItems`'s `anyOf`) to normalized options, or
 * `undefined` for a custom/future items shape this integration doesn't
 * recognize.
 */
function arrayEnumOptions(
  items: MultiSelectItems,
): ReadonlyArray<{ label: string; description: string; value: string }> | undefined {
  if ("anyOf" in items && Array.isArray(items.anyOf) && items.anyOf.length > 0) {
    return enumOptionsFromTitled(items.anyOf);
  }
  if ("enum" in items && Array.isArray(items.enum) && items.enum.length > 0) {
    return enumOptionsFromPlain(items.enum);
  }
  return undefined;
}

/**
 * Picks a human-readable question prompt for the one mapped property, in
 * order of specificity: the property's own title/description, then the
 * schema's, then (always non-empty, since it's an object key) the property
 * name itself.
 */
function elicitationQuestionText(schema: ElicitationSchema, propertyName: string, property: ElicitationPropertySchema): string {
  // `ElicitationPropertySchema`'s custom/future variant declares `type:
  // string` (not a literal), so it structurally overlaps every named
  // variant and TS can't narrow `title`/`description` to a `string | null`
  // via a plain `in` check here — cast defensively instead; this only ever
  // reads two optional string fields, never trusts the shape further.
  const untyped = property as { readonly title?: string | null; readonly description?: string | null };
  return (
    untyped.title?.trim() || untyped.description?.trim() || schema.title?.trim() || schema.description?.trim() || propertyName
  );
}

/**
 * Maps an ACP `elicitation/create` (mode: "form") `requestedSchema` to a
 * single T3 `UserInputQuestion`, or `undefined` if it doesn't fit this
 * integration's deliberately narrow scope.
 *
 * Only schemas with **exactly one** property are considered: T3's existing
 * user-input UI (`ComposerPendingUserInputPanel.tsx`) presents one question
 * at a time from a flat list, not a nested form, and there is no way to
 * combine multiple ACP schema properties into that shape without inventing
 * a multi-field form UI this codebase doesn't have. Within that one
 * property, only `boolean` (yes/no), `string` with `enum`/`oneOf` (single-
 * select), and `array` (`MultiSelectPropertySchema`, multi-select) map
 * cleanly onto T3's `{header, question, options, multiSelect}` shape.
 * `number`/`integer`/free-text `string`/custom property types have no
 * multiple-choice UI to map onto and are deliberately left unmapped here —
 * the caller declines those rather than forcing a bad mapping.
 *
 * Exported for `glmAcpManager.test.ts` — not part of `GlmAcpManager`'s public surface.
 */
export function mapElicitationFormSchema(schema: ElicitationSchema): MappedElicitationQuestion | undefined {
  const entries = schema.properties ? Object.entries(schema.properties) : [];
  if (entries.length !== 1) return undefined;
  const [propertyName, property] = entries[0]!;
  const questionText = elicitationQuestionText(schema, propertyName, property);

  if (property.type === "boolean") {
    return {
      propertyName,
      questionText,
      multiSelect: false,
      options: [
        { label: "Yes", description: "Yes" },
        { label: "No", description: "No" },
      ],
      valueByLabel: new Map<string, ElicitationContentValue>([
        ["Yes", true],
        ["No", false],
      ]),
    };
  }

  if (property.type === "string") {
    // Same custom-variant overlap as `elicitationQuestionText` above — the
    // runtime `type === "string"` check already confirms this is really a
    // `StringPropertySchema`, TS just can't statically exclude the
    // catch-all `{type: string, ...}` custom-mode variant from the union.
    const options = stringEnumOptions(property as Extract<ElicitationPropertySchema, { type: "string" }>);
    if (!options) return undefined;
    return {
      propertyName,
      questionText,
      multiSelect: false,
      options: options.map(({ label, description }) => ({ label, description })),
      valueByLabel: new Map(options.map((option) => [option.label, option.value] as const)),
    };
  }

  if (property.type === "array") {
    // Same custom-variant overlap as above.
    const arrayProperty = property as Extract<ElicitationPropertySchema, { type: "array" }>;
    const options = arrayEnumOptions(arrayProperty.items);
    if (!options) return undefined;
    return {
      propertyName,
      questionText,
      multiSelect: true,
      options: options.map(({ label, description }) => ({ label, description })),
      valueByLabel: new Map(options.map((option) => [option.label, option.value] as const)),
    };
  }

  // number/integer/custom property types: no multiple-choice UI to map onto.
  return undefined;
}

/**
 * Decides what to do with one `elicitation/create` request — the pure
 * "what maps, what gets declined, and why" logic, kept free of the
 * pending-promise/event-emission wiring so it's directly unit-testable.
 *
 * - "form" mode maps onto T3's question UI when `mapElicitationFormSchema`
 *   recognizes the schema (see its docstring for the exact narrow scope);
 *   anything else is declined rather than forced into a wrong UI.
 * - "url" mode has no server-side way to open a browser for the user from an
 *   agent's backend session, so it's always declined (see the `elicitation/create`
 *   handler for why `"decline"` rather than `"cancel"`).
 * - Any other/custom mode is an ACP extension point this integration is not
 *   built to serve yet, so it's declined the same way.
 *
 * Exported for `glmAcpManager.test.ts` — not part of `GlmAcpManager`'s public surface.
 */
export function planElicitationRequest(request: CreateElicitationRequest): ElicitationPlan {
  if (request.mode === "form") {
    // Same discriminant-overlap issue as above, one level up: the custom-mode
    // variant's `mode: string` structurally overlaps the literal "form"
    // check, so TS can't narrow `requestedSchema` off of it alone.
    const question = mapElicitationFormSchema(request.requestedSchema as ElicitationSchema);
    if (!question) {
      return {
        kind: "decline",
        response: { action: "decline" },
        reason:
          "elicitation/create (form): requestedSchema is not a single boolean/enum-string/enum-array property — declining rather than forcing a bad UI.",
      };
    }
    return { kind: "ask", question };
  }

  if (request.mode === "url") {
    return {
      kind: "decline",
      response: { action: "decline" },
      reason: `elicitation/create (url): no server-side way to open ${request.url} for the user from this session — declining.`,
    };
  }

  return {
    kind: "decline",
    response: { action: "decline" },
    reason: `elicitation/create: unrecognized mode "${request.mode}" — this integration only implements "form" and "url", declining.`,
  };
}

/**
 * Converts the eventual `ProviderUserInputAnswers` (from
 * `respondToElicitation`, itself fed by T3's existing user-input-answer UI)
 * back into the `CreateElicitationResponse` ACP expects, using the
 * label→value map `mapElicitationFormSchema` built for this question.
 *
 * Falls back to `{action: "decline"}` (never fabricates a value) if the
 * answer doesn't contain a label this map recognizes — defensive, should not
 * happen in practice since T3's UI can only submit labels it was given.
 *
 * Exported for `glmAcpManager.test.ts` — not part of `GlmAcpManager`'s public surface.
 */
export function buildElicitationAcceptResponse(
  pending: Pick<PendingElicitation, "propertyName" | "multiSelect" | "valueByLabel">,
  answers: ProviderUserInputAnswers,
): CreateElicitationResponse {
  const raw = answers[pending.propertyName];

  if (pending.multiSelect) {
    const labels = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : typeof raw === "string" ? [raw] : [];
    const values = labels
      .map((label) => pending.valueByLabel.get(label))
      .filter((value): value is string => typeof value === "string");
    return { action: "accept", content: { [pending.propertyName]: values } };
  }

  const label = Array.isArray(raw) ? raw[0] : raw;
  const value = typeof label === "string" ? pending.valueByLabel.get(label) : undefined;
  if (value === undefined) {
    return { action: "decline" };
  }
  return { action: "accept", content: { [pending.propertyName]: value } };
}

interface GlmSessionContext {
  session: ProviderSession;
  readonly threadId: ThreadId;
  readonly child: ChildProcessWithoutNullStreams;
  readonly connection: ClientConnection;
  readonly clientContext: ClientContext;
  activeSession: ActiveSession;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly terminals: GlmTerminalRegistry;
  readonly pendingElicitations: Map<ApprovalRequestId, PendingElicitation>;
  readonly configDir: string;
  stopping: boolean;
  /**
   * The turn currently in flight, if any. `pumpUpdates` has no way to know
   * which turn a given `acp/stop` message belongs to on its own — the SDK's
   * `nextUpdate()` loop is per-session, not per-turn — so `sendTurn` records
   * it here and `pumpUpdates` reads it back when emitting the stop event.
   * Without this, `turn.completed` events carry no `turnId`, and
   * `ProviderRuntimeIngestion`'s strict lifecycle guard
   * (`missingTurnForActiveTurn`) silently drops the completion, leaving the
   * turn stuck "running" forever even though the assistant's reply was
   * already generated and persisted correctly.
   */
  currentTurnId: TurnId | null;
}

export interface GlmSessionStartInput {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly opencodeBinaryPath: string;
  readonly gatewayBaseUrl: string;
  readonly apiKey: string;
}

/**
 * Maps an ACP tool-call `kind` to this codebase's `ProviderRequestKind`
 * (`"command" | "file-read" | "file-change"`), the same taxonomy Codex's three
 * approval-request methods map onto.
 */
function toolCallKindToRequestKind(kind: string | null | undefined): ProviderRequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "read":
      return "file-read";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      // ACP's "other"/"think"/"fetch"/"switch_mode" kinds have no exact match
      // in this codebase's three-way taxonomy; treat as a command-style gate
      // (ask, don't silently allow) rather than guessing it's safe.
      return "command";
  }
}

/** Inverse of `toolCallKindToRequestKind`, for the ACP `RequestPermissionResponse`. */
function decisionToOptionId(decision: ProviderApprovalDecision, options: ReadonlyArray<{ optionId: string; kind: string }>): string | null {
  const wants = decision === "accept" || decision === "acceptForSession" ? "allow" : "reject";
  const match = options.find((o) =>
    wants === "allow" ? o.kind === "allow_once" || o.kind === "allow_always" : o.kind === "reject_once" || o.kind === "reject_always",
  );
  return match?.optionId ?? null;
}

/**
 * String-based containment check for "is `candidate` inside (or equal to)
 * `root`". Mirrors `ws.ts`'s `isPathInsideRoot` helper (same normalization/
 * comparison semantics) used for the analogous workspace-root containment
 * check elsewhere in this codebase. Duplicated here rather than imported:
 * `ws.ts` is a large, unrelated top-level websocket/RPC module that this
 * low-level provider manager has never depended on, and reaching into it
 * from here would be a new, backwards coupling for a two-line helper.
 * Shared by both the `fs/*` handlers below and `GlmTerminalRegistry`'s own
 * `cwd` containment check.
 */
function isPathInsideRoot(candidate: string, root: string): boolean {
  const normalizedCandidate = candidate.replaceAll("\\", "/").replace(/\/+$/, "");
  const normalizedRoot = root.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

/**
 * Resolves an ACP `fs/read_text_file` / `fs/write_text_file` request's
 * `path` (absolute, but entirely agent-supplied - opencode decides what to
 * read/write) against the session's own `cwd` and enforces containment
 * before any handler touches the filesystem. `path.resolve` normalizes any
 * `..` traversal segments first, so the containment check below only ever
 * sees a fully-normalized absolute path.
 *
 * The whole point of scoping a GLM session's `opencode acp` subprocess to
 * `cwd` (the project's `workspaceRoot`) is that the agent should never touch
 * files outside it - throws a `RequestError` (a real ACP-level JSON-RPC
 * error the SDK sends back to opencode, not a silent no-op) when the
 * resolved path escapes `cwd`.
 */
function resolveSessionFsPath(cwd: string, requestedPath: string): string {
  const resolvedPath = resolve(requestedPath);
  if (!isPathInsideRoot(resolvedPath, cwd)) {
    throw RequestError.invalidParams(
      { path: requestedPath, cwd },
      `Path is outside the session's working directory: ${requestedPath}`,
    );
  }
  return resolvedPath;
}

/** Implements `fs/read_text_file`'s containment check + optional 1-based `line`/`limit` slicing. */
export async function readSessionTextFile(
  cwd: string,
  path: string,
  options?: { readonly line?: number | null | undefined; readonly limit?: number | null | undefined },
): Promise<{ content: string }> {
  const resolvedPath = resolveSessionFsPath(cwd, path);
  let content = await readFile(resolvedPath, "utf8");
  if (options?.line != null || options?.limit != null) {
    const lines = content.split("\n");
    const startIndex = options?.line != null ? Math.max(0, options.line - 1) : 0;
    const endIndex = options?.limit != null ? startIndex + options.limit : lines.length;
    content = lines.slice(startIndex, endIndex).join("\n");
  }
  return { content };
}

/** Implements `fs/write_text_file`'s containment check + the actual write. */
export async function writeSessionTextFile(cwd: string, path: string, content: string): Promise<void> {
  const resolvedPath = resolveSessionFsPath(cwd, path);
  await writeFile(resolvedPath, content, "utf8");
}

/**
 * Trims `text` from the front to fit within `limitBytes` (UTF-8), matching
 * `CreateTerminalRequest.outputByteLimit`'s doc comment: "the Client MUST
 * ensure truncation happens at a character boundary." Single pass over the
 * UTF-8 byte buffer, walking forward from the cut point past any leftover
 * continuation bytes (`0b10xxxxxx`) so a multi-byte character is never split.
 */
function truncateToByteLimit(text: string, limitBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= limitBytes) return { text, truncated: false };
  let sliceStart = buf.byteLength - limitBytes;
  while (sliceStart < buf.byteLength && (buf[sliceStart]! & 0xc0) === 0x80) {
    sliceStart++;
  }
  return { text: buf.subarray(sliceStart).toString("utf8"), truncated: true };
}

interface GlmTerminalCreateOptions {
  readonly command: string;
  readonly args?: ReadonlyArray<string> | undefined;
  readonly env?: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined;
  readonly cwd?: string | null | undefined;
  readonly outputByteLimit?: number | null | undefined;
}

interface GlmTerminalExitStatus {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

interface GlmTerminalOutputResult {
  readonly output: string;
  readonly truncated: boolean;
  readonly exitStatus: GlmTerminalExitStatus | null;
}

interface GlmTerminalEntry {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  readonly outputByteLimit: number | null;
  output: string;
  truncated: boolean;
  exitStatus: GlmTerminalExitStatus | null;
  readonly exitWaiters: Array<(status: GlmTerminalExitStatus) => void>;
  killGraceTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Tracks agent-initiated, one-shot command executions for ACP's
 * `terminal/*` client methods (`terminal/create`, `terminal/output`,
 * `terminal/release`, `terminal/wait_for_exit`, `terminal/kill`).
 *
 * Deliberately NOT built on the existing `apps/server/src/terminal/`
 * PTY manager (`Services/Manager.ts` + `PTY.ts`): that manager models T3's
 * own thread-scoped, resizable, **interactive** PTY terminal UI feature — a
 * person typing live into a persistent shell, with `cols`/`rows`, persisted
 * scrollback `history` replayed on reconnect, `restart`, and raw keystroke
 * `write`. ACP's `terminal/*` methods model something simpler and different:
 * the *agent* (opencode) spawns one `command` + `args` in a `cwd`, polls the
 * accumulated output, waits for exit or kills it, then releases it — a
 * single-shot `child_process.spawn` with a growing output buffer, not a PTY
 * a human interacts with. There's no cols/rows/resize/restart concept, no
 * persisted-across-reconnect history, and `terminal/output` always returns
 * the full accumulated buffer (bounded by `outputByteLimit`) rather than an
 * incremental diff. Bridging the Effect-based, single-persistent-shell PTY
 * manager onto this one-shot-per-call model would mean fighting its shape at
 * every step for no shared benefit, so this is instead a small,
 * self-contained tracker scoped to one GLM session — mirroring the
 * `pendingApprovals: Map<...>` pattern this file already uses for
 * `session/request_permission`.
 */
export class GlmTerminalRegistry {
  private readonly terminals = new Map<string, GlmTerminalEntry>();
  private readonly sessionCwd: string;

  constructor(sessionCwd: string) {
    this.sessionCwd = sessionCwd;
  }

  /** Spawns `options.command`, returning a new terminal id. Throws `RequestError.invalidParams` if `options.cwd` resolves outside the session's own cwd. */
  create(options: GlmTerminalCreateOptions): string {
    const cwd = this.resolveCwd(options.cwd);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const variable of options.env ?? []) {
      env[variable.name] = variable.value;
    }
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminalId = randomUUID();
    const entry: GlmTerminalEntry = {
      child,
      outputByteLimit: options.outputByteLimit ?? null,
      output: "",
      truncated: false,
      exitStatus: null,
      exitWaiters: [],
      killGraceTimer: null,
    };
    const appendChunk = (chunk: Buffer) => {
      entry.output += chunk.toString("utf8");
      if (entry.outputByteLimit !== null) {
        const trimmed = truncateToByteLimit(entry.output, entry.outputByteLimit);
        entry.output = trimmed.text;
        entry.truncated = entry.truncated || trimmed.truncated;
      }
    };
    // ACP models one merged `output` stream (like a terminal), not separate
    // stdout/stderr channels, so both are appended to the same buffer as
    // they arrive.
    child.stdout.on("data", appendChunk);
    child.stderr.on("data", appendChunk);
    const settleExit = (status: GlmTerminalExitStatus) => {
      if (entry.exitStatus !== null) return;
      entry.exitStatus = status;
      if (entry.killGraceTimer) {
        clearTimeout(entry.killGraceTimer);
        entry.killGraceTimer = null;
      }
      for (const waiter of entry.exitWaiters.splice(0)) waiter(status);
    };
    child.on("error", (err) => {
      // Spawn failure (e.g. command not found) — surface it as a terminated
      // process rather than leaving `waitForExit` hanging forever.
      appendChunk(Buffer.from(`\n[terminal] failed to start '${options.command}': ${err.message}\n`));
      settleExit({ exitCode: null, signal: null });
    });
    child.on("exit", (code, signal) => settleExit({ exitCode: code, signal }));
    this.terminals.set(terminalId, entry);
    return terminalId;
  }

  /** Current accumulated output and exit status (`null` while still running). Throws `RequestError.resourceNotFound` for an unknown/already-released id. */
  output(terminalId: string): GlmTerminalOutputResult {
    const entry = this.require(terminalId);
    return { output: entry.output, truncated: entry.truncated, exitStatus: entry.exitStatus };
  }

  /** Resolves once the command exits (immediately if it already has). */
  waitForExit(terminalId: string): Promise<GlmTerminalExitStatus> {
    const entry = this.require(terminalId);
    if (entry.exitStatus) return Promise.resolve(entry.exitStatus);
    return new Promise((resolve) => entry.exitWaiters.push(resolve));
  }

  /**
   * Kills the command but keeps the terminal tracked, per the SDK's own
   * `TerminalHandle.kill()` doc comment (verified in
   * `@agentclientprotocol/sdk`'s `dist/acp.js`): "The terminal remains valid
   * after killing" so callers can still read final output / exit status and
   * `release()` it themselves. Sends SIGTERM, escalating to SIGKILL after a
   * short grace period if the process ignores it.
   */
  kill(terminalId: string): void {
    const entry = this.require(terminalId);
    if (entry.exitStatus !== null || entry.child.killed) return;
    entry.child.kill("SIGTERM");
    const pid = entry.child.pid;
    entry.killGraceTimer = setTimeout(() => {
      entry.killGraceTimer = null;
      if (entry.exitStatus === null && pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 2000);
    entry.killGraceTimer.unref?.();
  }

  /**
   * Releases a terminal and frees its resources. Per the SDK's own
   * `TerminalHandle.release()` doc comment (verified in `dist/acp.js`, NOT
   * assumed): "If the command is still running, it will be killed" — release
   * is not merely "stop tracking", a still-running process is killed too.
   */
  release(terminalId: string): void {
    const entry = this.require(terminalId);
    if (entry.exitStatus === null && !entry.child.killed) entry.child.kill("SIGTERM");
    if (entry.killGraceTimer) clearTimeout(entry.killGraceTimer);
    entry.child.stdout.removeAllListeners("data");
    entry.child.stderr.removeAllListeners("data");
    this.terminals.delete(terminalId);
  }

  /** Kills and forgets every still-tracked terminal. Called from `disposeSession` so a closed thread never leaks child processes. */
  disposeAll(): void {
    for (const entry of this.terminals.values()) {
      if (entry.exitStatus === null && !entry.child.killed) entry.child.kill("SIGKILL");
      if (entry.killGraceTimer) clearTimeout(entry.killGraceTimer);
    }
    this.terminals.clear();
  }

  private resolveCwd(candidate: string | null | undefined): string {
    if (candidate === null || candidate === undefined) return this.sessionCwd;
    const resolved = resolve(this.sessionCwd, candidate);
    if (!isPathInsideRoot(resolved, resolve(this.sessionCwd))) {
      throw RequestError.invalidParams(
        { cwd: candidate, sessionCwd: this.sessionCwd },
        `terminal cwd '${candidate}' resolves outside the session's own cwd '${this.sessionCwd}'`,
      );
    }
    return resolved;
  }

  private require(terminalId: string): GlmTerminalEntry {
    const entry = this.terminals.get(terminalId);
    if (!entry) throw RequestError.resourceNotFound(terminalId);
    return entry;
  }
}

export class GlmAcpManager extends EventEmitter {
  private readonly sessions = new Map<ThreadId, GlmSessionContext>();

  async startSession(input: GlmSessionStartInput): Promise<ProviderSession> {
    const existing = this.sessions.get(input.threadId);
    if (existing) {
      await this.disposeSession(existing, { emitLifecycleEvent: false });
    }

    const configDir = await mktempConfigDir();
    await writeSessionConfig(configDir, input.gatewayBaseUrl, input.apiKey);

    const child = spawn(input.opencodeBinaryPath, ["acp", "--pure", "--cwd", input.cwd], {
      cwd: input.cwd,
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
    const terminals = new GlmTerminalRegistry(input.cwd);
    const pendingElicitations = new Map<ApprovalRequestId, PendingElicitation>();
    const app = client({ name: "t3-logicpacks-glm" });

    /**
     * Resolves the live session context for a terminal/* request and checks
     * `params.sessionId` against it, mirroring how `session/request_permission`
     * below resolves session state — except that handler never needed a
     * sessionId check (it only ever reads `pendingApprovals`, captured by
     * closure). This reads `this.sessions` (populated once `startSession`
     * finishes, before any of these requests could legitimately arrive) so a
     * stale/mismatched sessionId is rejected instead of silently touching the
     * wrong session.
     */
    const requireGlmSession = (sessionId: string): GlmSessionContext => {
      const ctx = this.sessions.get(input.threadId);
      if (!ctx || ctx.activeSession.sessionId !== sessionId) {
        throw RequestError.invalidParams({ sessionId }, "Unknown ACP session for terminal request");
      }
      return ctx;
    };
    app.onRequest("terminal/create", async ({ params }) => {
      console.error(`[glm-acp] terminal/create invoked by opencode, thread=${input.threadId}, command=${JSON.stringify(params.command)}`);
      const ctx = requireGlmSession(params.sessionId);
      const terminalId = ctx.terminals.create({
        command: params.command,
        args: params.args,
        env: params.env,
        cwd: params.cwd,
        outputByteLimit: params.outputByteLimit,
      });
      return { terminalId };
    });
    app.onRequest("terminal/output", async ({ params }) => {
      const ctx = requireGlmSession(params.sessionId);
      return ctx.terminals.output(params.terminalId);
    });
    app.onRequest("terminal/release", async ({ params }) => {
      const ctx = requireGlmSession(params.sessionId);
      ctx.terminals.release(params.terminalId);
      return {};
    });
    app.onRequest("terminal/wait_for_exit", async ({ params }) => {
      const ctx = requireGlmSession(params.sessionId);
      return ctx.terminals.waitForExit(params.terminalId);
    });
    app.onRequest("terminal/kill", async ({ params }) => {
      const ctx = requireGlmSession(params.sessionId);
      ctx.terminals.kill(params.terminalId);
      return {};
    });
    app.onRequest("session/request_permission", async ({ params }) => {
      console.error(`[glm-acp] session/request_permission invoked by opencode, thread=${input.threadId}, toolCallKind=${params.toolCall.kind}`);
      const requestId = ApprovalRequestId.make(randomUUID());
      const outcome = await new Promise<{ kind: "selected"; optionId: string } | { kind: "cancelled" }>((resolve) => {
        pendingApprovals.set(requestId, { requestId, options: params.options, resolve });
        this.emitEvent({
          threadId: input.threadId,
          kind: "request",
          method: "session/request_permission",
          requestId,
          requestKind: toolCallKindToRequestKind(params.toolCall.kind),
          payload: params,
        });
      });
      if (outcome.kind === "cancelled") return { outcome: { outcome: "cancelled" } };
      return { outcome: { outcome: "selected", optionId: outcome.optionId } };
    });
    // Fill two previously-dead ACP request methods (opencode would otherwise
    // get a hard "Method not found" if it ever called either): both are
    // scoped to this specific session's own `input.cwd` (never "whatever
    // session happens to be active") via the `params.sessionId` check below,
    // same closure-over-`input`/session-variables pattern the
    // `session/request_permission` handler above already uses.
    app.onRequest("fs/read_text_file", async ({ params }) => {
      console.error(`[glm-acp] fs/read_text_file invoked by opencode, thread=${input.threadId}, path=${params.path}`);
      if (params.sessionId !== activeSession.sessionId) {
        throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown GLM ACP session id.");
      }
      return readSessionTextFile(input.cwd, params.path, { line: params.line, limit: params.limit });
    });
    app.onRequest("fs/write_text_file", async ({ params }) => {
      console.error(`[glm-acp] fs/write_text_file invoked by opencode, thread=${input.threadId}, path=${params.path}`);
      if (params.sessionId !== activeSession.sessionId) {
        throw RequestError.invalidParams({ sessionId: params.sessionId }, "Unknown GLM ACP session id.");
      }
      await writeSessionTextFile(input.cwd, params.path, params.content);
      return {};
    });
    // `elicitation/create` — the agent asking the user a structured question
    // mid-turn (distinct from `session/request_permission`'s approve/reject
    // gate). There is no confirmed live evidence `opencode acp` ever sends
    // this (see `GlmAdapter.ts`'s prior `respondToUserInput` comment); this
    // handler exists so the SDK doesn't hard-fail it with "Method not found"
    // if it ever is. Only the narrow form-mode shapes `mapElicitationFormSchema`
    // recognizes are actually wired to T3's user-input UI — everything else
    // (url mode, custom modes, unmappable form schemas) is declined cleanly.
    app.onRequest("elicitation/create", async ({ params }) => {
      console.error(`[glm-acp] elicitation/create invoked by opencode, thread=${input.threadId}, mode=${params.mode}, message=${JSON.stringify(params.message)}`);
      const plan = planElicitationRequest(params);
      if (plan.kind === "decline") {
        this.emitEvent({
          threadId: input.threadId,
          kind: "notification",
          method: "elicitation/create/declined",
          message: plan.reason,
        });
        return plan.response;
      }

      const requestId = ApprovalRequestId.make(randomUUID());
      const outcome = await new Promise<
        { kind: "answered"; answers: ProviderUserInputAnswers } | { kind: "cancelled" }
      >((resolve) => {
        pendingElicitations.set(requestId, {
          requestId,
          propertyName: plan.question.propertyName,
          multiSelect: plan.question.multiSelect,
          valueByLabel: plan.question.valueByLabel,
          resolve,
        });
        this.emitEvent({
          threadId: input.threadId,
          kind: "request",
          method: "elicitation/create",
          requestId,
          payload: {
            questions: [
              {
                id: plan.question.propertyName,
                header: params.message,
                question: plan.question.questionText,
                options: plan.question.options,
                multiSelect: plan.question.multiSelect,
              },
            ],
          },
        });
      });
      if (outcome.kind === "cancelled") return { action: "cancel" };
      // `respondToElicitation` deletes the pending entry from
      // `pendingElicitations` before resolving this promise, so the mapping
      // metadata needed here is taken from the `plan.question` closure
      // (unchanged since this request started) rather than re-read from the
      // (now-empty) map.
      return buildElicitationAcceptResponse(
        {
          propertyName: plan.question.propertyName,
          multiSelect: plan.question.multiSelect,
          valueByLabel: plan.question.valueByLabel,
        },
        outcome.answers,
      );
    });
    // `elicitation/complete` is a notification, not a request — per its own
    // ACP doc comment ("sent by the agent when a URL-based elicitation is
    // complete") it exists exclusively for `mode: "url"` elicitations, which
    // carry their own `elicitationId`; `mode: "form"` requests (the only mode
    // this adapter ever leaves pending) have no `elicitationId` field at all,
    // so there is no ACP-level mechanism — nor a need for one — to abandon a
    // pending form-mode `user-input.requested` through this notification.
    // Since every url-mode request is declined synchronously above (nothing
    // is ever left pending for one), this is a safe, visible no-op.
    app.onNotification("elicitation/complete", ({ params }) => {
      this.emitEvent({
        threadId: input.threadId,
        kind: "notification",
        method: "elicitation/complete",
        message: `Agent reported elicitation ${params.elicitationId} complete (no pending client-side state to reconcile — url-mode requests are declined synchronously).`,
      });
    });

    let connection: ClientConnection;
    let activeSession: ActiveSession;
    try {
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      connection = app.connect(stream);
      activeSession = await connection.agent.buildSession(input.cwd).start();
    } catch (cause) {
      child.kill();
      await rm(configDir, { recursive: true, force: true }).catch(() => {});
      throw cause;
    }

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (!text) return;
      this.emitEvent({ threadId: input.threadId, kind: "notification", method: "process/stderr", message: text });
    });
    child.on("error", (err) => {
      const ctx = this.sessions.get(input.threadId);
      if (ctx) ctx.session = { ...ctx.session, status: "error", lastError: err.message };
      this.emitEvent({ threadId: input.threadId, kind: "error", method: "process/error", message: err.message });
    });
    child.on("exit", (code, signal) => {
      const ctx = this.sessions.get(input.threadId);
      if (!ctx || ctx.stopping) return;
      ctx.session = { ...ctx.session, status: "closed" };
      this.emitEvent({
        threadId: input.threadId,
        kind: "notification",
        method: "session/exited",
        message: `opencode acp exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}).`,
      });
      this.sessions.delete(input.threadId);
    });

    const now = new Date().toISOString();
    const session: ProviderSession = {
      provider: "glm",
      status: "ready",
      runtimeMode: "full-access",
      cwd: input.cwd,
      // Bare model id (matches `ModelSelection.model`/`BUILT_IN_MODELS` slugs
      // used everywhere else in this codebase) — NOT the ACP/opencode
      // `provider/model` selector syntax used only inside the generated
      // opencode.jsonc and in `session/set_config_option` calls. Mixing the
      // two formats here previously caused every turn to silently double-
      // prefix the model in `session/set_config_option` (`sessionModelSwitch:
      // "unsupported"` makes the reactor re-inject `activeSession.model` into
      // every turn, not just switch attempts), breaking ALL turns after
      // session start — caught live via a real orchestration-layer turn that
      // failed with "model not found: logicpacks/logicpacks/...".
      model: GLM_MODEL_ID,
      threadId: input.threadId,
      createdAt: now,
      updatedAt: now,
    };

    const ctx: GlmSessionContext = {
      session,
      threadId: input.threadId,
      child,
      connection,
      clientContext: connection.agent,
      activeSession,
      pendingApprovals,
      terminals,
      pendingElicitations,
      configDir,
      stopping: false,
      currentTurnId: null,
    };
    this.sessions.set(input.threadId, ctx);

    this.emitEvent({ threadId: input.threadId, kind: "session", method: "thread/started" });
    void this.pumpUpdates(ctx);

    return session;
  }

  private async pumpUpdates(ctx: GlmSessionContext): Promise<void> {
    while (!ctx.stopping && this.sessions.get(ctx.threadId) === ctx) {
      let message;
      try {
        message = await ctx.activeSession.nextUpdate();
      } catch {
        return; // session/connection closed
      }
      if (message.kind === "session_update") {
        this.emitEvent({
          threadId: ctx.threadId,
          kind: "notification",
          method: `acp/${message.update.sessionUpdate}`,
          payload: message.update,
        });
      } else {
        this.emitEvent({
          threadId: ctx.threadId,
          kind: "notification",
          method: "acp/stop",
          ...(ctx.currentTurnId !== null ? { turnId: ctx.currentTurnId } : {}),
          payload: { stopReason: message.stopReason, response: message.response },
        });
        ctx.currentTurnId = null;
      }
    }
  }

  async sendTurn(
    threadId: ThreadId,
    text: string,
    options?: { readonly interactionMode?: "default" | "plan"; readonly model?: string },
  ): Promise<ProviderTurnStartResult> {
    const ctx = this.requireSession(threadId);
    const turnId = TurnId.make(randomUUID());
    ctx.currentTurnId = turnId;
    if (options?.interactionMode !== undefined) {
      await ctx.clientContext.request("session/set_config_option", {
        sessionId: ctx.activeSession.sessionId,
        configId: "mode",
        value: interactionModeToAcpValue(options.interactionMode),
      });
    }
    if (options?.model !== undefined) {
      await ctx.clientContext.request("session/set_config_option", {
        sessionId: ctx.activeSession.sessionId,
        configId: "model",
        value: `logicpacks/${options.model}`,
      });
    }
    this.emitEvent({ threadId, kind: "notification", method: "turn/started", turnId });
    ctx.activeSession.prompt(text).catch((cause: unknown) => {
      this.emitEvent({
        threadId,
        kind: "error",
        method: "session/prompt",
        message: cause instanceof Error ? cause.message : "GLM session/prompt failed.",
      });
    });
    return { threadId, turnId };
  }

  async interruptTurn(threadId: ThreadId): Promise<void> {
    const ctx = this.sessions.get(threadId);
    if (!ctx) return;
    await ctx.clientContext.notify("session/cancel", { sessionId: ctx.activeSession.sessionId });
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const ctx = this.requireSession(threadId);
    const pending = ctx.pendingApprovals.get(requestId);
    if (!pending) throw new Error(`Unknown pending GLM approval request: ${requestId}`);
    ctx.pendingApprovals.delete(requestId);
    if (decision === "cancel") {
      pending.resolve({ kind: "cancelled" });
    } else {
      const optionId = decisionToOptionId(decision, pending.options);
      if (!optionId) {
        // Defensive: OpenCode is expected to always offer an allow/reject pair
        // (verified empirically), but if it ever doesn't, cancelling is the
        // fail-closed choice — never silently pick an arbitrary option.
        pending.resolve({ kind: "cancelled" });
      } else {
        pending.resolve({ kind: "selected", optionId });
      }
    }
    this.emitEvent({
      threadId,
      kind: "notification",
      method: "session/request_permission/decision",
      requestId,
      payload: { decision },
    });
  }

  /**
   * Resolves a pending `elicitation/create` (form mode) request that this
   * adapter mapped to a T3 `UserInputQuestion` — the GLM analogue of
   * `CodexAppServerManager.respondToUserInput`. Only ever has an entry to
   * resolve for the narrow single-field boolean/enum-string/enum-array
   * schemas `mapElicitationFormSchema` recognizes; everything else was
   * already declined synchronously inside the `elicitation/create` handler
   * and never reaches `pendingElicitations`.
   */
  async respondToElicitation(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const ctx = this.requireSession(threadId);
    const pending = ctx.pendingElicitations.get(requestId);
    if (!pending) throw new Error(`Unknown pending GLM elicitation request: ${requestId}`);
    ctx.pendingElicitations.delete(requestId);
    pending.resolve({ kind: "answered", answers });
    this.emitEvent({
      threadId,
      kind: "notification",
      method: "elicitation/create/answered",
      requestId,
      payload: { answers },
    });
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  listSessions(): ReadonlyArray<ProviderSession> {
    return Array.from(this.sessions.values(), (ctx) => ctx.session);
  }

  async stopSession(threadId: ThreadId): Promise<void> {
    const ctx = this.sessions.get(threadId);
    if (!ctx) return;
    await this.disposeSession(ctx, { emitLifecycleEvent: true });
  }

  async stopAll(): Promise<void> {
    await Promise.all(Array.from(this.sessions.values(), (ctx) => this.disposeSession(ctx, { emitLifecycleEvent: false })));
  }

  private async disposeSession(ctx: GlmSessionContext, options: { emitLifecycleEvent: boolean }): Promise<void> {
    ctx.stopping = true;
    for (const pending of ctx.pendingApprovals.values()) {
      pending.resolve({ kind: "cancelled" });
    }
    ctx.pendingApprovals.clear();
    // Terminals created via `terminal/create` are child processes of this
    // Node server, not of the opencode subprocess — killing `ctx.child`
    // below would not reap them. Without this, an ended thread would leak a
    // running command indefinitely.
    ctx.terminals.disposeAll();
    for (const pending of ctx.pendingElicitations.values()) {
      pending.resolve({ kind: "cancelled" });
    }
    ctx.pendingElicitations.clear();
    // Real ACP method (verified live: opencode advertises `sessionCapabilities.close`
    // and the RPC cancels in-flight work + frees resources on its side before we
    // tear down the subprocess). Best-effort with a short timeout — if the agent
    // is already unresponsive, fall through to killing the process regardless.
    if (!ctx.child.killed) {
      await Promise.race([
        ctx.clientContext.request("session/close", { sessionId: ctx.activeSession.sessionId }).catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    }
    try {
      ctx.connection.close();
    } catch {
      /* already closed */
    }
    if (!ctx.child.killed) ctx.child.kill();
    await rm(ctx.configDir, { recursive: true, force: true }).catch(() => {});
    this.sessions.delete(ctx.threadId);
    if (options.emitLifecycleEvent) {
      this.emitEvent({ threadId: ctx.threadId, kind: "notification", method: "session/closed", message: "Session stopped" });
    }
  }

  private requireSession(threadId: ThreadId): GlmSessionContext {
    const ctx = this.sessions.get(threadId);
    if (!ctx) throw new Error(`Unknown session for thread: ${threadId}`);
    return ctx;
  }

  private emitEvent(partial: Omit<ProviderEvent, "id" | "provider" | "createdAt" | "method"> & { method: string; message?: string }): void {
    const event: ProviderEvent = {
      id: EventId.make(randomUUID()),
      provider: "glm",
      createdAt: new Date().toISOString(),
      ...partial,
    };
    this.emit("event", event);
  }
}

async function mktempConfigDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "t3-glm-"));
}

/**
 * Sent on every request this adapter's spawned OpenCode subprocess makes to
 * the gateway, so the gateway's `requests` table can attribute usage to
 * "inside LogicPacks" vs the same issued key used externally — an external
 * caller has no reason to know or send this value. Verified live: the
 * `@ai-sdk/openai-compatible` provider's `headers` option is genuinely
 * forwarded on every upstream call (confirmed against a header-logging stub
 * server, not assumed from the SDK's types). Keep this string in sync by
 * hand with the gateway's own `INTERNAL_CLIENT_HEADER`/`INTERNAL_CLIENT_VALUE`
 * in `p140/src/routes/v1.ts` — separate repos, no shared import.
 */
const INTERNAL_CLIENT_HEADER = "x-logicpacks-client";
const INTERNAL_CLIENT_VALUE = "t3code-glm-adapter";

async function writeSessionConfig(configDir: string, gatewayBaseUrl: string, apiKey: string): Promise<void> {
  const dir = join(configDir, "opencode");
  await mkdir(dir, { recursive: true });
  const config = {
    provider: {
      logicpacks: {
        npm: "@ai-sdk/openai-compatible",
        options: {
          baseURL: `${gatewayBaseUrl.replace(/\/$/, "")}/v1`,
          apiKey,
          headers: { [INTERNAL_CLIENT_HEADER]: INTERNAL_CLIENT_VALUE },
        },
        models: Object.fromEntries(
          Object.entries(GLM_MODEL_NAMES).map(([id, name]) => [id, { name }]),
        ),
      },
    },
    model: GLM_MODEL_SELECTOR,
    // Reads auto-allowed (matches read-mostly agent behavior); edits and shell
    // commands are gated through session/request_permission, same posture as
    // Codex/Claude's file-change and command-execution approvals.
    permission: { read: "allow", edit: "ask", bash: "ask" },
  };
  await writeFile(join(dir, "opencode.jsonc"), JSON.stringify(config, null, 2), "utf8");
}
