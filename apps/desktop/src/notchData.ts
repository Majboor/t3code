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
 * Everything here is written so that the ways a figure can be absent stay
 * different answers. A dash carries the reason with it; nothing in this file can
 * turn "we could not find out" into `0`.
 *
 * Which figures are read at all is decided by `notchContext.ts`: the account
 * sums when the panel is showing them, one project's deployments and streams
 * when the app is on a page about that project, and never both. The route takes
 * an optional `?projectId=` for exactly that reason.
 */

import {
  NOTCH_CONTEXT_PANELS,
  type NotchContext,
  type NotchFigureKey,
  resolveNotchFeed,
} from "./notchContext.ts";
import {
  EM_DASH,
  type NotchPanelAction,
  type NotchPanelView,
  type NotchSlotView,
} from "./notchPanelDocument.ts";

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

/**
 * One project's side of the same read.
 *
 * Counts are kept apart from the things that make a count meaningless.
 * `streamCount` and `reportingCount` are what let the panel tell "nothing has
 * been declared to report to" from "the count failed" — see
 * `apps/web/src/components/infra/deploymentLoad.logic.ts`, which draws the same
 * distinction on the infrastructure page and for the same reason.
 */
export interface DesktopProjectActivity {
  readonly deploymentCount: number;
  /** Deployments the registry was *told* are live; nothing here probes them. */
  readonly liveCount: number;
  /** Deployments naming at least one stream — the rest cannot report load. */
  readonly reportingCount: number;
  readonly streamCount: number;
  /** Events across every declared stream. `null` when none could be counted. */
  readonly events: number | null;
  /** Events across the streams the deployments name. `null` when uncountable. */
  readonly reportedEvents: number | null;
  readonly lastDeployAt: string | null;
  readonly lastDeployStatus: string | null;
  /** A stream or a count was skipped, so the event sums are floors. */
  readonly partial: boolean;
}

export interface DesktopActivity {
  readonly workspaceCount: number;
  readonly partial: boolean;
  readonly shareViews: DesktopShareViews | null;
  readonly tokenSpend: DesktopTokenSpend | null;
  /** Only ever present when the read named a project. */
  readonly project: DesktopProjectActivity | null;
}

/**
 * The states the panel has to keep apart, as one type. `ok` is the only one
 * that carries numbers, so no other branch can accidentally render as zero.
 *
 * `unknown-project` is separate from `failed` because they send a reader to two
 * different places: one means the server is unhappy, the other means the page
 * is open on a project this account cannot see, which no amount of retrying
 * fixes.
 */
export type NotchActivityOutcome =
  | { readonly kind: "ok"; readonly activity: DesktopActivity }
  | { readonly kind: "signed-out" }
  | { readonly kind: "offline" }
  | { readonly kind: "unknown-project" }
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

function parseProjectActivity(value: unknown): DesktopProjectActivity | null {
  if (!isRecord(value)) {
    return null;
  }
  const deploymentCount = readFiniteNumber(value.deploymentCount);
  const streamCount = readFiniteNumber(value.streamCount);
  if (deploymentCount === null || streamCount === null) {
    return null;
  }
  return {
    deploymentCount,
    liveCount: readFiniteNumber(value.liveCount) ?? 0,
    reportingCount: readFiniteNumber(value.reportingCount) ?? 0,
    streamCount,
    events: readFiniteNumber(value.events),
    reportedEvents: readFiniteNumber(value.reportedEvents),
    lastDeployAt: readIsoOrNull(value.lastDeployAt),
    lastDeployStatus: readIsoOrNull(value.lastDeployStatus),
    partial: value.partial === true,
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
      project: parseProjectActivity(body.project),
    },
  };
}

export interface ReadNotchActivityInput {
  /** `null` before the backend has an address, which reads as `offline`. */
  readonly baseUrl: string | null;
  readonly accessToken: string | null;
  /**
   * The app window's session cookie, used when there is no bearer token — the
   * desktop owner signs in locally and never gets one.
   */
  readonly sessionCookie?: string | null;
  /**
   * Names one project instead of the account. The route answers one or the
   * other, never both, because the panel only ever draws one of them.
   */
  readonly projectId?: string | null;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}

