/**
 * What the notch panel is *about*, derived from the route the app window is on.
 *
 * The panel has one surface and a few hundred milliseconds of attention, so the
 * figures worth putting in it depend entirely on what the person is looking at:
 * deployment numbers are noise on the analytics page and the reverse is just as
 * true. This module is the whole of that decision, kept pure so the mapping can
 * be exercised against every route the app has without an Electron window.
 *
 * The context is read from the URL rather than reported by the renderer. The web
 * app runs on hash history under Electron (`apps/web/src/main.tsx`), so
 * `webContents.getURL()` already carries the active route in its fragment, and
 * the main process can see it without a `DesktopBridge` method — which would
 * mean a new channel, a new preload surface, and a stub in every test that
 * constructs a bridge. Nothing here imports Electron; the caller hands in a
 * string.
 *
 * Two properties this file has to keep:
 *
 * 1. **Every context defines exactly `NOTCH_SLOT_COUNT` slots.** The panel's
 *    geometry is fixed by `notchGeometry.ts` and the window never resizes, so a
 *    context with four rows would overflow the surface and one with two would
 *    leave a hole. A panel that changes shape as you navigate is worse than one
 *    that never changes at all, so the count is a constant and a test.
 * 2. **A context names a project only when the route did.** `deployment` and
 *    `analytics` are read for one project; inventing an id for them would make
 *    the panel confidently report somebody else's deployments.
 */

/**
 * Rows the expanded panel draws. Three fits `NOTCH_PANEL_HEIGHT` with the title
 * above it; see `notchPanelDocument.ts` for the box this has to live inside.
 */
export const NOTCH_SLOT_COUNT = 3;

export type NotchContextKind = "default" | "deployment" | "analytics" | "prompting";

/**
 * Every figure any context can draw. The key is what `notchData.ts` switches on
 * to build a slot, so adding a figure is a change in two files and no more.
 */
export type NotchFigureKey =
  // Account-wide, from `GET /api/desktop/activity`.
  | "shareClicks"
  | "tokenSpend"
  | "activeSyncs"
  // One project's, from the same route asked with `?projectId=`.
  | "liveDeployments"
  | "deploymentTraffic"
  | "lastDeploy"
  | "analyticsStreams"
  | "analyticsEvents"
  | "analyticsReporters"
  // Known from the route alone.
  | "threadRoute"
  | "turnState";

export interface NotchSlotDefinition {
  readonly figure: NotchFigureKey;
  /** Drawn on the left of the row. Kept short: the row must never wrap. */
  readonly label: string;
}

export interface NotchContextPanel {
  /** The heading above the rows, so a changed set of numbers says why. */
  readonly title: string;
  readonly slots: readonly NotchSlotDefinition[];
}

/**
 * What each context shows.
 *
 * `prompting` is deliberately thin. The main process knows which route the app
 * is on, not what the thread is doing — there is no turn state on this side of
 * the process boundary — so it reports the one thing it can stand behind (a
 * thread is open, and what the account has spent) and says outright that the
 * turn itself is not visible. A spinner here would be a drawing of something
 * nobody looked at.
 */
export const NOTCH_CONTEXT_PANELS: Readonly<Record<NotchContextKind, NotchContextPanel>> = {
  default: {
    title: "Live activity",
    slots: [
      { figure: "shareClicks", label: "Share clicks" },
      { figure: "tokenSpend", label: "Token spend" },
      { figure: "activeSyncs", label: "Active syncs" },
    ],
  },
  deployment: {
    title: "Deployment",
    slots: [
      { figure: "liveDeployments", label: "Live" },
      { figure: "deploymentTraffic", label: "Traffic" },
      { figure: "lastDeploy", label: "Last deploy" },
    ],
  },
  analytics: {
    title: "Analytics",
    slots: [
      { figure: "analyticsStreams", label: "Streams" },
      { figure: "analyticsEvents", label: "Events" },
      { figure: "analyticsReporters", label: "Reporting" },
    ],
  },
  prompting: {
    title: "Current thread",
    slots: [
      { figure: "threadRoute", label: "Thread" },
      { figure: "tokenSpend", label: "Token spend" },
      { figure: "turnState", label: "Turn" },
    ],
  },
};

