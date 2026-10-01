import {
  resolveWorkspaceSource,
  type AuthSessionState,
  type EnvironmentId,
  type ServerAuthDescriptor,
} from "@t3tools/contracts";

/**
 * Pure branching behind the add-environment surface.
 *
 * Three questions live here, and nothing else:
 *  - what did the person paste (a pairing URL, or a host)?
 *  - what is the next thing they have to do before we can try?
 *  - when something goes wrong, *which* wrong is it?
 *
 * That last one is the reason this file exists. "We could not reach that
 * machine" and "that machine refused your code" look identical in a stack
 * trace and are completely different problems for the person reading the
 * screen, so they get different sentences and different advice.
 */

export type EnvironmentInputMode = "pairing-url" | "host-code";

export type EnvironmentInputKind = "empty" | "pairing-url" | "host";

const PAIRING_TOKEN_PARAM = "token";

function readTokenFromUrl(url: URL): string | null {
  const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const hashToken = new URLSearchParams(hash).get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  if (hashToken.length > 0) {
    return hashToken;
  }
  const searchToken = url.searchParams.get(PAIRING_TOKEN_PARAM)?.trim() ?? "";
  return searchToken.length > 0 ? searchToken : null;
}

/**
 * Decides which of the two ways in a pasted string is. A pairing URL is one
 * that carries its own token; anything else that looks addressable is a host,
 * which still needs a code typed next to it.
 */
export function classifyEnvironmentInput(rawValue: string): EnvironmentInputKind {
  const trimmed = rawValue.trim();
  if (trimmed.length === 0) {
    return "empty";
  }

  const hasScheme = /^[a-zA-Z][a-zA-Z\d+-]*:\/\//.test(trimmed) || trimmed.startsWith("//");
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `https://${trimmed}`);
  } catch {
    return "host";
  }

  return readTokenFromUrl(parsed) === null ? "host" : "pairing-url";
}

export interface AddEnvironmentDraft {
  readonly mode: EnvironmentInputMode;
  readonly label: string;
  readonly pairingUrl: string;
  readonly host: string;
  readonly pairingCode: string;
}

export type AddEnvironmentNextStep =
  | { readonly kind: "needs-pairing-url"; readonly hint: string }
  | { readonly kind: "needs-host"; readonly hint: string }
  | { readonly kind: "needs-pairing-code"; readonly hint: string }
  | {
      readonly kind: "ready";
      readonly hint: string;
      readonly submit: {
        readonly label: string;
        readonly pairingUrl?: string;
        readonly host?: string;
        readonly pairingCode?: string;
      };
    };

/**
 * What the person still has to do, and — once nothing is missing — exactly the
 * arguments `addSavedEnvironment` should be handed. The form never assembles
 * that payload itself.
 */
export function resolveAddEnvironmentNextStep(draft: AddEnvironmentDraft): AddEnvironmentNextStep {
  const label = draft.label.trim();

  if (draft.mode === "pairing-url") {
    const pairingUrl = draft.pairingUrl.trim();
    if (pairingUrl.length === 0) {
      return {
        kind: "needs-pairing-url",
        hint: "Paste the pairing link the machine printed when you started its server.",
      };
    }
    if (classifyEnvironmentInput(pairingUrl) === "host") {
      return {
        kind: "needs-pairing-code",
        hint: "That address has no pairing token in it. Use host and code instead, or paste the whole link.",
      };
    }
    return {
      kind: "ready",
      hint: "We will ask that machine who it is, then trade the token for a session.",
      submit: { label, pairingUrl },
    };
  }

  const host = draft.host.trim();
  const pairingCode = draft.pairingCode.trim();
  if (host.length === 0) {
    return {
      kind: "needs-host",
      hint: "Where the machine answers — a hostname, or an address and port.",
    };
  }
  if (pairingCode.length === 0) {
    return {
      kind: "needs-pairing-code",
      hint: "The code that machine showed you. It is good once, and not for long.",
    };
  }
  return {
    kind: "ready",
    hint: "We will ask that machine who it is, then trade the code for a session.",
    submit: { label, host, pairingCode },
  };
}