/** Kept here so the desktop and the route cannot disagree about the spelling. */
export function buildNotchActivityUrl(baseUrl: string, projectId?: string | null): string {
  const query =
    projectId === undefined || projectId === null || projectId.length === 0
      ? ""
      : `?projectId=${encodeURIComponent(projectId)}`;
  return `${baseUrl}${NOTCH_ACTIVITY_PATH}${query}`;
}

export async function readNotchActivity(
  input: ReadNotchActivityInput,
): Promise<NotchActivityOutcome> {
  if (!input.baseUrl) {
    return { kind: "offline" };
  }
  // Nobody signed in on this machine yet — asking anyway buys a 401 that says
  // the same thing a round trip later. A cookie counts: the desktop owner signs
  // in locally and never gets a Supabase token, and reading only the token told
  // that person they were signed out while they were using the app.
  const credential = resolveNotchCredential(input);
  if (!credential) {
    return { kind: "signed-out" };
  }

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, input.timeoutMs ?? REQUEST_TIMEOUT_MS);

  try {
    const response = await fetchImpl(buildNotchActivityUrl(input.baseUrl, input.projectId), {
      headers: credential,
      signal: controller.signal,
    });
    // A rejected credential is the signed-out story, not a broken one: the
    // token expired, or the account lost its membership, and in both cases the
    // fix is to sign in again.
    if (response.status === 401 || response.status === 403) {
      return { kind: "signed-out" };
    }
    // Only a named project can be missing, and it is the one thing a retry
    // will not fix, so it does not get folded into the general failure.
    if (response.status === 404) {
      return { kind: "unknown-project" };
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
/**
 * How the panel proves who is asking.
 *
 * A Supabase account carries a bearer token; the desktop owner signs in locally
 * and never has one, and reading only the token reported "sign in" to somebody
 * who was signed in and using the app — with a button whose only act was to
 * reveal a window already in front of them.
 *
 * The session cookie was rejected for this once, on the grounds that it
 * resolved to an identity with no tenant memberships and would have rendered a
 * confident zero. That is no longer true: the machine-owner subjects are
 * provisioned a personal tenant like any other account, so the cookie now names
 * a real person with a real workspace.
 */
export function resolveNotchCredential(input: {
  readonly accessToken?: string | null;
  readonly sessionCookie?: string | null;
}): Record<string, string> | null {
  const token = input.accessToken?.trim();
  if (token !== undefined && token.length > 0) {
    return { authorization: `Bearer ${token}` };
  }
  const cookie = input.sessionCookie?.trim();
  if (cookie !== undefined && cookie.length > 0) {
    return { cookie };
  }
  return null;
}

export async function readSignedInAccessToken(
  host: NotchScriptHost | null,
): Promise<string | null> {
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

/**
 * How long ago, short enough to sit in the value column.
 *
 * A timestamp is the wrong shape for a glance — "last deploy: 2h ago" answers
 * the question, "2026-08-19 14:03" makes the reader do arithmetic. The exact
 * moment is still in the tooltip. An unparseable date is a dash, not an epoch.
 */
export function formatElapsed(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) {
    return EM_DASH;
  }
  const minutes = Math.round((now - then) / 60_000);
  // A clock skew between the server and this machine should not produce "in 3
  // minutes" on a panel that only ever looks backwards.
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString();
}

/**
 * A figure without its name. Only the context knows what a row is called, so
 * nothing below this line is in a position to label one.
 */
type NotchFigureView = Omit<NotchSlotView, "label">;

/** A slot with no figure, carrying the reason there is none. */
function absentSlot(note: string, detail: string): NotchFigureView {
  return { value: EM_DASH, note, detail };
}

function presentSlot(value: string, note: string, detail: string): NotchFigureView {
  return { value, note, detail };
}

/**
 * Turns the number-less outcomes into wording. Written once so that "not signed
 * in" and "the read failed" cannot drift into sounding alike in one slot and
 * different in the next.
 */
function withActivity(
  outcome: NotchActivityOutcome,
  subject: string,
  fromActivity: (activity: DesktopActivity) => NotchFigureView,
): NotchFigureView {
  switch (outcome.kind) {
    case "offline":
      return absentSlot(
        "server off",
        `The local server is not answering, so ${subject} is unknown.`,
      );
    case "signed-out":
      return absentSlot("sign in", `Sign in to T3 Code to see ${subject}.`);
    case "unknown-project":
      return absentSlot(
        "unknown project",
        `The server does not have this project, or it belongs to another account, so ${subject} cannot be read.`,
      );
    case "failed":
      return absentSlot("unavailable", `The server could not be asked about ${subject}.`);
    case "ok":
      return fromActivity(outcome.activity);
  }
}

/**
 * An account-wide figure. Only hands a slot its figures once there is genuinely
 * something to count: a tenant with no workspace has no share links to have been
 * clicked, and that is not the same statement as "nobody clicked".
 */
function buildAccountSlot(
  outcome: NotchActivityOutcome,
  subject: string,
  fromActivity: (activity: DesktopActivity) => NotchFigureView,
): NotchFigureView {
  return withActivity(outcome, subject, (activity) =>
    activity.workspaceCount === 0
      ? absentSlot("no workspace", `This account has no workspace yet, so there is no ${subject}.`)
      : fromActivity(activity),
  );
}

/**
 * A figure about the one project the route named. A missing section here means
 * the server was asked and could not answer, which is why it does not fall
 * through to a zero.
 */
function buildProjectSlot(
  outcome: NotchActivityOutcome,
  subject: string,
  fromProject: (project: DesktopProjectActivity) => NotchFigureView,
): NotchFigureView {
  return withActivity(outcome, subject, (activity) =>
    activity.project === null
      ? absentSlot("unavailable", `The server could not read this project's ${subject}.`)
      : fromProject(activity.project),
  );
}

function partialSuffix(activity: DesktopActivity): string {
  return activity.partial ? " Some workspaces could not be read, so this is a floor." : "";
}

function buildShareClicks(outcome: NotchActivityOutcome): NotchFigureView {
  return buildAccountSlot(outcome, "share activity", (activity) => {
    const views = activity.shareViews;
    if (views === null) {
      return absentSlot("unavailable", "The server could not read this account's share links.");
    }
    const links = `${views.linkCount} share link${views.linkCount === 1 ? "" : "s"}`;
    const lastViewed =
      views.lastViewedAt === null
        ? ""
        : ` Last opened ${new Date(views.lastViewedAt).toLocaleString()}.`;
    return presentSlot(
      formatCompactCount(views.total),
      "",
      `${views.total.toLocaleString()} opens across ${links}.${lastViewed}${partialSuffix(activity)}`,
    );
  });
}

function buildTokenSpend(outcome: NotchActivityOutcome): NotchFigureView {
  return buildAccountSlot(outcome, "token spend", (activity) => {
    const spend = activity.tokenSpend;
    if (spend === null) {
      return absentSlot("unavailable", "The server could not read this account's token usage.");
    }
    const unpriced =
      spend.unpricedTokens > 0
        ? ` ${formatCompactCount(spend.unpricedTokens)} tokens came from models with no published rate and are not in it.`
        : "";
    return presentSlot(
      formatEstimatedCost(spend.estimatedUsd),
      // The rate table says of itself that it knows nothing about plans or
      // discounts, so the panel must not present its output as a bill.
      "est.",
      `Estimated from the server's own rate table${describeWindow(spend.since, spend.until)}, not a bill — ` +
        `plan pricing, discounts and rate changes are invisible to it. ` +
        `${formatCompactCount(spend.totalTokens)} tokens.${unpriced}${partialSuffix(activity)}`,
    );
  });
}

/**
 * Nothing in T3 Code reports sync activity — no table, no counter, no RPC — so
 * this stays a dash whatever the server says. A zero here would be a claim that
 * nothing is syncing, which is a different and unsupported statement.
 */
function buildActiveSyncs(): NotchFigureView {
  return absentSlot(
    "not wired",
    "Nothing in T3 Code reports sync activity yet, so this is blank rather than zero.",
  );
}

function ofDeployments(count: number): string {
  return `of ${count} deployment${count === 1 ? "" : "s"}`;
}

function eventFloorSuffix(project: DesktopProjectActivity): string {
  return project.partial ? " Some streams could not be counted, so this is a floor." : "";
}

/**
 * How much of the project is live. `status` is what the registry was told by
 * whatever registered the deployment — the panel is not probing anything, and
 * the tooltip says so rather than letting a green-looking number imply a health
 * check nobody ran.
 */
function buildLiveDeployments(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "deployments", (project) => {
    if (project.deploymentCount === 0) {
      return presentSlot("0", "none registered", "This project has no registered deployments.");
    }
    return presentSlot(
      project.liveCount.toLocaleString(),
      ofDeployments(project.deploymentCount),
      `${project.liveCount} of ${project.deploymentCount} registered deployments are recorded as live. ` +
        `That status is what the deployment reported when it was registered, not a probe run just now.`,
    );
  });
}

/**
 * Whether anything is reaching what is deployed.
 *
 * The two ways of having no number are kept apart exactly as
 * `describeLoad` keeps them apart on the infrastructure page: a deployment wired
 * to no stream *cannot* report load, and printing `0` against it would be a
 * measurement nobody took.
 */
function buildDeploymentTraffic(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "traffic", (project) => {
    if (project.deploymentCount === 0) {
      return absentSlot(
        "nothing deployed",
        "This project has no registered deployments, so nothing can be reporting traffic.",
      );
    }
    if (project.reportingCount === 0) {
      return absentSlot(
        "not wired",
        "No registered deployment reports to an analytics stream, so none of them can report load. " +
          "This is blank rather than zero because nobody measured it.",
      );
    }
    if (project.reportedEvents === null) {
      return absentSlot(
        "unavailable",
        "The server could not count the streams this project's deployments report to.",
      );
    }
    return presentSlot(
      formatCompactCount(project.reportedEvents),
      project.partial ? "floor" : "",
      `${project.reportedEvents.toLocaleString()} events across the streams ${project.reportingCount} ` +
        `${ofDeployments(project.deploymentCount)} report to.${eventFloorSuffix(project)}`,
    );
  });
}

