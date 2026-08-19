import type {
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthClientMetadata,
  AuthCreatePairingCredentialInput,
  AuthOnboardingState,
  AuthPasswordInput,
  AuthPairingCredentialResult,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionId,
  AuthSessionState,
  AuthUpdateUserProfileInput,
  AuthUserProfile,
  AuthWebSocketTokenResult,
  SupabasePublicAuthConfig,
} from "@t3tools/contracts";

import {
  getPairingTokenFromUrl,
  stripPairingTokenFromUrl as stripPairingTokenUrl,
} from "../../pairingUrl";

import { resolvePrimaryEnvironmentHttpUrl } from "./target";
import { Data, Predicate } from "effect";

export class BootstrapHttpError extends Data.TaggedError("BootstrapHttpError")<{
  readonly message: string;
  readonly status: number;
}> {}
const isBootstrapHttpError = (u: unknown): u is BootstrapHttpError =>
  Predicate.isTagged(u, "BootstrapHttpError");

export interface ServerPairingLinkRecord {
  readonly id: string;
  readonly credential: string;
  readonly role: "owner" | "client";
  readonly subject: string;
  readonly label?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ServerClientSessionRecord {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly role: "owner" | "client";
  readonly method: "browser-session-cookie" | "bearer-session-token";
  readonly client: AuthClientMetadata;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly lastConnectedAt: string | null;
  readonly connected: boolean;
  readonly current: boolean;
}

export type ServerAuthGateState =
  | { status: "authenticated"; tenantStatus?: AuthSessionState["tenantStatus"] }
  | {
      status: "requires-auth";
      auth: AuthSessionState["auth"];
      errorMessage?: string;
    };

let bootstrapPromise: Promise<ServerAuthGateState> | null = null;
let resolvedAuthenticatedGateState: ServerAuthGateState | null = null;
const AUTH_SESSION_ESTABLISH_TIMEOUT_MS = 2_000;
const AUTH_SESSION_ESTABLISH_STEP_MS = 100;
const SUPABASE_BROWSER_ACCESS_TOKEN_STORAGE_KEY = "t3code.supabase.accessToken";
const SUPABASE_BROWSER_REFRESH_TOKEN_STORAGE_KEY = "t3code.supabase.refreshToken";
const SUPABASE_REDIRECT_PARAM_KEYS = new Set([
  "access_token",
  "error",
  "error_code",
  "error_description",
  "expires_at",
  "expires_in",
  "provider_refresh_token",
  "provider_token",
  "refresh_token",
  "sb",
  "token_type",
  "type",
]);

export type SupabaseBrowserSessionChangeReason = "changed" | "removed" | "restored";
export type SupabasePasswordAuthMode = "login" | "signup";

export interface SupabaseBrowserSessionChange {
  readonly reason: SupabaseBrowserSessionChangeReason;
  readonly tokenPresent: boolean;
}

interface BearerAuthenticatedRequestInput {
  readonly bearerToken?: string;
}

interface SupabaseBrowserTokenPair {
  readonly accessToken: string;
  readonly refreshToken?: string;
}

interface SupabaseAuthTokenResponse {
  readonly access_token?: string;
  readonly refresh_token?: string;
  readonly error?: string;
  readonly error_description?: string;
  readonly msg?: string;
}

const supabaseBrowserSessionChangeListeners = new Set<
  (change: SupabaseBrowserSessionChange) => void
>();

function authenticatedGateStateFromSession(session: AuthSessionState): ServerAuthGateState {
  return {
    status: "authenticated",
    ...(session.tenantStatus ? { tenantStatus: session.tenantStatus } : {}),
  };
}

function notifySupabaseBrowserSessionChange(change: SupabaseBrowserSessionChange): void {
  for (const listener of supabaseBrowserSessionChangeListeners) {
    listener(change);
  }
}

export function subscribeSupabaseBrowserSessionChanges(
  listener: (change: SupabaseBrowserSessionChange) => void,
): () => void {
  supabaseBrowserSessionChangeListeners.add(listener);
  return () => {
    supabaseBrowserSessionChangeListeners.delete(listener);
  };
}

export function peekPairingTokenFromUrl(): string | null {
  return getPairingTokenFromUrl(new URL(window.location.href));
}

export function stripPairingTokenFromUrl() {
  const url = new URL(window.location.href);
  const next = stripPairingTokenUrl(url);
  if (next.toString() === url.toString()) {
    return;
  }
  window.history.replaceState({}, document.title, next.toString());
}

export function takePairingTokenFromUrl(): string | null {
  const token = peekPairingTokenFromUrl();
  if (!token) {
    return null;
  }
  stripPairingTokenFromUrl();
  return token;
}

/**
 * Takes a pairing token that arrived on a deep link — a project URL, not the
 * pairing screen — so the destination survives the sign-in instead of being
 * bounced to `/pair` and losing it.
 *
 * `/pair` and `/invite` are left alone: they read the token themselves and own the
 * surface that reports a bad one, and consuming it out from under them would strip
 * the field the user is looking at. The token is removed from the address bar as
 * it is read, so it does not linger in a bookmark or a reload of a URL whose
 * single-use credential the server has already burned.
 */
function takeDeepLinkPairingToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const pathname = window.location.pathname;
  if (pathname === "/pair" || pathname === "/invite") {
    return null;
  }

