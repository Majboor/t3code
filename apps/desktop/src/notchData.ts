/**
 * Where the notch panel's figures come from, and what it draws when it has none.
 *
 * The three reads it needs already exist, but only as Effect RPC over the
 * server's `/ws` socket, and each demands a `tenantId`/`workspaceId` pair that
 * lives in renderer state. The Electron main process has neither an RPC client
 * nor those ids, so the panel reads `GET /api/desktop/activity` instead: one
 * authenticated HTTP read that resolves its own scope from the session. See
 * `apps/server/src/desktop/http.ts` for why that route exists rather than a
 * second unauthenticated endpoint.
 *
 * The credential is the account's Supabase access token, which is what the app
 * already presents on `/api/auth/ws-token` and `/api/auth/profile`. Main reads
 * it out of the window it owns rather than minting anything of its own: the
 * desktop bootstrap token is single-use and the renderer needs it, and a
 * session issued from it authenticates a *machine*, not a person — it would
 * resolve to an account with no memberships and report a confident zero.
 *
 * Everything here is written so that the four ways a figure can be absent stay
 * four different answers. A dash carries the reason with it; nothing in this
 * file can turn "we could not find out" into `0`.
 */

import { EM_DASH, type NotchPanelView, type NotchSlotView } from "./notchPanelDocument.ts";

/** Mirrors the key `apps/web/src/environments/primary/auth.ts` writes under. */
const SUPABASE_ACCESS_TOKEN_STORAGE_KEY = "t3code.supabase.accessToken";

export const NOTCH_ACTIVITY_PATH = "/api/desktop/activity";

/**
 * Short on purpose. This runs behind a hover, and a panel that waits on a wedged
 * socket for ten seconds has already failed at being glanceable.
 */
const REQUEST_TIMEOUT_MS = 4_000;

export interface DesktopShareViews {
  readonly total: number;
  readonly linkCount: number;
  readonly lastViewedAt: string | null;
}

export interface DesktopTokenSpend {
  readonly estimatedUsd: number;
  readonly totalTokens: number;
  readonly unpricedTokens: number;
  readonly since: string | null;
  readonly until: string | null;
}

export interface DesktopActivity {
  readonly workspaceCount: number;
  readonly partial: boolean;
  readonly shareViews: DesktopShareViews | null;
  readonly tokenSpend: DesktopTokenSpend | null;
}

/**
 * The four states the panel has to keep apart, as one type. `ok` is the only
 * one that carries numbers, so no other branch can accidentally render as zero.
 */
export type NotchActivityOutcome =
  | { readonly kind: "ok"; readonly activity: DesktopActivity }
  | { readonly kind: "signed-out" }
  | { readonly kind: "offline" }
  | { readonly kind: "failed" };