function buildLastDeploy(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "deploy history", (project) => {
    if (project.lastDeployAt === null) {
      return absentSlot(
        "never",
        "No deploy run has been recorded for this project. A deployment registered by other means still shows above.",
      );
    }
    return presentSlot(
      formatElapsed(project.lastDeployAt),
      project.lastDeployStatus ?? "",
      `The most recent deploy run started ${new Date(project.lastDeployAt).toLocaleString()}` +
        `${project.lastDeployStatus === null ? "" : ` and ${project.lastDeployStatus}`}.`,
    );
  });
}

function buildAnalyticsStreams(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "streams", (project) =>
    presentSlot(
      project.streamCount.toLocaleString(),
      project.streamCount === 0 ? "none declared" : "",
      project.streamCount === 0
        ? "No analytics stream is declared for this project, so there is nothing for a deployment to report to."
        : `${project.streamCount} analytics stream${project.streamCount === 1 ? " is" : "s are"} declared for this project.`,
    ),
  );
}

/**
 * Events across every declared stream, summed the way the analytics page sums
 * them: a grouped query answers with one bucket per group, so a stream's total
 * is the sum of its buckets rather than its first row — see `totalEvents` in
 * `apps/web/src/components/infra/deploymentLoad.logic.ts`. The addition happens
 * on the server so the panel is handed a figure, not a table.
 */