  return takePairingTokenFromUrl();
}

function getDesktopBootstrapCredential(): string | null {
  const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
  return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
    ? bootstrap.bootstrapToken
    : null;
}

function bearerAuthorizationHeaders(input?: BearerAuthenticatedRequestInput) {
  const bearerToken = input?.bearerToken?.trim();
  return bearerToken ? { authorization: `Bearer ${bearerToken}` } : {};
}

function authEntryPathHeaders() {
  if (typeof window === "undefined") {
    return {};
  }
  const pathname = window.location.pathname;
  return pathname === "/invite" || pathname === "/pair" ? { "x-t3-auth-entry-path": pathname } : {};
}

function currentBearerAuthenticatedRequestInput(
  input?: BearerAuthenticatedRequestInput,
): BearerAuthenticatedRequestInput | undefined {
  if (input) {
    return input;
  }

  const accessToken = readSupabaseBrowserAccessToken();
  return accessToken ? { bearerToken: accessToken } : undefined;
}

function requireBearerToken(bearerToken: string): string {
  const trimmedBearerToken = bearerToken.trim();
  if (!trimmedBearerToken) {
    throw new Error("Supabase access token is required.");
  }
  return trimmedBearerToken;
}

function readSupabaseRedirectParams(url: URL): URLSearchParams | null {
  const hashParams = url.hash.startsWith("#") ? new URLSearchParams(url.hash.slice(1)) : null;
  if (hashParams && hasSupabaseRedirectParams(hashParams)) {
    return hashParams;
  }

  return hasSupabaseRedirectParams(url.searchParams) ? url.searchParams : null;
}

function hasSupabaseRedirectParams(params: URLSearchParams): boolean {
  for (const key of SUPABASE_REDIRECT_PARAM_KEYS) {
    if (params.has(key)) {
      return true;
    }
  }
  return false;
}