/** The slice of `WebContents` this needs, so the reader is testable off Electron. */
export interface NotchScriptHost {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readIsoOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseShareViews(value: unknown): DesktopShareViews | null {
  if (!isRecord(value)) {
    return null;
  }
  const total = readFiniteNumber(value.total);
  const linkCount = readFiniteNumber(value.linkCount);
  if (total === null || linkCount === null) {
    return null;
  }
  return { total, linkCount, lastViewedAt: readIsoOrNull(value.lastViewedAt) };
}

function parseTokenSpend(value: unknown): DesktopTokenSpend | null {
  if (!isRecord(value)) {
    return null;
  }
  const estimatedUsd = readFiniteNumber(value.estimatedUsd);
  const totalTokens = readFiniteNumber(value.totalTokens);
  if (estimatedUsd === null || totalTokens === null) {
    return null;
  }
  return {
    estimatedUsd,
    totalTokens,
    unpricedTokens: readFiniteNumber(value.unpricedTokens) ?? 0,
    since: readIsoOrNull(value.since),
    until: readIsoOrNull(value.until),
  };
}

/**
 * A body that does not parse is `failed`, never an empty reading — a server
 * that answers with something unrecognisable has told us nothing about how many
 * times anything was clicked.
 */
export function parseNotchActivityBody(body: unknown): NotchActivityOutcome {
  if (!isRecord(body)) {
    return { kind: "failed" };
  }
  if (body.signedIn !== true) {
    return { kind: "signed-out" };
  }
  const workspaceCount = readFiniteNumber(body.workspaceCount);
  if (workspaceCount === null) {
    return { kind: "failed" };
  }
  return {
    kind: "ok",
    activity: {
      workspaceCount,
      partial: body.partial === true,
      shareViews: parseShareViews(body.shareViews),
      tokenSpend: parseTokenSpend(body.tokenSpend),
    },
  };
}

export interface ReadNotchActivityInput {
  /** `null` before the backend has an address, which reads as `offline`. */
  readonly baseUrl: string | null;
  readonly accessToken: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

export async function readNotchActivity(
  input: ReadNotchActivityInput,
): Promise<NotchActivityOutcome> {
  if (!input.baseUrl) {
    return { kind: "offline" };
  }
  // No token means nobody is signed in on this machine yet. Asking anyway would
  // get a 401 that says the same thing a round trip later.
  if (!input.accessToken) {
    return { kind: "signed-out" };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${input.baseUrl}${NOTCH_ACTIVITY_PATH}`, {
      headers: { authorization: `Bearer ${input.accessToken}` },
      signal: controller.signal,
    });
    // A rejected credential is the signed-out story, not a broken one: the
    // token expired, or the account lost its membership, and in both cases the
    // fix is to sign in again.
    if (response.status === 401 || response.status === 403) {
      return { kind: "signed-out" };
    }
    if (!response.ok) {
      return { kind: "failed" };
    }
    return parseNotchActivityBody(await response.json());
  } catch {
    // A refused connection and an aborted request are indistinguishable from
    // here and mean the same thing to someone looking at the panel: the local
    // server is not answering.
    return { kind: "offline" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads the signed-in account's access token out of the app window.
 *
 * Main owns this `WebContents` already, and the token is deliberately not
 * copied anywhere: it is read at the moment of use, so a refresh in the app is
 * picked up on the next sample and a sign-out stops the panel immediately. If
 * the storage key ever moves, this returns `null` and the panel says "sign in"
 * — the failure mode is a dash, never a wrong number.
 */
export async function readSignedInAccessToken(host: NotchScriptHost | null): Promise<string | null> {
  if (!host || host.isDestroyed()) {
    return null;
  }
  try {
    const value = await host.executeJavaScript(
      `(()=>{try{return localStorage.getItem(${JSON.stringify(SUPABASE_ACCESS_TOKEN_STORAGE_KEY)});}catch{return null;}})()`,
    );
    if (typeof value !== "string") {
      return null;
    }
    const token = value.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/*
 * Both formatters are lifted from
 * `apps/web/src/components/collaboration/usage/usageMetrics.logic.ts` so the
 * notch and the usage panel round the same number the same way. They are copied
 * rather than imported because the desktop bundle cannot reach into the web app.
 */

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export function formatCompactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  const rounded = Math.round(value);
  if (rounded < 10_000) return rounded.toLocaleString();
  if (rounded < 1_000_000) return `${trimZero(rounded / 1_000)}K`;
  if (rounded < 1_000_000_000) return `${trimZero(rounded / 1_000_000)}M`;
  return `${trimZero(rounded / 1_000_000_000)}B`;
}

export function formatEstimatedCost(amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) return "$0.00";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const MILLISECONDS_PER_DAY = 86_400_000;

function describeWindow(since: string | null, until: string | null): string {
  if (since === null || until === null) {
    return "";
  }
  const span = Date.parse(until) - Date.parse(since);
  if (!Number.isFinite(span) || span <= 0) {
    return "";
  }
  const days = Math.max(1, Math.round(span / MILLISECONDS_PER_DAY));
  return ` over the last ${days} day${days === 1 ? "" : "s"}`;
}

function absentSlot(note: string, detail: string): NotchSlotView {
  return { value: EM_DASH, note, detail };
}

/**
 * Turns the three number-less outcomes into wording, and only hands a slot its
 * figures once there is genuinely something to count. Written once so that
 * "not signed in" and "the read failed" cannot drift into sounding alike in one
 * slot and different in the next.
 */
function buildSlot(
  outcome: NotchActivityOutcome,
  subject: string,
  fromActivity: (activity: DesktopActivity) => NotchSlotView,
): NotchSlotView {
  switch (outcome.kind) {
    case "offline":
      return absentSlot(
        "server off",
        `The local server is not answering, so ${subject} is unknown.`,
      );
    case "signed-out":
      return absentSlot("sign in", `Sign in to T3 Code to see ${subject}.`);
    case "failed":
      return absentSlot("unavailable", `The server could not be asked about ${subject}.`);
    case "ok":
      return outcome.activity.workspaceCount === 0
        ? absentSlot(
            "no workspace",
            `This account has no workspace yet, so there is no ${subject}.`,
          )
        : fromActivity(outcome.activity);
  }
}

function partialSuffix(activity: DesktopActivity): string {
  return activity.partial ? " Some workspaces could not be read, so this is a floor." : "";
}

function buildShareClicks(outcome: NotchActivityOutcome): NotchSlotView {
  return buildSlot(outcome, "share activity", (activity) => {
    const views = activity.shareViews;
    if (views === null) {
      return absentSlot("unavailable", "The server could not read this account's share links.");
    }
    const links = `${views.linkCount} share link${views.linkCount === 1 ? "" : "s"}`;
    const lastViewed =
      views.lastViewedAt === null
        ? ""
        : ` Last opened ${new Date(views.lastViewedAt).toLocaleString()}.`;
    return {
      value: formatCompactCount(views.total),
      note: "",
      detail: `${views.total.toLocaleString()} opens across ${links}.${lastViewed}${partialSuffix(activity)}`,
    };
  });
}

function buildTokenSpend(outcome: NotchActivityOutcome): NotchSlotView {
  return buildSlot(outcome, "token spend", (activity) => {
    const spend = activity.tokenSpend;
    if (spend === null) {
      return absentSlot("unavailable", "The server could not read this account's token usage.");
    }
    const unpriced =
      spend.unpricedTokens > 0
        ? ` ${formatCompactCount(spend.unpricedTokens)} tokens came from models with no published rate and are not in it.`
        : "";
    return {
      value: formatEstimatedCost(spend.estimatedUsd),
      // The rate table says of itself that it knows nothing about plans or
      // discounts, so the panel must not present its output as a bill.
      note: "est.",
      detail:
        `Estimated from the server's own rate table${describeWindow(spend.since, spend.until)}, not a bill — ` +
        `plan pricing, discounts and rate changes are invisible to it. ` +
        `${formatCompactCount(spend.totalTokens)} tokens.${unpriced}${partialSuffix(activity)}`,
    };
  });
}