export type EnvironmentFailureKind =
  | "unreachable"
  | "refused"
  | "not-an-environment"
  | "already-added"
  | "invalid-input"
  | "storage"
  | "unknown";

export interface EnvironmentFailure {
  readonly kind: EnvironmentFailureKind;
  /** One line, said plainly. Goes in the heading slot. */
  readonly title: string;
  /** What to do about it. Never a stack trace. */
  readonly message: string;
  /** The raw error, kept so the surface can offer it under a disclosure. */
  readonly detail: string | null;
}

function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "";
}

function errorStatus(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = (error as { readonly status?: unknown }).status;
  return typeof status === "number" ? status : null;
}

function describeTarget(target: string | null): string {
  const trimmed = target?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : "that machine";
}

/**
 * Turns whatever `addSavedEnvironment` threw into a sentence worth reading.
 *
 * The two that matter most are the two the app has always been careful about:
 * a request that never got an answer (the machine is off, asleep, on another
 * network, or the port is wrong) versus one that got an answer of "no" (the
 * code is wrong, spent, or expired).
 */
export function classifyEnvironmentFailure(
  error: unknown,
  options?: { readonly target?: string | null },
): EnvironmentFailure {
  const text = errorText(error);
  const detail = text.length > 0 ? text : null;
  const target = describeTarget(options?.target ?? null);
  const status = errorStatus(error);

  if (/already connected/i.test(text)) {
    return {
      kind: "already-added",
      title: "You are already connected to this one",
      message: `${target} is in your list already. Select it below instead of adding it twice.`,
      detail,
    };
  }

  if (/missing its token|Enter a backend URL|Enter a pairing code|Invalid URL/i.test(text)) {
    return {
      kind: "invalid-input",
      title: "That is not a pairing link",
      message:
        "A pairing link ends in a token, like https://your-machine:3210/pair#token=…. Check you copied the whole thing, or switch to host and code.",
      detail,
    };
  }

  if (/Unable to persist saved environment credentials/i.test(text)) {
    return {
      kind: "storage",
      title: "Connected, but could not remember it",
      message:
        "This browser refused to store the session for that machine, so it would be gone on reload. Check that site data is not blocked here, then try again.",
      detail,
    };
  }

  // The fetch wrapper wraps a thrown TypeError from `fetch` — a request that
  // never reached anything. Nothing answered, so there is nothing to refuse us.
  if (/Failed to fetch remote auth endpoint/i.test(text) && status === null) {
    return {
      kind: "unreachable",
      title: "Could not reach that machine",
      message: `Nothing answered at ${target}. Check it is awake, that the T3 server is running on it, and that the address and port match what the server printed.`,
      detail,
    };
  }

  if (status !== null) {
    if (status === 401 || status === 403) {
      return {
        kind: "refused",
        title: "That machine refused the code",
        message: `${target} answered, and turned this code down. Pairing codes are single-use and expire quickly — generate a fresh one on that machine and paste it here.`,
        detail,
      };
    }
    if (status === 404) {
      return {
        kind: "not-an-environment",
        title: "Something answered, but it is not a T3 environment",
        message: `${target} responded without the endpoints an environment serves. Check the port — this is usually another service sitting on the address.`,
        detail,
      };
    }
    if (status >= 500) {
      return {
        kind: "refused",
        title: "That machine answered with an error",
        message: `${target} is running, but the pairing request failed on its side. Check the server's log on that machine, then try again.`,
        detail,
      };
    }
    return {
      kind: "refused",
      title: "That machine refused the request",
      message: `${target} answered, and would not complete pairing (HTTP ${status}).`,
      detail,
    };
  }

  return {
    kind: "unknown",
    title: "Could not add that environment",
    message: detail ?? "The pairing attempt failed before it got anywhere. Try again in a moment.",
    detail,
  };
}