function stripSupabaseRedirectParamsFromSearchParams(params: URLSearchParams): boolean {
  let changed = false;
  for (const key of SUPABASE_REDIRECT_PARAM_KEYS) {
    if (params.has(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed;
}

function stripSupabaseRedirectParamsFromUrl(): void {
  const current = new URL(window.location.href);
  const next = new URL(current.toString());
  const strippedSearch = stripSupabaseRedirectParamsFromSearchParams(next.searchParams);
  let strippedHash = false;

  if (next.hash.startsWith("#")) {
    const hashParams = new URLSearchParams(next.hash.slice(1));
    strippedHash = stripSupabaseRedirectParamsFromSearchParams(hashParams);
    if (strippedHash) {
      const nextHash = hashParams.toString();
      next.hash = nextHash ? `#${nextHash}` : "";
    }
  }

  if (strippedSearch || strippedHash) {
    window.history.replaceState({}, document.title, next.toString());
  }
}

function readSupabaseRedirectError(params: URLSearchParams): string | null {
  const description = params.get("error_description")?.trim();
  const error = params.get("error")?.trim();
  const code = params.get("error_code")?.trim();
  return description || error || code || null;
}

export function takeSupabaseRedirectTokenPairFromUrl(): SupabaseBrowserTokenPair | null {
  const url = new URL(window.location.href);
  const params = readSupabaseRedirectParams(url);
  if (!params) {
    return null;
  }

  try {
    const error = readSupabaseRedirectError(params);
    if (error) {
      throw new Error(error);
    }

    const accessToken = params.get("access_token")?.trim();
    if (!accessToken) {
      throw new Error("Supabase confirmation link did not include an access token.");
    }

    const refreshToken = params.get("refresh_token")?.trim();
    return {
      accessToken,
      ...(refreshToken ? { refreshToken } : {}),
    };
  } finally {
    stripSupabaseRedirectParamsFromUrl();
  }
}

function getBrowserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readSupabaseBrowserAccessToken(): string | null {
  const token = getBrowserStorage()?.getItem(SUPABASE_BROWSER_ACCESS_TOKEN_STORAGE_KEY)?.trim();
  return token ? token : null;
}

export function readSupabaseBrowserRefreshToken(): string | null {
  const token = getBrowserStorage()?.getItem(SUPABASE_BROWSER_REFRESH_TOKEN_STORAGE_KEY)?.trim();
  return token ? token : null;
}

function writeSupabaseBrowserTokenPair(tokens: SupabaseBrowserTokenPair): void {
  const token = requireBearerToken(tokens.accessToken);
  const previousToken = readSupabaseBrowserAccessToken();
  const storage = getBrowserStorage();
  storage?.setItem(SUPABASE_BROWSER_ACCESS_TOKEN_STORAGE_KEY, token);
  if (tokens.refreshToken?.trim()) {
    storage?.setItem(SUPABASE_BROWSER_REFRESH_TOKEN_STORAGE_KEY, tokens.refreshToken.trim());
  }
  if (previousToken !== token) {
    notifySupabaseBrowserSessionChange({ reason: "changed", tokenPresent: true });
  }
}

export function writeSupabaseBrowserAccessToken(accessToken: string): void {
  writeSupabaseBrowserTokenPair({ accessToken });
}

export function removeSupabaseBrowserAccessToken(): void {
  const previousToken = readSupabaseBrowserAccessToken();
  const storage = getBrowserStorage();
  storage?.removeItem(SUPABASE_BROWSER_ACCESS_TOKEN_STORAGE_KEY);
  storage?.removeItem(SUPABASE_BROWSER_REFRESH_TOKEN_STORAGE_KEY);
  if (previousToken) {
    notifySupabaseBrowserSessionChange({ reason: "removed", tokenPresent: false });
  }
}

export function signOutSupabaseBrowserSession(): void {
  removeSupabaseBrowserAccessToken();
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
}

export async function fetchSessionState(
  input?: BearerAuthenticatedRequestInput,
): Promise<AuthSessionState> {
  return retryTransientBootstrap(async () => {
    const headers = {
      ...authEntryPathHeaders(),
      ...bearerAuthorizationHeaders(input),
    };
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/session"), {
      credentials: "include",
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
    if (!response.ok) {
      throw new BootstrapHttpError({
        message: `Failed to load server auth session state (${response.status}).`,
        status: response.status,
      });
    }
    return (await response.json()) as AuthSessionState;
  });
}

export async function signOutLocalServerSession(): Promise<void> {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/session/sign-out"), {
    method: "POST",
    credentials: "include",
  });
  if (!response.ok) {
    throw new BootstrapHttpError({
      message: `Failed to sign out (${response.status}).`,
      status: response.status,
    });
  }
}

export function readSupabasePublicAuthConfig(
  session: AuthSessionState,
): SupabasePublicAuthConfig | null {
  const config = session.auth.supabase;
  if (!config) {
    return null;
  }

  return {
    projectUrl: config.projectUrl,
    anonKey: config.anonKey,
    ...(config.audience ? { audience: config.audience } : {}),
  };
}

export async function fetchSupabasePublicAuthConfig(): Promise<SupabasePublicAuthConfig | null> {
  return readSupabasePublicAuthConfig(await fetchSessionState());
}

export async function fetchSupabaseBearerSessionState(
  accessToken: string,
): Promise<AuthSessionState> {
  return fetchSessionState({ bearerToken: requireBearerToken(accessToken) });
}

export async function submitSupabaseBrowserAccessToken(
  accessToken: string,
): Promise<AuthSessionState> {
  const token = requireBearerToken(accessToken);
  const session = await fetchSupabaseBearerSessionState(token);
  if (!session.authenticated) {
    removeSupabaseBrowserAccessToken();
    throw new Error("Supabase session was not accepted.");
  }
  writeSupabaseBrowserAccessToken(token);
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = authenticatedGateStateFromSession(session);
  return session;
}

export async function submitSupabasePasswordAuth(input: {
  readonly config: SupabasePublicAuthConfig;
  readonly email: string;
  readonly password: string;
  readonly mode: SupabasePasswordAuthMode;
}): Promise<AuthSessionState> {
  const email = input.email.trim();
  const password = input.password;
  if (!email) {
    throw new Error("Enter an email address to continue.");
  }
  if (!password) {
    throw new Error("Enter a password to continue.");
  }

  const tokens =
    input.mode === "signup"
      ? await signUpWithSupabasePassword(input.config, { email, password })
      : await signInWithSupabasePassword(input.config, { email, password });
  return submitSupabaseBrowserTokenPair(tokens);
}

export async function submitLocalPasswordAuth(input: {
  readonly email: string;
  readonly password: string;
  readonly mode: SupabasePasswordAuthMode;
}): Promise<AuthSessionState> {
  const email = input.email.trim();
  const password = input.password;
  if (!email) {
    throw new Error("Enter an email address to continue.");
  }
  if (!password) {
    throw new Error("Enter a password to continue.");
  }

  const payload: AuthPasswordInput = {
    email,
    password,
    mode: input.mode,
  };
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/password"), {
    body: JSON.stringify(payload),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Local authentication failed (${response.status}).`),
    );
  }

  bootstrapPromise = null;
  const session = await waitForAuthenticatedSessionAfterBootstrap();
  resolvedAuthenticatedGateState = authenticatedGateStateFromSession(session);
  return session;
}

async function submitSupabaseBrowserTokenPair(
  tokens: SupabaseBrowserTokenPair,
): Promise<AuthSessionState> {
  const token = requireBearerToken(tokens.accessToken);
  const session = await fetchSupabaseBearerSessionState(token);
  if (!session.authenticated) {
    removeSupabaseBrowserAccessToken();
    throw new Error("Supabase session was not accepted.");
  }
  writeSupabaseBrowserTokenPair(tokens);
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = authenticatedGateStateFromSession(session);
  return session;
}

async function signInWithSupabasePassword(
  config: SupabasePublicAuthConfig,
  credentials: { readonly email: string; readonly password: string },
): Promise<SupabaseBrowserTokenPair> {
  return requestSupabasePasswordToken(config, "/auth/v1/token?grant_type=password", credentials);
}

async function signUpWithSupabasePassword(
  config: SupabasePublicAuthConfig,
  credentials: { readonly email: string; readonly password: string },
): Promise<SupabaseBrowserTokenPair> {
  return requestSupabasePasswordToken(config, "/auth/v1/signup", credentials, {
    missingAccessTokenMessage: "Check your email to finish signing up, then log in.",
  });
}

async function refreshSupabaseBrowserSession(
  config: SupabasePublicAuthConfig,
): Promise<SupabaseBrowserTokenPair | null> {
  const refreshToken = readSupabaseBrowserRefreshToken();
  if (!refreshToken) {
    return null;
  }

  return requestSupabasePasswordToken(config, "/auth/v1/token?grant_type=refresh_token", {
    refresh_token: refreshToken,
  });
}

async function requestSupabasePasswordToken(
  config: SupabasePublicAuthConfig,
  path: string,
  body: unknown,
  options?: {
    readonly missingAccessTokenMessage?: string;
  },
): Promise<SupabaseBrowserTokenPair> {
  const response = await fetch(resolveSupabaseAuthUrl(config, path), {
    body: JSON.stringify(body),
    headers: {
      apikey: config.anonKey,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json().catch(() => ({}))) as SupabaseAuthTokenResponse;
  if (!response.ok) {
    throw new Error(
      payload.error_description ??
        payload.msg ??
        payload.error ??
        `Supabase authentication failed (${response.status}).`,
    );
  }

  if (!payload.access_token) {
    throw new Error(
      options?.missingAccessTokenMessage ?? "Supabase did not return an access token.",
    );
  }

  return {
    accessToken: payload.access_token,
    ...(payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
  };
}

function resolveSupabaseAuthUrl(config: SupabasePublicAuthConfig, path: string): string {
  return new URL(
    path,
    config.projectUrl.endsWith("/") ? config.projectUrl : `${config.projectUrl}/`,
  ).toString();
}

export async function fetchUserProfile(
  input?: BearerAuthenticatedRequestInput,
): Promise<AuthUserProfile> {
  const headers = bearerAuthorizationHeaders(currentBearerAuthenticatedRequestInput(input));
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/profile"), {
    credentials: "include",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load account profile (${response.status}).`),
    );
  }
  return (await response.json()) as AuthUserProfile;
}

