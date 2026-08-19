import type { ShareLinkClaimResult, ShareLinkPreview } from "@t3tools/contracts";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary";

/**
 * The join page's two calls to the server, and nothing else.
 *
 * These are plain HTTP rather than the environment RPC on purpose. A share
 * recipient is not a member yet, has no environment connection, and may not
 * even have an account — asking them to wait for a WebSocket to bootstrap
 * before they can be told what the link is would put the slowest and most
 * failure-prone part of the app in front of the one screen that has to work for
 * a stranger. The session cookie is the only state either call needs.
 *
 * POST with a JSON body, both of them. The token is a credential: in a query
 * string it would be written to every access log and proxy along the way, and a
 * JSON body is also the one request shape a cross-site form cannot forge.
 */

export const SHARE_LINK_JOIN_TOKEN_PARAM = "s";

/** Mirrors `apps/server/src/shareLinks/http.ts`; change both or neither. */
const SHARE_LINK_PREVIEW_PATH = "/api/share-links/preview";
const SHARE_LINK_CLAIM_PATH = "/api/share-links/claim";

/**
 * What went wrong, in the two shapes the page draws differently.
 *
 * `unavailable` is every dead end the server refuses to tell apart — missing,
 * expired, revoked, not a workspace link — and the page repeats it verbatim
 * rather than guessing which one it was.
 * `wrong-account` is the only refusal that names a remedy, because it is the
 * only one the visitor can act on: they are signed in as somebody else.
 */
export type ShareJoinFailureKind = "unavailable" | "wrong-account" | "signed-out" | "failed";

export class ShareJoinError extends Error {
  readonly kind: ShareJoinFailureKind;

  constructor(kind: ShareJoinFailureKind, message: string) {
    super(message);
    this.name = "ShareJoinError";
    this.kind = kind;
  }
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text.trim().length === 0) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim().length > 0
      ? parsed.error.trim()
      : fallback;
  } catch {
    return fallback;
  }
}

function postJson(path: string, token: string): Promise<Response> {
  return fetch(resolvePrimaryEnvironmentHttpUrl(path), {
    body: JSON.stringify({ token }),
    credentials: "include",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
}

/**
 * What the link is, to somebody who has not said who they are.
 *
 * Carries no address and no workspace id — see `ShareLinkPreview`. Safe to call
 * on every render, including the one after a sign-in reloads the page: it is
 * not a redemption and does not count as a visit.
 */
export async function fetchShareLinkPreview(token: string): Promise<ShareLinkPreview> {
  const response = await postJson(SHARE_LINK_PREVIEW_PATH, token);
  if (response.status === 404) {
    throw new ShareJoinError(
      "unavailable",
      await readErrorMessage(response, "This link is not available."),
    );
  }
  if (!response.ok) {
    throw new ShareJoinError(
      "failed",
      await readErrorMessage(response, `Could not read this link (${response.status}).`),
    );
  }
  return (await response.json()) as ShareLinkPreview;
}

/**
 * Take the link up, as whoever is currently signed in.
 *
 * The account is the server's to read from the session; nothing here sends an
 * address, which is exactly why an email-scoped link cannot be talked past from
 * the browser.
 */
export async function claimShareLink(token: string): Promise<ShareLinkClaimResult> {
  const response = await postJson(SHARE_LINK_CLAIM_PATH, token);
  if (response.status === 401) {
    throw new ShareJoinError(
      "signed-out",
      await readErrorMessage(response, "Sign in to open this link."),
    );
  }
  if (response.status === 403) {
    throw new ShareJoinError(
      "wrong-account",
      await readErrorMessage(
        response,
        "This link was sent to particular people. Sign in with the address it was sent to.",
      ),
    );
  }
  if (response.status === 404) {
    throw new ShareJoinError(
      "unavailable",
      await readErrorMessage(response, "This link is not available."),
    );
  }
  if (!response.ok) {
    throw new ShareJoinError(
      "failed",
      await readErrorMessage(response, `Could not open this link (${response.status}).`),
    );
  }
  return (await response.json()) as ShareLinkClaimResult;
}

/** The token out of the address bar, and null when there is nothing to read. */
export function readShareLinkTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get(SHARE_LINK_JOIN_TOKEN_PARAM)?.trim() ?? "";
  return token.length > 0 ? token : null;
}
