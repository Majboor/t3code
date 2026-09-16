import { DateTime, Effect, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { respondToAuthError } from "./http.ts";
import { ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

/**
 * Quick logins for an internal server: `https://host/?waleed` signs in as the
 * account the operator mapped to `waleed`, with no password screen.
 *
 * There are two ways a name resolves:
 *  - The explicit map in `T3CODE_QUICK_LOGINS` on the server, as
 *    `name=email:password;name2=email2:password2`.
 *  - Auto-provisioning: when `T3CODE_QUICK_LOGIN_AUTOCREATE=true`, any new
 *    simple name (letters, digits, hyphens) becomes `name@logicpacks.internal`
 *    with a derived password, created on first visit and re-used on every
 *    visit after. This is what lets a shared internal server add a teammate by
 *    just changing the `?name` in the URL — `?haroon`, `?ahad`, and so on.
 *
 * Nothing about any of this reaches the browser: the root page only redirects a
 * bare `?name` query to `/api/auth/quick?name=…`, which runs the ordinary
 * password login (or a one-time signup) on the server and sets the same session
 * cookie the login form would. Unset both variables and the route disappears.
 */
export interface QuickLogin {
  readonly email: string;
  readonly password: string;
  /** Present for auto-provisioned names, so the route signs up if login misses. */
  readonly displayName?: string;
  readonly autoCreate?: boolean;
}

export function readQuickLogins(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ReadonlyMap<string, QuickLogin> {
  const raw = env["T3CODE_QUICK_LOGINS"]?.trim();
  const logins = new Map<string, QuickLogin>();
  if (!raw) return logins;
  for (const entry of raw.split(";")) {
    const eq = entry.indexOf("=");
    const colon = entry.indexOf(":", eq + 1);
    if (eq <= 0 || colon <= eq + 1) continue;
    const name = entry.slice(0, eq).trim().toLowerCase();
    const email = entry.slice(eq + 1, colon).trim();
    const password = entry.slice(colon + 1);
    if (name && email && password) logins.set(name, { email, password });
  }
  return logins;
}

export function quickLoginAutoCreateEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env["T3CODE_QUICK_LOGIN_AUTOCREATE"] === "true";
}

/**
 * A name safe to turn into an email local-part and a workspace label: starts
 * with a letter or digit, then letters, digits or hyphens, at most 32 long.
 * This keeps a stray query key like `?utm_source` or `?_ga` from minting an
 * account, and keeps the derived email well-formed.
 */
const QUICK_LOGIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
const AUTO_QUICK_LOGIN_EMAIL_DOMAIN = "logicpacks.internal";

export function isValidQuickLoginName(name: string): boolean {
  return QUICK_LOGIN_NAME_PATTERN.test(name);
}

/**
 * A stable account for a name: the same `?name` always resolves to the same
 * email and password, so the first visit creates the account and every visit
 * after logs into it. The password is derived, not secret — this is an internal
 * server whose whole point is that changing the URL is enough.
 */
export function deriveAutoQuickLogin(name: string): QuickLogin {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1);
  return {
    email: `${name}@${AUTO_QUICK_LOGIN_EMAIL_DOMAIN}`,
    password: `Auto-${displayName}-Internal-2026!`,
    displayName,
    autoCreate: true,
  };
}

/** Resolves a name to an explicit quick login, an auto-provisioned one, or null. */
export function resolveQuickLogin(
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): QuickLogin | null {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return null;
  const explicit = readQuickLogins(env).get(normalized);
  if (explicit) return explicit;
  if (quickLoginAutoCreateEnabled(env) && isValidQuickLoginName(normalized)) {
    return deriveAutoQuickLogin(normalized);
  }
  return null;
}

/** `?waleed` (a bare key with no value) names a quick login; `?waleed=1` does too. */
export function quickLoginNameFromSearch(
  search: URLSearchParams,
  logins: ReadonlyMap<string, QuickLogin>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const autoCreate = quickLoginAutoCreateEnabled(env);
  for (const key of search.keys()) {
    const name = key.trim().toLowerCase();
    if (logins.has(name)) return name;
    // Auto-provision only for a bare flag (`?haroon`), never a valued param
    // (`?ref=abc`, `?utm-source=x`), so a shared or tracked link cannot mint an
    // account by accident.
    if (autoCreate && isValidQuickLoginName(name) && search.get(key) === "") return name;
  }
  return null;
}

export const authQuickLoginRouteLayer = HttpRouter.add(
  "GET",
  "/api/auth/quick",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;
    const url = HttpServerRequest.toURL(request);
    const name = Option.isSome(url) ? (url.value.searchParams.get("name") ?? "") : "";
    const login = resolveQuickLogin(name);
    if (!login) {
      return HttpServerResponse.text("No such quick login.", { status: 404 });
    }
    const metadata = deriveAuthClientMetadata({ request, label: login.email });
    // An auto-provisioned name logs in if the account exists, and signs up the
    // first time it does not. An explicit mapping only ever logs in.
    const result = yield* serverAuth
      .authenticatePassword({ email: login.email, password: login.password, mode: "login" }, metadata)
      .pipe(
        Effect.catchTag("AuthError", (error) =>
          login.autoCreate
            ? serverAuth.authenticatePassword(
                {
                  email: login.email,
                  password: login.password,
                  mode: "signup",
                  ...(login.displayName ? { displayName: login.displayName } : {}),
                },
                metadata,
              )
            : Effect.fail(error),
        ),
      );
    return yield* HttpServerResponse.redirect("/", { status: 302 }).pipe(
      HttpServerResponse.setCookie(sessions.cookieName, result.sessionToken, {
        expires: DateTime.toDate(result.response.expiresAt),
        httpOnly: true,
        path: "/",
        sameSite: "lax",
      }),
    );
  }).pipe(Effect.catchTag("AuthError", (error) => respondToAuthError(error))),
);