export async function updateUserProfile(
  payload: AuthUpdateUserProfileInput,
  input?: BearerAuthenticatedRequestInput,
): Promise<AuthUserProfile> {
  const headers = bearerAuthorizationHeaders(currentBearerAuthenticatedRequestInput(input));
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/profile"), {
    method: "PATCH",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to update account profile (${response.status}).`),
    );
  }
  return (await response.json()) as AuthUserProfile;
}

export async function fetchSupabaseBearerUserProfile(
  accessToken: string,
): Promise<AuthUserProfile> {
  return fetchUserProfile({ bearerToken: requireBearerToken(accessToken) });
}

export async function issueSupabaseBearerWebSocketToken(
  accessToken: string,
): Promise<AuthWebSocketTokenResult> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/ws-token"), {
    credentials: "include",
    headers: bearerAuthorizationHeaders({ bearerToken: requireBearerToken(accessToken) }),
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to issue WebSocket token (${response.status}).`),
    );
  }
  return (await response.json()) as AuthWebSocketTokenResult;
}

export async function resolveSupabasePrimaryWebSocketConnectionUrl(wsBaseUrl: string) {
  const accessToken = readSupabaseBrowserAccessToken();
  if (!accessToken) {
    return wsBaseUrl;
  }

  const issued = await issueSupabaseBearerWebSocketToken(accessToken);
  const url = new URL(wsBaseUrl, window.location.origin);
  url.searchParams.set("wsToken", issued.token);
  return url.toString();
}