export type ListedEnvironmentState =
  | "connected"
  | "connecting"
  | "refused"
  | "unreachable"
  | "asleep"
  | "never-connected";

export type ListedEnvironmentTone = "positive" | "pending" | "negative" | "idle";

export interface ListedEnvironmentPresentation {
  readonly state: ListedEnvironmentState;
  readonly tone: ListedEnvironmentTone;
  /** The line under the name. */
  readonly statusText: string;
  /** Whether "Try again" is worth offering right now. */
  readonly canRetry: boolean;
  readonly retryLabel: string;
}

export interface ListedEnvironmentInput {
  readonly connectionState: "connecting" | "connected" | "disconnected" | "error";
  readonly authState: "authenticated" | "requires-auth" | "unknown";
  readonly lastError: string | null;
  readonly lastConnectedAt: string | null;
  readonly isRetrying?: boolean;
}

function looksRefused(lastError: string | null, authState: string): boolean {
  if (authState === "requires-auth") {
    return true;
  }
  const text = lastError ?? "";
  return /401|403|unauthor|forbidden|refused you|invalid credential|expired/i.test(text);
}

/**
 * Which of the honest states a saved environment is currently in.
 *
 * "Disconnected with a history" is deliberately its own state: a machine you
 * paired last week and have since shut down is not an error, and telling
 * somebody their laptop is broken because it is closed would be a lie.
 */
export function describeListedEnvironment(
  input: ListedEnvironmentInput,
): ListedEnvironmentPresentation {
  if (input.isRetrying === true) {
    return {
      state: "connecting",
      tone: "pending",
      statusText: "Reconnecting…",
      canRetry: false,
      retryLabel: "Reconnecting…",
    };
  }

  switch (input.connectionState) {
    case "connected":
      return {
        state: "connected",
        tone: "positive",
        statusText: "Connected",
        canRetry: false,
        retryLabel: "Reconnect",
      };
    case "connecting":
      return {
        state: "connecting",
        tone: "pending",
        statusText: "Connecting…",
        canRetry: false,
        retryLabel: "Connecting…",
      };
    case "error":
      return looksRefused(input.lastError, input.authState)
        ? {
            state: "refused",
            tone: "negative",
            statusText: "Refused this client — its pairing needs renewing",
            canRetry: true,
            retryLabel: "Try again",
          }
        : {
            state: "unreachable",
            tone: "negative",
            statusText: "Cannot be reached at that address",
            canRetry: true,
            retryLabel: "Try again",
          };
    case "disconnected":
      if (looksRefused(input.lastError, input.authState)) {
        return {
          state: "refused",
          tone: "negative",
          statusText: "Refused this client — its pairing needs renewing",
          canRetry: true,
          retryLabel: "Try again",
        };
      }
      return input.lastConnectedAt === null
        ? {
            state: "never-connected",
            tone: "idle",
            statusText: "Saved, not connected yet",
            canRetry: true,
            retryLabel: "Connect",
          }
        : {
            state: "asleep",
            tone: "idle",
            statusText: "Not answering — that machine is probably off",
            canRetry: true,
            retryLabel: "Try again",
          };
  }
}

/**
 * Whether a browser has any way at all to get through the primary
 * environment's front door.
 *
 * Under `desktop-managed-local` the server only accepts a desktop handoff, so
 * the pairing-token screen offers a credential no browser can obtain. Somebody
 * who lands there is stuck, and belongs on the add-environment surface
 * instead — where the answer is to connect a machine of their own.
 */
export function canBrowserSatisfyAuthGate(auth: AuthSessionState["auth"]): boolean {
  if (auth.supabase || auth.localPassword) {
    return true;
  }
  return auth.bootstrapMethods.includes("one-time-token");
}

/**
 * Where the work behind an environment row actually happens.
 *
 * The list has always been flat, so the laptop on the desk and the hosted
 * instance sat next to each other looking identical. That is the single thing
 * people have reported being unable to tell, and every follow-on question —
 * is this reachable from my phone, does it survive closing the lid, whose
 * hardware is this running on — is unanswerable until it is said out loud.
 *
 * - `this-machine`: the server on the other end holds the projects itself.
 * - `logicpacks`: the server holds accounts, share links and packs, and keeps
 *   no workspace of its own.
 */