function buildAnalyticsEvents(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "events", (project) => {
    if (project.streamCount === 0) {
      return absentSlot(
        "no streams",
        "Nothing is declared for this project to report to, so there is nothing to count.",
      );
    }
    if (project.events === null) {
      return absentSlot("unavailable", "The server could not count this project's streams.");
    }
    return presentSlot(
      formatCompactCount(project.events),
      project.partial ? "floor" : "",
      `${project.events.toLocaleString()} events across ${project.streamCount} declared stream${
        project.streamCount === 1 ? "" : "s"
      }.${eventFloorSuffix(project)}`,
    );
  });
}

/** How much of what is deployed is visible to analytics at all. */
function buildAnalyticsReporters(outcome: NotchActivityOutcome): NotchFigureView {
  return buildProjectSlot(outcome, "reporting deployments", (project) => {
    if (project.deploymentCount === 0) {
      return presentSlot(
        "0",
        "none registered",
        "This project has no registered deployments, so nothing is reporting to its streams.",
      );
    }
    const blind = project.deploymentCount - project.reportingCount;
    return presentSlot(
      project.reportingCount.toLocaleString(),
      ofDeployments(project.deploymentCount),
      `${project.reportingCount} of ${project.deploymentCount} registered deployments name at least one stream.` +
        (blind > 0 ? ` The other ${blind} cannot report anything.` : ""),
    );
  });
}