export async function fetchOnboardingState(
  input?: BearerAuthenticatedRequestInput,
): Promise<AuthOnboardingState> {
  const headers = bearerAuthorizationHeaders(currentBearerAuthenticatedRequestInput(input));
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/onboarding"), {
    credentials: "include",
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  });
  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load onboarding state (${response.status}).`),
    );
  }
  return (await response.json()) as AuthOnboardingState;
}

async function readErrorMessage(response: Response, fallbackMessage: string): Promise<string> {
  const text = await response.text();
  return parseErrorResponseMessage(text) ?? fallbackMessage;
}

function parseErrorResponseMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      parsed.error.trim().length > 0
    ) {
      return parsed.error.trim();
    }
  } catch {
    return trimmed;
  }
  return trimmed;
}

async function exchangeBootstrapCredential(credential: string): Promise<AuthBootstrapResult> {
  return retryTransientBootstrap(async () => {
    const payload: AuthBootstrapInput = { credential };
    const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/bootstrap"), {
      body: JSON.stringify(payload),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });

    if (!response.ok) {
      const message = parseErrorResponseMessage(await response.text());
      throw new BootstrapHttpError({
        message: message || `Failed to bootstrap auth session (${response.status}).`,
        status: response.status,
      });
    }

    return (await response.json()) as AuthBootstrapResult;
  });
}

async function waitForAuthenticatedSessionAfterBootstrap(): Promise<AuthSessionState> {
  const startedAt = Date.now();

  while (true) {
    const session = await fetchSessionState();
    if (session.authenticated) {
      return session;
    }

    if (Date.now() - startedAt >= AUTH_SESSION_ESTABLISH_TIMEOUT_MS) {
      throw new Error("Timed out waiting for authenticated session after bootstrap.");
    }

    await waitForBootstrapRetry(AUTH_SESSION_ESTABLISH_STEP_MS);
  }
}

const TRANSIENT_BOOTSTRAP_STATUS_CODES = new Set([502, 503, 504]);
const BOOTSTRAP_RETRY_TIMEOUT_MS = 15_000;
const BOOTSTRAP_RETRY_STEP_MS = 500;

export async function retryTransientBootstrap<T>(operation: () => Promise<T>): Promise<T> {
  const startedAt = Date.now();
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransientBootstrapError(error)) {
        throw error;
      }

      if (Date.now() - startedAt >= BOOTSTRAP_RETRY_TIMEOUT_MS) {
        throw error;
      }

      await waitForBootstrapRetry(BOOTSTRAP_RETRY_STEP_MS);
    }
  }
}

function waitForBootstrapRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function isTransientBootstrapError(error: unknown): boolean {
  if (isBootstrapHttpError(error)) {
    return TRANSIENT_BOOTSTRAP_STATUS_CODES.has(error.status);
  }

  if (error instanceof TypeError) {
    return true;
  }

  return error instanceof DOMException && error.name === "AbortError";
}

async function bootstrapServerAuth(): Promise<ServerAuthGateState> {
  const bootstrapCredential = getDesktopBootstrapCredential();
  let supabaseRestoreErrorMessage: string | undefined;
  let restoredSupabaseSession: ServerAuthGateState | null = null;
  try {
    restoredSupabaseSession = await restoreSupabaseBrowserSession();
  } catch (error) {
    supabaseRestoreErrorMessage =
      error instanceof Error ? error.message : "Supabase confirmation failed.";
  }
  if (restoredSupabaseSession) {
    return restoredSupabaseSession;
  }

  const currentSession = await fetchSessionState();
  if (currentSession.authenticated) {
    return authenticatedGateStateFromSession(currentSession);
  }

  const urlPairingToken = takeDeepLinkPairingToken();
  if (urlPairingToken) {
    try {
      await exchangeBootstrapCredential(urlPairingToken);
      const session = await waitForAuthenticatedSessionAfterBootstrap();
      return authenticatedGateStateFromSession(session);
    } catch (error) {
      return {
        status: "requires-auth",
        auth: currentSession.auth,
        errorMessage: error instanceof Error ? error.message : "Authentication failed.",
      };
    }
  }

  if (!bootstrapCredential) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      ...(supabaseRestoreErrorMessage ? { errorMessage: supabaseRestoreErrorMessage } : {}),
    };
  }

  try {
    await exchangeBootstrapCredential(bootstrapCredential);
    const session = await waitForAuthenticatedSessionAfterBootstrap();
    return authenticatedGateStateFromSession(session);
  } catch (error) {
    return {
      status: "requires-auth",
      auth: currentSession.auth,
      errorMessage: error instanceof Error ? error.message : "Authentication failed.",
    };
  }
}

async function restoreSupabaseBrowserSession(): Promise<ServerAuthGateState | null> {
  const redirectTokens = takeSupabaseRedirectTokenPairFromUrl();
  if (redirectTokens) {
    try {
      const confirmedSession = await submitSupabaseBrowserTokenPair(redirectTokens);
      notifySupabaseBrowserSessionChange({ reason: "restored", tokenPresent: true });
      return authenticatedGateStateFromSession(confirmedSession);
    } catch (error) {
      removeSupabaseBrowserAccessToken();
      throw error;
    }
  }

  const accessToken = readSupabaseBrowserAccessToken();
  if (!accessToken) {
    return null;
  }

  try {
    const restoredSession = await fetchSupabaseBearerSessionState(accessToken);
    if (restoredSession.authenticated) {
      notifySupabaseBrowserSessionChange({ reason: "restored", tokenPresent: true });
      return authenticatedGateStateFromSession(restoredSession);
    }
  } catch {
    const currentSession = await fetchSessionState();
    const config = readSupabasePublicAuthConfig(currentSession);
    if (config) {
      try {
        const refreshedTokens = await refreshSupabaseBrowserSession(config);
        if (refreshedTokens) {
          const refreshedSession = await submitSupabaseBrowserTokenPair(refreshedTokens);
          notifySupabaseBrowserSessionChange({ reason: "restored", tokenPresent: true });
          return authenticatedGateStateFromSession(refreshedSession);
        }
      } catch {
        // Stale browser tokens should fall back to the visible auth gate.
      }
    }
  }

  removeSupabaseBrowserAccessToken();
  return null;
}

export async function submitServerAuthCredential(credential: string): Promise<void> {
  const trimmedCredential = credential.trim();
  if (!trimmedCredential) {
    throw new Error("Enter a pairing token to continue.");
  }

  resolvedAuthenticatedGateState = null;
  await exchangeBootstrapCredential(trimmedCredential);
  bootstrapPromise = null;
  stripPairingTokenFromUrl();
}

/**
 * Asks the server for a pairing credential that stands in for *this* session, to
 * hand it to a browser that has no cookie of ours — the desktop renderer opening
 * a project in the system browser.
 *
 * Distinct from `createServerPairingCredential`, which mints a `client` credential
 * for somebody else's device. This one carries no body precisely so it cannot ask
 * for anything: the server reads the role and subject off the calling session, so
 * the credential is worth exactly what the caller already holds and nothing more.
 */
export async function createBrowserHandoffCredential(): Promise<AuthPairingCredentialResult> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-token/self"), {
    credentials: "include",
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to create a browser hand-off credential (${response.status}).`,
      ),
    );
  }

  return (await response.json()) as AuthPairingCredentialResult;
}