/**
 * Nothing in T3 Code reports sync activity — no table, no counter, no RPC — so
 * this stays a dash whatever the server says. A zero here would be a claim that
 * nothing is syncing, which is a different and unsupported statement.
 */
function buildActiveSyncs(): NotchSlotView {
  return absentSlot(
    "not wired",
    "Nothing in T3 Code reports sync activity yet, so this is blank rather than zero.",
  );
}

export function toNotchPanelView(outcome: NotchActivityOutcome): NotchPanelView {
  return {
    shareClicks: buildShareClicks(outcome),
    tokenSpend: buildTokenSpend(outcome),
    activeSyncs: buildActiveSyncs(),
  };
}

export interface NotchActivitySource {
  readonly baseUrl: () => string | null;
  /** The app window, or `null` before one exists. */
  readonly host: () => NotchScriptHost | null;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/** The single function the panel calls; everything above it is pure or mockable. */
export function createNotchViewReader(source: NotchActivitySource): () => Promise<NotchPanelView> {
  return async () => {
    const accessToken = await readSignedInAccessToken(source.host());
    return toNotchPanelView(
      await readNotchActivity({
        baseUrl: source.baseUrl(),
        accessToken,
        ...(source.fetchImpl ? { fetchImpl: source.fetchImpl } : {}),
      }),
    );
  };
}