/**
 * The one thing about an open thread the desktop shell can stand behind.
 *
 * Main knows which route the app window is on and nothing else about it: thread
 * state lives in the renderer and there is no channel to it here. So this says
 * what the route says and no more.
 */
function buildThreadRoute(context: NotchContext): NotchFigureView {
  if (context.thread === "draft") {
    return presentSlot(
      "draft",
      "",
      "A draft is open in the composer. Nothing has been sent in it yet.",
    );
  }
  return presentSlot("open", "", "A thread is open in the app window.");
}

/**
 * Deliberately, permanently blank.
 *
 * Whether a turn is running is renderer state, and the panel is drawn by the
 * main process from the window's URL alone. Animating a spinner here would be
 * drawing something nobody looked at, so it stays a dash with the reason
 * attached — the same rule `buildActiveSyncs` follows.
 */
function buildTurnState(): NotchFigureView {
  return absentSlot(
    "not visible",
    "The desktop shell can see which page the app is on, not what a turn is doing, so this stays blank rather than guessing.",
  );
}

function buildFigure(
  figure: NotchFigureKey,
  context: NotchContext,
  outcome: NotchActivityOutcome,
): NotchFigureView {
  switch (figure) {
    case "shareClicks":
      return buildShareClicks(outcome);
    case "tokenSpend":
      return buildTokenSpend(outcome);
    case "activeSyncs":
      return buildActiveSyncs();
    case "liveDeployments":
      return buildLiveDeployments(outcome);
    case "deploymentTraffic":
      return buildDeploymentTraffic(outcome);
    case "lastDeploy":
      return buildLastDeploy(outcome);
    case "analyticsStreams":
      return buildAnalyticsStreams(outcome);
    case "analyticsEvents":
      return buildAnalyticsEvents(outcome);
    case "analyticsReporters":
      return buildAnalyticsReporters(outcome);
    case "threadRoute":
      return buildThreadRoute(context);
    case "turnState":
      return buildTurnState();
  }
}

/**
 * The one outcome whose remedy is known exactly.
 *
 * Every other absence sends the reader nowhere useful: a server that is not
 * answering, a read that failed, a project this account cannot see and an
 * account with no workspace are all things a click cannot mend, so they keep
 * the dash and the sentence explaining it. Being signed out is different — the
 * next step is a screen the app already has.
 */
function resolveNotchAction(outcome: NotchActivityOutcome): NotchPanelAction | null {
  return outcome.kind === "signed-out" ? "sign-in" : null;
}

/**
 * The context picks the rows and their labels; the outcome fills them in. The
 * label always comes from the context rather than the builder, so a figure can
 * never end up drawn under another figure's name.
 *
 * The rows are built even when the outcome carries an action and the page will
 * draw the button instead of them: the reasons stay attached to the reading, so
 * nothing here has to know which of the two the document chose to show.
 */
export function toNotchPanelView(
  context: NotchContext,
  outcome: NotchActivityOutcome,
): NotchPanelView {
  const panel = NOTCH_CONTEXT_PANELS[context.kind];
  return {
    title: panel.title,
    slots: panel.slots.map(({ figure, label }) => {
      const view = buildFigure(figure, context, outcome);
      return { label, value: view.value, note: view.note, detail: view.detail };
    }),
    action: resolveNotchAction(outcome),
  };
}

/**
 * The context's rows with nothing in them yet.
 *
 * Painted the moment the app navigates, so the panel never shows one page's
 * numbers under another page's labels while the new read is in the air.
 *
 * No action either: an unfinished read is not evidence of being signed out, and
 * offering a sign-in button to someone who is signed in would be a guess.
 */
export function pendingNotchPanelView(context: NotchContext): NotchPanelView {
  const panel = NOTCH_CONTEXT_PANELS[context.kind];
  return {
    title: panel.title,
    slots: panel.slots.map(({ label }) => ({
      label,
      value: EM_DASH,
      note: "",
      detail: "Not read yet.",
    })),
    action: null,
  };
}

