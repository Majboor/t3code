import { afterEach, expect, it, vi } from "vitest";

const liveProjectUrl = process.env.T3CODE_SUPABASE_PROJECT_URL?.trim();
const liveAnonKey = process.env.T3CODE_SUPABASE_ANON_KEY?.trim();
const liveSecretKey = process.env.SUPABASE_SECRET_KEY?.trim();
const hasLiveSupabaseEnv = Boolean(liveProjectUrl && liveAnonKey && liveSecretKey);

type JsonRecord = Record<string, unknown>;

function createTestStorage(): Storage {
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => Array.from(items.keys())[index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}

function installTestBrowser() {
  const testWindow = {
    location: new URL("https://app.example.test/"),
    history: {
      replaceState: (_data: unknown, _unused: string, nextUrl: string) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
    origin: "https://app.example.test",
  };
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "T3 Code" });
  vi.stubGlobal("localStorage", createTestStorage());
  return testWindow;
}

function makeLiveEmail(): string {
  return `t3-web-live-${Date.now()}-${Math.random().toString(36).slice(2)}@majboor.com`;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(message);
  }
  return value;
}

async function readJson(response: Response): Promise<JsonRecord> {
  return (await response.json().catch(() => ({}))) as JsonRecord;
}

async function requestSupabaseJson(input: {
  readonly path: string;
  readonly key: string;
  readonly body?: unknown;
  readonly method?: string;
  readonly bearer?: string;
}): Promise<JsonRecord> {
  const response = await fetch(new URL(input.path, liveProjectUrl).toString(), {
    ...(input.body !== undefined ? { body: JSON.stringify(input.body) } : {}),
    headers: {
      apikey: input.key,
      ...(input.bearer ? { authorization: `Bearer ${input.bearer}` } : {}),
      ...(input.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    method: input.method ?? (input.body === undefined ? "GET" : "POST"),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const detail =
      typeof body.msg === "string"
        ? body.msg
        : typeof body.error_description === "string"
          ? body.error_description
          : typeof body.error === "string"
            ? body.error
            : `HTTP ${response.status}`;
    throw new Error(`Supabase live request failed for ${input.path}: ${detail}`);
  }
  return body;
}

async function createConfirmedSupabaseUser(input: {
  readonly email: string;
  readonly password: string;
}): Promise<string> {
  const created = await requestSupabaseJson({
    path: "/auth/v1/admin/users",
    key: liveSecretKey!,
    bearer: liveSecretKey!,
    body: {
      email: input.email,
      password: input.password,
      email_confirm: true,
      user_metadata: {
        full_name: "T3 Web Live User",
        tenant_id: "tenant-web-live",
        active_workspace_id: "workspace-web-live",
      },
    },
  });
  return requireString(created.id, "Supabase admin create did not return a user id.");
}

async function generateSupabaseSignupActionLink(input: {
  readonly email: string;
  readonly password: string;
  readonly redirectTo: string;
}): Promise<{ readonly actionLink: string; readonly userId: string }> {
  const generated = await requestSupabaseJson({
    path: "/auth/v1/admin/generate_link",
    key: liveSecretKey!,
    bearer: liveSecretKey!,
    body: {
      type: "signup",
      email: input.email,
      password: input.password,
      redirect_to: input.redirectTo,
      data: {
        full_name: "T3 Web Redirect User",
        tenant_id: "tenant-web-live",
        active_workspace_id: "workspace-web-live",
      },
    },
  });

  return {
    actionLink: requireString(generated.action_link, "Supabase did not return an action link."),
    userId: requireString(generated.id, "Supabase generated link did not return a user id."),
  };
}

async function followSupabaseActionLinkForRedirect(input: {
  readonly actionLink: string;
  readonly fetchImpl: typeof fetch;
}): Promise<string> {
  let nextUrl = input.actionLink;
  const supabaseOrigin = new URL(liveProjectUrl!).origin;
  for (let redirects = 0; redirects < 8; redirects += 1) {
    const response = await input.fetchImpl(nextUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    if (location) {
      const resolved = new URL(location, nextUrl);
      if (resolved.origin !== supabaseOrigin) {
        return resolved.toString();
      }
      nextUrl = resolved.toString();
      continue;
    }
    if (response.url && new URL(response.url).origin !== supabaseOrigin) {
      return response.url;
    }
    throw new Error(`Supabase action link stopped before the app redirect (${response.status}).`);
  }
  throw new Error("Supabase action link redirected too many times.");
}

async function deleteSupabaseUser(userId: string): Promise<void> {
  await requestSupabaseJson({
    path: `/auth/v1/admin/users/${userId}`,
    key: liveSecretKey!,
    bearer: liveSecretKey!,
    method: "DELETE",
  });
}

function installHybridFetch(realFetch: typeof fetch) {
  let staleAccessToken: string | null = null;
  let acceptedRefreshedBearer = false;
  let rejectedStaleBearer = false;
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input), "https://app.example.test");
    if (url.origin === liveProjectUrl) {
      return realFetch(input, init);
    }
    if (url.pathname === "/api/auth/session") {
      const headers = new Headers(init?.headers);
      const authorization = headers.get("authorization");
      if (authorization === `Bearer ${staleAccessToken}`) {
        rejectedStaleBearer = true;
        return new Response("Unauthorized", { status: 401 });
      }
      if (authorization?.startsWith("Bearer ") && staleAccessToken !== null) {
        acceptedRefreshedBearer = true;
      }
      return Response.json({
        authenticated: Boolean(authorization?.startsWith("Bearer ")),
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: liveProjectUrl,
            anonKey: liveAnonKey,
          },
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        expiresAt: "2026-05-09T12:00:00.000Z",
        tenantStatus: "active",
      });
    }
    throw new Error(`Unexpected live auth fetch: ${url.toString()}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return {
    fetchMock,
    markStaleAccessToken(token: string) {
      staleAccessToken = token;
    },
    wasRefreshedBearerAccepted() {
      return acceptedRefreshedBearer;
    },
    wasStaleBearerRejected() {
      return rejectedStaleBearer;
    },
  };
}

afterEach(async () => {
  const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
  __resetServerAuthBootstrapForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.skipIf(!hasLiveSupabaseEnv)(
  "logs in and restores a hosted Supabase browser session with a fresh confirmed user",
  async () => {
    const realFetch = globalThis.fetch;
    const email = makeLiveEmail();
    const password = `T3-web-live-password-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userId: string | undefined;

    try {
      userId = await createConfirmedSupabaseUser({ email, password });
      installTestBrowser();
      const fetchHarness = installHybridFetch(realFetch);
      vi.stubEnv("VITE_HTTP_URL", "https://app.example.test");
      vi.stubEnv("VITE_WS_URL", "wss://app.example.test");

      const {
        readSupabaseBrowserAccessToken,
        readSupabaseBrowserRefreshToken,
        resolveInitialServerAuthGateState,
        submitSupabasePasswordAuth,
      } = await import("./environments/primary");

      await expect(
        submitSupabasePasswordAuth({
          config: {
            projectUrl: liveProjectUrl!,
            anonKey: liveAnonKey!,
          },
          email,
          password,
          mode: "login",
        }),
      ).resolves.toMatchObject({
        authenticated: true,
        tenantStatus: "active",
      });

      const initialAccessToken = readSupabaseBrowserAccessToken();
      expect(initialAccessToken).toEqual(expect.stringMatching(/^ey/));
      expect(readSupabaseBrowserRefreshToken()).toEqual(expect.any(String));
      await expect(resolveInitialServerAuthGateState()).resolves.toMatchObject({
        status: "authenticated",
        tenantStatus: "active",
      });
      expect(fetchHarness.fetchMock).toHaveBeenCalledWith(
        "https://app.example.test/api/auth/session",
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: expect.stringMatching(/^Bearer ey/),
          }),
        }),
      );

      if (!initialAccessToken) {
        throw new Error("Expected Supabase login to persist a browser access token.");
      }

      fetchHarness.markStaleAccessToken(initialAccessToken);
      vi.resetModules();
      const {
        readSupabaseBrowserAccessToken: readRestoredAccessToken,
        resolveInitialServerAuthGateState: resolveRestoredAuthGateState,
      } = await import("./environments/primary");

      await expect(resolveRestoredAuthGateState()).resolves.toMatchObject({
        status: "authenticated",
        tenantStatus: "active",
      });
      expect(fetchHarness.wasStaleBearerRejected()).toBe(true);
      expect(fetchHarness.wasRefreshedBearerAccepted()).toBe(true);
      expect(readRestoredAccessToken()).toEqual(expect.stringMatching(/^ey/));
      expect(readRestoredAccessToken()).not.toBe(initialAccessToken);
    } finally {
      if (userId) {
        await deleteSupabaseUser(userId);
      }
    }
  },
);