export interface NotchContext {
  readonly kind: NotchContextKind;
  /** Non-empty exactly when the route named a project. */
  readonly projectId: string | null;
  /** For `prompting`: whether anything has been sent in this thread yet. */
  readonly thread: "draft" | "started" | null;
}

export const defaultNotchContext: NotchContext = {
  kind: "default",
  projectId: null,
  thread: null,
};

/**
 * First path segments the router resolves statically, from
 * `apps/web/src/routeTree.gen.ts`.
 *
 * This list is what makes `/$environmentId/$threadId` decidable: a thread route
 * is two segments, and so is `/settings/general`, so the only way to tell them
 * apart is to know which first segments are spoken for. TanStack Router picks
 * the static branch over the dynamic one for exactly the same reason, so this
 * mirrors its resolution rather than guessing at it. A route added to the web
 * app without being added here would be read as a thread; the test file lists
 * every current route so that drift shows up as a failure.
 */
const STATIC_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "settings",
  "pair",
  "invite",
  "pack",
  "infra",
  "draft",
  "analytics",
  "project",
]);

/**
 * The route the app window is on, as path segments.
 *
 * Returns `null` when there is no route to read — no window yet, `about:blank`,
 * or a URL with no fragment because the router has not written one. That is a
 * different answer from "the root route", though both end up on the default
 * context: the account-wide figures are true wherever the app happens to be.
 */
export function readRouteSegments(url: string | null | undefined): readonly string[] | null {
  if (typeof url !== "string" || url.length === 0) {
    return null;
  }
  const hash = url.indexOf("#");
  if (hash === -1) {
    return null;
  }
  // A hash-history entry is `#/path?search`; the search is the router's, not
  // ours, and nothing here is decided by it.
  const fragment = url.slice(hash + 1).split("?")[0] ?? "";
  return fragment
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        // A malformed escape is not worth failing the whole read over; the raw
        // segment still tells us which branch of the route tree we are on.
        return segment;
      }
    });
}

function projectContext(kind: NotchContextKind, projectId: string | undefined): NotchContext {
  // An id-shaped route with no id is not that route as far as the router is
  // concerned either, so it falls back rather than asking about `undefined`.
  return projectId === undefined || projectId.length === 0
    ? defaultNotchContext
    : { kind, projectId, thread: null };
}

/**
 * Maps a window URL onto the context the panel should draw.
 *
 * Anything unrecognised is the default context on purpose: the account-wide
 * figures are the ones that are true everywhere, so an unmapped route degrades
 * to today's panel rather than to an empty one.
 */
export function resolveNotchContext(url: string | null | undefined): NotchContext {
  const segments = readRouteSegments(url);
  if (segments === null || segments.length === 0) {
    return defaultNotchContext;
  }

  const [first, second] = segments;
  switch (first) {
    case "infra":
      return projectContext("deployment", second);
    case "analytics":
      return projectContext("analytics", second);
    case "draft":
      return second === undefined || second.length === 0
        ? defaultNotchContext
        : { kind: "prompting", projectId: null, thread: "draft" };
    default:
      break;
  }

  // `/$environmentId/$threadId`: two segments, neither of them a route the
  // router spells out.
  if (
    segments.length === 2 &&
    first !== undefined &&
    !STATIC_FIRST_SEGMENTS.has(first) &&
    second !== undefined
  ) {
    return { kind: "prompting", projectId: null, thread: "started" };
  }

  // Everything else — `/`, `/project/...`, `/pack/...`, `/settings/...`,
  // `/pair`, `/invite` — is the project-or-nothing view the panel already had.
  return defaultNotchContext;
}

export function areNotchContextsEqual(left: NotchContext, right: NotchContext): boolean {
  return (
    left.kind === right.kind && left.projectId === right.projectId && left.thread === right.thread
  );
}

/**
 * Which read a context needs, and for what.
 *
 * One context is one request: the panel must not fetch a project's deployments
 * to draw the account's share clicks. `prompting` rides on the account read
 * because the only figure it has that is worth a round trip is token spend.
 */
export type NotchFeed =
  | { readonly kind: "account" }
  | { readonly kind: "project"; readonly projectId: string };

export function resolveNotchFeed(context: NotchContext): NotchFeed {
  return context.projectId === null
    ? { kind: "account" }
    : { kind: "project", projectId: context.projectId };
}