export interface NotchActivitySource {
  readonly baseUrl: () => string | null;
  /** The app window, or `null` before one exists. */
  readonly host: () => NotchScriptHost | null;
  /**
   * The app window's session cookie. Optional so a test can leave it out, and
   * the only credential a locally-signed-in desktop owner has.
   */
  readonly sessionCookie?: () => Promise<string | null>;
  readonly fetchImpl?: typeof globalThis.fetch;
}

export interface NotchRefreshOptions<T> {
  readonly readView: () => Promise<T>;
  readonly apply: (view: T) => void;
  readonly intervalMs: number;
  /** Injectable so the policy can be exercised without a real clock. */
  readonly schedule?: (handler: () => void, ms: number) => unknown;
  readonly cancel?: (handle: unknown) => void;
}

export interface NotchRefreshScheduler {
  /** A single read with no cadence behind it: what a newly shown panel gets. */
  readOnce(): void;
  setExpanded(expanded: boolean): void;
  stop(): void;
}

/**
 * When the panel is allowed to ask the server.
 *
 * The rule is that a collapsed panel costs nothing: no timer exists while it is
 * shut, so a machine left running all day makes no requests beyond the one at
 * startup. Expanding reads immediately and then keeps a cadence only for as
 * long as the cursor stays. Lives here rather than in `notchWindow.ts` so it can
 * be tested without an Electron window.
 *
 * Navigating is the one thing that can invalidate a reading rather than merely
 * age it, so a refresh asked for while one is in flight is remembered and run
 * once that one settles. Dropping it would leave the panel showing the page you
 * just left until the next tick.
 */
export function createNotchRefreshScheduler<T>(
  options: NotchRefreshOptions<T>,
): NotchRefreshScheduler {
  const schedule =
    options.schedule ??
    ((handler: () => void, ms: number) => {
      const timer = setInterval(handler, ms);
      // The panel must never be the reason the process stays alive.
      timer.unref();
      return timer;
    });
  const cancel = options.cancel ?? ((handle: unknown) => clearInterval(handle as NodeJS.Timeout));

  let handle: unknown = null;
  let stopped = false;
  let inFlight = false;
  let queued = false;

  const refresh = (): void => {
    if (stopped) {
      return;
    }
    // One request at a time: the read crosses a socket and a hover can outlive
    // it, so without this a slow server would queue up work that all resolves
    // into the same few strings. At most one follow-up is remembered — the
    // panel wants the newest reading, not every reading it missed.
    if (inFlight) {
      queued = true;
      return;
    }
    inFlight = true;
    void options
      .readView()
      .then(options.apply)
      .catch(() => {
        // `readView` answers with an explanatory dash rather than rejecting; a
        // throw past that is a bug in it, and the panel keeps showing whatever
        // it last knew instead of blanking on a transient fault.
      })
      .finally(() => {
        inFlight = false;
        if (queued) {
          queued = false;
          refresh();
        }
      });
  };

  const stopTimer = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
  };

  return {
    readOnce: refresh,
    setExpanded: (expanded) => {
      if (stopped) {
        return;
      }
      if (!expanded) {
        stopTimer();
        return;
      }
      refresh();
      if (handle === null) {
        handle = schedule(refresh, options.intervalMs);
      }
    },
    stop: () => {
      stopped = true;
      stopTimer();
    },
  };
}

/**
 * The single function the panel calls; everything above it is pure or mockable.
 *
 * The context decides both what is asked for and what is drawn: a project-scoped
 * page asks about that project and nothing else, so the panel never pays for
 * figures it is not showing.
 */
export function createNotchViewReader(
  source: NotchActivitySource,
): (context: NotchContext) => Promise<NotchPanelView> {
  return async (context) => {
    const accessToken = await readSignedInAccessToken(source.host());
    const sessionCookie = source.sessionCookie ? await source.sessionCookie() : null;
    const feed = resolveNotchFeed(context);
    return toNotchPanelView(
      context,
      await readNotchActivity({
        baseUrl: source.baseUrl(),
        accessToken,
        sessionCookie,
        ...(feed.kind === "project" ? { projectId: feed.projectId } : {}),
        ...(source.fetchImpl ? { fetchImpl: source.fetchImpl } : {}),
      }),
    );
  };
}
