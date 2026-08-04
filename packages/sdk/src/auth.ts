/**
 * HTTP side of the SDK: everything needed to turn credentials into a session
 * the websocket transport can use.
 *
 * @module auth
 */

export type T3Credentials =
  | { readonly kind: "password"; readonly email: string; readonly password: string }
  | {
      readonly kind: "signup";
      readonly email: string;
      readonly password: string;
      readonly displayName?: string;
    }
  | { readonly kind: "pairingToken"; readonly token: string }
  | { readonly kind: "bearer"; readonly token: string };

export interface T3Session {
  /** Bearer token accepted by both the HTTP API and the websocket upgrade. */
  readonly token: string;
  readonly role: string;
  readonly expiresAt: string | null;
}

export class T3AuthError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "T3AuthError";
    this.status = status;
  }
}

function joinUrl(baseUrl: string, path: string): string {
  return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { error: text };
  }
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(joinUrl(baseUrl, path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload["error"] === "string" ? payload["error"] : response.statusText;
    throw new T3AuthError(message, response.status);
  }
  return payload;
}

/**
 * Exchange credentials for a bearer session token.
 *
 * Password and pairing-token credentials are exchanged with the server;
 * a Supabase access token is already a bearer credential and is returned as-is.
 */
export async function authenticate(
  baseUrl: string,
  credentials: T3Credentials,
): Promise<T3Session> {
  if (credentials.kind === "bearer") {
    return { token: credentials.token, role: "client", expiresAt: null };
  }

  if (credentials.kind === "pairingToken") {
    const payload = await postJson(baseUrl, "api/auth/bootstrap/bearer", {
      credential: credentials.token,
    });
    const token = payload["sessionToken"];
    if (typeof token !== "string") {
      throw new T3AuthError("Server did not return a session token.", 500);
    }
    return {
      token,
      role: typeof payload["role"] === "string" ? payload["role"] : "client",
      expiresAt: typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : null,
    };
  }

  const response = await fetch(joinUrl(baseUrl, "api/auth/password"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: credentials.email,
      password: credentials.password,
      mode: credentials.kind === "signup" ? "signup" : "login",
      ...(credentials.kind === "signup" && credentials.displayName
        ? { displayName: credentials.displayName }
        : {}),
    }),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    const message = typeof payload["error"] === "string" ? payload["error"] : response.statusText;
    throw new T3AuthError(message, response.status);
  }

  // The password route authenticates via a Set-Cookie session; convert it into a
  // bearer token so the SDK stays cookie-free.
  const cookie = response.headers.get("set-cookie");
  const token = cookie?.match(/t3_session=([^;]+)/)?.[1];
  if (!token) {
    throw new T3AuthError("Server did not return a session cookie.", 500);
  }
  return {
    token: decodeURIComponent(token),
    role: typeof payload["role"] === "string" ? payload["role"] : "client",
    expiresAt: typeof payload["expiresAt"] === "string" ? payload["expiresAt"] : null,
  };
}

export interface T3SessionState {
  readonly authenticated: boolean;
  readonly role?: string;
  readonly tenantStatus?: string;
  readonly tenantSession?: Record<string, unknown>;
}

export async function getSessionState(baseUrl: string, token: string): Promise<T3SessionState> {
  const response = await fetch(joinUrl(baseUrl, "api/auth/session"), {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new T3AuthError(
      typeof payload["error"] === "string" ? payload["error"] : response.statusText,
      response.status,
    );
  }
  return payload as unknown as T3SessionState;
}

/** Mint a short-lived token used to authenticate the websocket upgrade. */
export async function issueWebSocketToken(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(joinUrl(baseUrl, "api/auth/ws-token"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new T3AuthError(
      typeof payload["error"] === "string" ? payload["error"] : response.statusText,
      response.status,
    );
  }
  const wsToken = payload["token"] ?? payload["wsToken"];
  if (typeof wsToken !== "string") {
    throw new T3AuthError("Server did not return a websocket token.", 500);
  }
  return wsToken;
}

export function deriveWebSocketUrl(baseUrl: string, wsToken: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = new URLSearchParams([["wsToken", wsToken]]).toString();
  return url.toString();
}