it.skipIf(!hasLiveSupabaseEnv)(
  "restores a real hosted Supabase signup confirmation redirect without manual token paste",
  async () => {
    const realFetch = globalThis.fetch;
    const email = makeLiveEmail();
    const password = `T3-web-confirm-password-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let userId: string | undefined;

    try {
      const generated = await generateSupabaseSignupActionLink({
        email,
        password,
        redirectTo: "https://app.example.test/auth/callback",
      });
      userId = generated.userId;
      const redirectUrl = await followSupabaseActionLinkForRedirect({
        actionLink: generated.actionLink,
        fetchImpl: realFetch,
      });

      const testWindow = installTestBrowser();
      testWindow.location = new URL(redirectUrl);
      installHybridFetch(realFetch);
      vi.stubEnv("VITE_HTTP_URL", "https://app.example.test");
      vi.stubEnv("VITE_WS_URL", "wss://app.example.test");

      const {
        readSupabaseBrowserAccessToken,
        readSupabaseBrowserRefreshToken,
        resolveInitialServerAuthGateState,
      } = await import("./environments/primary");

      await expect(resolveInitialServerAuthGateState()).resolves.toMatchObject({
        status: "authenticated",
        tenantStatus: "active",
      });
      expect(readSupabaseBrowserAccessToken()).toEqual(expect.stringMatching(/^ey/));
      expect(readSupabaseBrowserRefreshToken()).toEqual(expect.any(String));
      expect(testWindow.location.hash).toBe("");
      expect(testWindow.location.searchParams.get("access_token")).toBeNull();
    } finally {
      if (userId) {
        await deleteSupabaseUser(userId);
      }
    }
  },
);