export async function createServerPairingCredential(
  label?: string,
): Promise<AuthPairingCredentialResult> {
  const trimmedLabel = label?.trim();
  const payload: AuthCreatePairingCredentialInput = trimmedLabel ? { label: trimmedLabel } : {};
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-token"), {
    body: JSON.stringify(payload),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to create pairing credential (${response.status}).`),
    );
  }

  return (await response.json()) as AuthPairingCredentialResult;
}

export async function listServerPairingLinks(): Promise<ReadonlyArray<ServerPairingLinkRecord>> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links"), {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load pairing links (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerPairingLinkRecord>;
}

export async function revokeServerPairingLink(id: string): Promise<void> {
  const payload: AuthRevokePairingLinkInput = { id };
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/pairing-links/revoke"), {
    body: JSON.stringify(payload),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke pairing link (${response.status}).`),
    );
  }
}

export async function listServerClientSessions(): Promise<
  ReadonlyArray<ServerClientSessionRecord>
> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/clients"), {
    credentials: "include",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to load paired clients (${response.status}).`),
    );
  }

  return (await response.json()) as ReadonlyArray<ServerClientSessionRecord>;
}

export async function revokeServerClientSession(sessionId: AuthSessionId): Promise<void> {
  const payload: AuthRevokeClientSessionInput = { sessionId };
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke"), {
    body: JSON.stringify(payload),
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    method: "POST",
  });

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(response, `Failed to revoke client session (${response.status}).`),
    );
  }
}

export async function revokeOtherServerClientSessions(): Promise<number> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl("/api/auth/clients/revoke-others"),
    {
      credentials: "include",
      method: "POST",
    },
  );

  if (!response.ok) {
    throw new Error(
      await readErrorMessage(
        response,
        `Failed to revoke other client sessions (${response.status}).`,
      ),
    );
  }

  const result = (await response.json()) as { revokedCount?: number };
  return result.revokedCount ?? 0;
}

export async function resolveInitialServerAuthGateState(): Promise<ServerAuthGateState> {
  if (resolvedAuthenticatedGateState?.status === "authenticated") {
    return resolvedAuthenticatedGateState;
  }

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  const nextPromise = bootstrapServerAuth();
  bootstrapPromise = nextPromise;
  return nextPromise
    .then((result) => {
      if (result.status === "authenticated") {
        resolvedAuthenticatedGateState = result;
      }
      return result;
    })
    .finally(() => {
      if (bootstrapPromise === nextPromise) {
        bootstrapPromise = null;
      }
    });
}

export function __resetServerAuthBootstrapForTests() {
  bootstrapPromise = null;
  resolvedAuthenticatedGateState = null;
  removeSupabaseBrowserAccessToken();
  supabaseBrowserSessionChangeListeners.clear();
}