export type EnvironmentPlacement = "this-machine" | "logicpacks";

export interface EnvironmentPlacementInput {
  readonly environmentId: EnvironmentId;
  /**
   * The environment's own auth descriptor, as its `server.getConfig` reported
   * it, or null when this browser has not managed to talk to it yet. Null is
   * not a third answer — see `resolveEnvironmentPlacement`.
   */
  readonly auth: Pick<ServerAuthDescriptor, "workspaceSource"> | null;
}

export interface EnvironmentPlacementGroup {
  readonly placement: EnvironmentPlacement;
  /** The heading over the group. */
  readonly title: string;
  /** One sentence saying what being in this group means for the person. */
  readonly description: string;
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
}

/**
 * Which group a row belongs in, from the one field that already says so.
 *
 * Delegates to `resolveWorkspaceSource` rather than reading
 * `auth.workspaceSource` here, because that field is optional and its absence
 * is meaningful: a server built before the field existed genuinely does host
 * its own projects, so an unconnected or older environment has to land on
 * `this-machine` rather than on some third "we don't know" state that would
 * put a row under a heading that is not true of it.
 *
 * Written as a positive test for `paired-environment` for the same reason
 * `resolveMachineRole` is: a value this build has never heard of must fall to
 * the ordinary answer, not to the hosted one.
 */
export function resolveEnvironmentPlacement(
  auth: Pick<ServerAuthDescriptor, "workspaceSource"> | null | undefined,
): EnvironmentPlacement {
  return resolveWorkspaceSource(auth ?? undefined) === "paired-environment"
    ? "logicpacks"
    : "this-machine";
}

/**
 * The copy for a group heading.
 *
 * `productName` is passed in rather than imported so this file stays free of
 * the branding module's window lookups — the desktop build can rename the
 * product, and a heading that hard-coded the name would disagree with the rest
 * of the app the moment it did.
 */
function describeEnvironmentPlacement(
  placement: EnvironmentPlacement,
  productName: string,
): { readonly title: string; readonly description: string } {
  if (placement === "logicpacks") {
    return {
      title: `On ${productName}`,
      description: `Hosted. ${productName} holds your account, share links and packs; it keeps no projects of its own, so work runs on an environment connected to it.`,
    };
  }
  return {
    title: "On this machine",
    description:
      "The projects live on the machine itself. They are here while it is awake, and they go quiet when it sleeps or leaves the network.",
  };
}

/**
 * Splits saved environments into the two honest groups, in the order a person
 * reads them: their own hardware first, hosted second.
 *
 * A group with nothing in it is left out entirely rather than rendered empty —
 * "On LogicPacks (none)" is an invitation to wonder what is missing, and the
 * common case is that every environment is of one kind.
 */
export function groupEnvironmentsByPlacement(
  environments: ReadonlyArray<EnvironmentPlacementInput>,
  productName: string,
): ReadonlyArray<EnvironmentPlacementGroup> {
  const order: ReadonlyArray<EnvironmentPlacement> = ["this-machine", "logicpacks"];
  const byPlacement = new Map<EnvironmentPlacement, EnvironmentId[]>();

  for (const environment of environments) {
    const placement = resolveEnvironmentPlacement(environment.auth);
    const bucket = byPlacement.get(placement);
    if (bucket) {
      bucket.push(environment.environmentId);
    } else {
      byPlacement.set(placement, [environment.environmentId]);
    }
  }

  const groups: EnvironmentPlacementGroup[] = [];
  for (const placement of order) {
    const environmentIds = byPlacement.get(placement);
    if (!environmentIds || environmentIds.length === 0) {
      continue;
    }
    groups.push({
      placement,
      ...describeEnvironmentPlacement(placement, productName),
      environmentIds,
    });
  }
  return groups;
}
