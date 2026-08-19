import type { DesktopBridge } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

type TestWindow = {
  location: URL;
  history: {
    replaceState: (_data: unknown, _unused: string, url: string) => void;
  };
  desktopBridge?: DesktopBridge;
};

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

function installTestBrowser(url: string) {
  const testWindow: TestWindow = {
    location: new URL(url),
    history: {
      replaceState: (_data, _unused, nextUrl) => {
        testWindow.location = new URL(nextUrl, testWindow.location.href);
      },
    },
  };

  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("document", { title: "LogicPacks" });
  vi.stubGlobal("localStorage", createTestStorage());

  return testWindow;
}

function sessionResponse(body: unknown, init?: ResponseInit) {
  return jsonResponse(body, init);
}

describe("resolveInitialServerAuthGateState", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    installTestBrowser("http://localhost/");
  });

  afterEach(async () => {
    const { __resetServerAuthBootstrapForTests } = await import("./environments/primary");
    __resetServerAuthBootstrapForTests();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reuses an in-flight silent bootstrap attempt", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await Promise.all([resolveInitialServerAuthGateState(), resolveInitialServerAuthGateState()]);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://localhost:3773/api/auth/session");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://localhost:3773/api/auth/bootstrap");
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");
  });

  it("uses https fetch urls when the primary environment uses wss", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("uses the current origin as an auth proxy base for local dev environments", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost:5735/");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://localhost:5735/api/auth/session", {
      credentials: "include",
    });
  });

  it("reads sanitized public Supabase auth config from the session descriptor", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
            audience: "authenticated",
            serviceRoleSecretName: "server-only-secret-name",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { fetchSupabasePublicAuthConfig } = await import("./environments/primary");

    const config = await fetchSupabasePublicAuthConfig();

    expect(config).toEqual({
      projectUrl: "https://project-ref.supabase.co",
      anonKey: "public-anon-key",
      audience: "authenticated",
    });
    expect(JSON.stringify(config)).not.toContain("server-only-secret-name");
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("returns null when the session descriptor has no Supabase auth config", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchSupabasePublicAuthConfig } = await import("./environments/primary");

    await expect(fetchSupabasePublicAuthConfig()).resolves.toBeNull();
  });

  it("loads Supabase bearer session state for a browser access token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        expiresAt: "2026-04-05T00:00:00.000Z",
        tenantStatus: "pending-membership",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { fetchSupabaseBearerSessionState } = await import("./environments/primary");

    await expect(fetchSupabaseBearerSessionState(" supabase-access-token ")).resolves.toMatchObject(
      {
        authenticated: true,
        sessionMethod: "bearer-session-token",
        tenantStatus: "pending-membership",
      },
    );
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-access-token",
      },
    });
  });

  it("loads Supabase bearer profile and WebSocket token for browser session restore", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          userId: "supabase:fresh-browser-user",
          subject: "fresh-browser-user",
          displayName: "Fresh Browser User",
          avatarInitials: "FB",
          role: "client",
          sessionId: "supabase:fresh-browser-user",
          sessionMethod: "bearer-session-token",
          client: {
            deviceType: "unknown",
          },
          tenantStatus: "active",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          token: "primary-ws-token",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { fetchSupabaseBearerUserProfile, issueSupabaseBearerWebSocketToken } =
      await import("./environments/primary");

    await expect(fetchSupabaseBearerUserProfile("supabase-access-token")).resolves.toMatchObject({
      userId: "supabase:fresh-browser-user",
      tenantStatus: "active",
    });
    await expect(issueSupabaseBearerWebSocketToken("supabase-access-token")).resolves.toEqual({
      token: "primary-ws-token",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://remote.example.com/api/auth/profile", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-access-token",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://remote.example.com/api/auth/ws-token", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-access-token",
      },
      method: "POST",
    });
  });

  it("uses a stored Supabase browser token for current profile and onboarding requests", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          userId: "supabase:stored-browser-user",
          subject: "stored-browser-user",
          displayName: "Stored Browser User",
          avatarInitials: "SB",
          role: "client",
          sessionId: "supabase:stored-browser-user",
          sessionMethod: "bearer-session-token",
          client: {
            deviceType: "unknown",
          },
          tenantStatus: "pending-membership",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          profile: {
            userId: "supabase:stored-browser-user",
            subject: "stored-browser-user",
            displayName: "Stored Browser User",
            avatarInitials: "SB",
            role: "client",
            sessionId: "supabase:stored-browser-user",
            sessionMethod: "bearer-session-token",
            client: {
              deviceType: "unknown",
            },
            tenantStatus: "pending-membership",
          },
          nextStep: "accept-invite",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { fetchOnboardingState, fetchUserProfile, writeSupabaseBrowserAccessToken } =
      await import("./environments/primary");

    writeSupabaseBrowserAccessToken("stored-supabase-access-token");

    await expect(fetchUserProfile()).resolves.toMatchObject({
      userId: "supabase:stored-browser-user",
      tenantStatus: "pending-membership",
    });
    await expect(fetchOnboardingState()).resolves.toMatchObject({
      nextStep: "accept-invite",
      profile: {
        userId: "supabase:stored-browser-user",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://remote.example.com/api/auth/profile", {
      credentials: "include",
      headers: {
        authorization: "Bearer stored-supabase-access-token",
      },
    });
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://remote.example.com/api/auth/onboarding", {
      credentials: "include",
      headers: {
        authorization: "Bearer stored-supabase-access-token",
      },
    });
  });

  it("surfaces first-time create-workspace onboarding for authenticated users without tenancy", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        authenticated: true,
        profile: {
          userId: "supabase:first-time-user",
          subject: "first-time-user",
          displayName: "First Time User",
          avatarInitials: "FT",
          role: "client",
          sessionId: "supabase:first-time-user",
          sessionMethod: "bearer-session-token",
          client: {
            deviceType: "unknown",
          },
          tenantStatus: "none",
        },
        nextStep: "create-workspace",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");

    const { fetchOnboardingState, writeSupabaseBrowserAccessToken } =
      await import("./environments/primary");

    writeSupabaseBrowserAccessToken("first-time-supabase-access-token");

    await expect(fetchOnboardingState()).resolves.toMatchObject({
      nextStep: "create-workspace",
      profile: {
        userId: "supabase:first-time-user",
        tenantStatus: "none",
      },
    });
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/onboarding", {
      credentials: "include",
      headers: {
        authorization: "Bearer first-time-supabase-access-token",
      },
    });
  });

  it("clears stored Supabase browser tokens on browser session sign-out", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      resolveInitialServerAuthGateState,
      signOutSupabaseBrowserSession,
      subscribeSupabaseBrowserSessionChanges,
      writeSupabaseBrowserAccessToken,
    } = await import("./environments/primary");

    writeSupabaseBrowserAccessToken("stored-supabase-access-token");
    const sessionChanges: Array<unknown> = [];
    const unsubscribe = subscribeSupabaseBrowserSessionChanges((change) => {
      sessionChanges.push(change);
    });
    signOutSupabaseBrowserSession();

    expect(readSupabaseBrowserAccessToken()).toBeNull();
    expect(sessionChanges).toEqual([{ reason: "removed", tokenPresent: false }]);
    unsubscribe();
    await expect(resolveInitialServerAuthGateState()).resolves.toMatchObject({
      status: "requires-auth",
    });
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("rejects empty Supabase browser access tokens before calling auth endpoints", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const {
      fetchSupabaseBearerSessionState,
      fetchSupabaseBearerUserProfile,
      issueSupabaseBearerWebSocketToken,
    } = await import("./environments/primary");

    await expect(fetchSupabaseBearerSessionState(" ")).rejects.toThrow(
      "Supabase access token is required.",
    );
    await expect(fetchSupabaseBearerUserProfile(" ")).rejects.toThrow(
      "Supabase access token is required.",
    );
    await expect(issueSupabaseBearerWebSocketToken(" ")).rejects.toThrow(
      "Supabase access token is required.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("persists accepted Supabase browser access tokens for returning sessions", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        tenantStatus: "active",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      submitSupabaseBrowserAccessToken,
      subscribeSupabaseBrowserSessionChanges,
    } = await import("./environments/primary");
    const sessionChanges: Array<unknown> = [];
    const unsubscribe = subscribeSupabaseBrowserSessionChanges((change) => {
      sessionChanges.push(change);
    });

    await expect(
      submitSupabaseBrowserAccessToken(" supabase-access-token "),
    ).resolves.toMatchObject({
      authenticated: true,
      tenantStatus: "active",
    });
    expect(readSupabaseBrowserAccessToken()).toBe("supabase-access-token");
    expect(sessionChanges).toEqual([{ reason: "changed", tokenPresent: true }]);
    unsubscribe();
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-access-token",
      },
    });
  });

  it("signs in through Supabase password auth and stores refreshable browser tokens", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "supabase-login-access-token",
          refresh_token: "supabase-login-refresh-token",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
          role: "client",
          sessionMethod: "bearer-session-token",
          tenantStatus: "active",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      readSupabaseBrowserRefreshToken,
      submitSupabasePasswordAuth,
    } = await import("./environments/primary");

    await expect(
      submitSupabasePasswordAuth({
        config: {
          projectUrl: "https://project-ref.supabase.co",
          anonKey: "public-anon-key",
        },
        email: "fresh-supabase@example.test",
        password: "password-1",
        mode: "login",
      }),
    ).resolves.toMatchObject({ authenticated: true, tenantStatus: "active" });
    expect(readSupabaseBrowserAccessToken()).toBe("supabase-login-access-token");
    expect(readSupabaseBrowserRefreshToken()).toBe("supabase-login-refresh-token");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://project-ref.supabase.co/auth/v1/token?grant_type=password",
      {
        body: JSON.stringify({
          email: "fresh-supabase@example.test",
          password: "password-1",
        }),
        headers: {
          apikey: "public-anon-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2, "https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-login-access-token",
      },
    });
  });

  it("signs up through Supabase password auth before accepting the T3 bearer session", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "supabase-signup-access-token",
          refresh_token: "supabase-signup-refresh-token",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
          role: "client",
          sessionMethod: "bearer-session-token",
          tenantStatus: "pending-membership",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { submitSupabasePasswordAuth } = await import("./environments/primary");

    await expect(
      submitSupabasePasswordAuth({
        config: {
          projectUrl: "https://project-ref.supabase.co/",
          anonKey: "public-anon-key",
        },
        email: "new-supabase@example.test",
        password: "password-1",
        mode: "signup",
      }),
    ).resolves.toMatchObject({ authenticated: true, tenantStatus: "pending-membership" });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://project-ref.supabase.co/auth/v1/signup",
      expect.objectContaining({
        body: JSON.stringify({
          email: "new-supabase@example.test",
          password: "password-1",
        }),
      }),
    );
  });

  it("reports email confirmation when Supabase signup returns no browser session", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        user: {
          id: "new-supabase-user",
          confirmation_sent_at: "2026-05-09T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { readSupabaseBrowserAccessToken, submitSupabasePasswordAuth } =
      await import("./environments/primary");

    await expect(
      submitSupabasePasswordAuth({
        config: {
          projectUrl: "https://project-ref.supabase.co",
          anonKey: "public-anon-key",
        },
        email: "new-supabase@example.test",
        password: "password-1",
        mode: "signup",
      }),
    ).rejects.toThrow("Check your email to finish signing up, then log in.");
    expect(readSupabaseBrowserAccessToken()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("restores a Supabase confirmation redirect token pair before showing the auth gate", async () => {
    const testWindow = installTestBrowser(
      "https://app.example.test/auth/callback?next=%2Finvite#access_token=confirmed-access-token&refresh_token=confirmed-refresh-token&type=signup&workspace=preserved",
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        tenantStatus: "pending-membership",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      readSupabaseBrowserRefreshToken,
      resolveInitialServerAuthGateState,
      subscribeSupabaseBrowserSessionChanges,
    } = await import("./environments/primary");

    const sessionChanges: Array<unknown> = [];
    const unsubscribe = subscribeSupabaseBrowserSessionChanges((change) => {
      sessionChanges.push(change);
    });

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
      tenantStatus: "pending-membership",
    });
    expect(readSupabaseBrowserAccessToken()).toBe("confirmed-access-token");
    expect(readSupabaseBrowserRefreshToken()).toBe("confirmed-refresh-token");
    expect(sessionChanges).toEqual([
      { reason: "changed", tokenPresent: true },
      { reason: "restored", tokenPresent: true },
    ]);
    unsubscribe();
    expect(testWindow.location.search).toBe("?next=%2Finvite");
    expect(testWindow.location.hash).toBe("#workspace=preserved");
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer confirmed-access-token",
      },
    });
  });

  it("keeps the auth gate visible and strips failed Supabase confirmation redirects", async () => {
    const testWindow = installTestBrowser(
      "https://app.example.test/auth/callback?next=%2Finvite#error=access_denied&error_description=Email+link+is+invalid&type=signup",
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { readSupabaseBrowserAccessToken, resolveInitialServerAuthGateState } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "t3_session",
        supabase: {
          projectUrl: "https://project-ref.supabase.co",
          anonKey: "public-anon-key",
        },
      },
      errorMessage: "Email link is invalid",
    });
    expect(readSupabaseBrowserAccessToken()).toBeNull();
    expect(testWindow.location.search).toBe("?next=%2Finvite");
    expect(testWindow.location.hash).toBe("");
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/session", {
      credentials: "include",
    });
  });

  it("reports malformed Supabase confirmation redirects without retaining token params", async () => {
    const testWindow = installTestBrowser(
      "https://app.example.test/auth/callback#type=signup&refresh_token=orphan-refresh-token",
    );
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toMatchObject({
      status: "requires-auth",
      errorMessage: "Supabase confirmation link did not include an access token.",
    });
    expect(testWindow.location.hash).toBe("");
  });

  it("restores a returning Supabase browser session before showing the auth gate", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: true,
        auth: {
          policy: "remote-reachable",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-session-token"],
          sessionCookieName: "t3_session",
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        },
        role: "client",
        sessionMethod: "bearer-session-token",
        tenantStatus: "active",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      resolveInitialServerAuthGateState,
      subscribeSupabaseBrowserSessionChanges,
      writeSupabaseBrowserAccessToken,
    } = await import("./environments/primary");

    writeSupabaseBrowserAccessToken("returning-supabase-token");
    const sessionChanges: Array<unknown> = [];
    const unsubscribe = subscribeSupabaseBrowserSessionChanges((change) => {
      sessionChanges.push(change);
    });

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
      tenantStatus: "active",
    });
    expect(sessionChanges).toEqual([{ reason: "restored", tokenPresent: true }]);
    unsubscribe();
    expect(fetchMock).toHaveBeenNthCalledWith(1, "https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer returning-supabase-token",
      },
    });
  });

  it("refreshes a stale returning Supabase browser session before showing the auth gate", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "refreshed-supabase-access-token",
          refresh_token: "refreshed-supabase-refresh-token",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
          role: "client",
          sessionMethod: "bearer-session-token",
          tenantStatus: "active",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      readSupabaseBrowserRefreshToken,
      resolveInitialServerAuthGateState,
      writeSupabaseBrowserAccessToken,
    } = await import("./environments/primary");

    writeSupabaseBrowserAccessToken("stale-supabase-access-token");
    localStorage.setItem("t3code.supabase.refreshToken", "stored-supabase-refresh-token");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
      tenantStatus: "active",
    });
    expect(readSupabaseBrowserAccessToken()).toBe("refreshed-supabase-access-token");
    expect(readSupabaseBrowserRefreshToken()).toBe("refreshed-supabase-refresh-token");
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://project-ref.supabase.co/auth/v1/token?grant_type=refresh_token",
      {
        body: JSON.stringify({
          refresh_token: "stored-supabase-refresh-token",
        }),
        headers: {
          apikey: "public-anon-key",
          "content-type": "application/json",
        },
        method: "POST",
      },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(4, "https://remote.example.com/api/auth/session", {
      credentials: "include",
      headers: {
        authorization: "Bearer refreshed-supabase-access-token",
      },
    });
  });

  it("clears stale Supabase browser tokens and keeps the auth gate visible", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
            supabase: {
              projectUrl: "https://project-ref.supabase.co",
              anonKey: "public-anon-key",
            },
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const {
      readSupabaseBrowserAccessToken,
      resolveInitialServerAuthGateState,
      writeSupabaseBrowserAccessToken,
    } = await import("./environments/primary");

    writeSupabaseBrowserAccessToken("stale-supabase-token");

    await expect(resolveInitialServerAuthGateState()).resolves.toMatchObject({
      status: "requires-auth",
    });
    expect(readSupabaseBrowserAccessToken()).toBeNull();
  });

  it("issues primary WebSocket tokens from a stored Supabase browser access token", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        token: "primary-ws-token",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_HTTP_URL", "https://remote.example.com");
    vi.stubEnv("VITE_WS_URL", "wss://remote.example.com");

    const { resolveSupabasePrimaryWebSocketConnectionUrl, writeSupabaseBrowserAccessToken } =
      await import("./environments/primary");

    writeSupabaseBrowserAccessToken("supabase-access-token");

    await expect(
      resolveSupabasePrimaryWebSocketConnectionUrl("wss://remote.example.com/ws"),
    ).resolves.toBe("wss://remote.example.com/ws?wsToken=primary-ws-token");
    expect(fetchMock).toHaveBeenCalledWith("https://remote.example.com/api/auth/ws-token", {
      credentials: "include",
      headers: {
        authorization: "Bearer supabase-access-token",
      },
      method: "POST",
    });
  });

  it("uses the vite proxy for desktop-managed loopback auth requests during local dev", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("VITE_DEV_SERVER_URL", "http://127.0.0.1:5733");

    const testWindow = installTestBrowser("http://127.0.0.1:5733/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://127.0.0.1:3773",
        wsBaseUrl: "ws://127.0.0.1:3773",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "desktop-managed-local",
        bootstrapMethods: ["desktop-bootstrap"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:5733/api/auth/session", {
      credentials: "include",
    });
  });

  it("returns a requires-auth state instead of throwing when no bootstrap credential exists", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
  });

  it("retries transient auth session bootstrap failures after restart", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response("Bad Gateway", { status: 502 }))
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(gateStatePromise).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("takes a pairing token from the location hash and strips it immediately", async () => {
    const testWindow = installTestBrowser("http://localhost/#token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("accepts query-string pairing tokens as a backward-compatible fallback", async () => {
    const testWindow = installTestBrowser("http://localhost/?token=pairing-token");
    const { takePairingTokenFromUrl } = await import("./environments/primary");

    expect(takePairingTokenFromUrl()).toBe("pairing-token");
    expect(testWindow.location.searchParams.get("token")).toBeNull();
  });

  it("signs a deep link in where it landed, so the project survives the sign-in", async () => {
    const testWindow = installTestBrowser(
      "http://localhost/project/environment-local/project-1#token=ABC123XYZ789",
    );
    const unauthenticated = {
      authenticated: false,
      auth: {
        policy: "desktop-managed-local",
        bootstrapMethods: ["desktop-bootstrap"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sessionResponse(unauthenticated))
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          role: "owner",
          sessionMethod: "browser-session-cookie",
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          ...unauthenticated,
          authenticated: true,
          tenantStatus: "active",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
      tenantStatus: "active",
    });
    // The credential is spent, so it must not survive in the address bar for a
    // reload or a bookmark to fail on later.
    expect(testWindow.location.hash).toBe("");
    expect(testWindow.location.pathname).toBe("/project/environment-local/project-1");
    expect(fetchMock.mock.calls[1]?.[0]).toContain("/api/auth/bootstrap");
    expect(String(fetchMock.mock.calls[1]?.[1]?.body)).toContain("ABC123XYZ789");
  });

  it("leaves the pairing screen's own token alone, so that page still owns it", async () => {
    const testWindow = installTestBrowser("http://localhost/pair#token=ABC123XYZ789");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      sessionResponse({
        authenticated: false,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "t3_session",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");
    const gateState = await resolveInitialServerAuthGateState();

    expect(gateState.status).toBe("requires-auth");
    expect(testWindow.location.hash).toBe("#token=ABC123XYZ789");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports a deep-link credential the server refused instead of pretending to sign in", async () => {
    installTestBrowser("http://localhost/project/environment-local/project-1#token=EXPIRED12345");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ error: "Bootstrap credential expired." }, { status: 401 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");
    const gateState = await resolveInitialServerAuthGateState();

    expect(gateState).toMatchObject({
      status: "requires-auth",
      errorMessage: "Bootstrap credential expired.",
    });
  });

  it("allows manual token submission after the initial auth check requires pairing", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    installTestBrowser("http://localhost/");

    const { resolveInitialServerAuthGateState, submitServerAuthCredential } =
      await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "requires-auth",
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie"],
        sessionCookieName: "t3_session",
      },
    });
    await expect(submitServerAuthCredential("retry-token")).resolves.toBeUndefined();
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("waits for the authenticated session to become observable after silent desktop bootstrap", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          authenticated: true,
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "desktop-managed-local",
            bootstrapMethods: ["desktop-bootstrap"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const testWindow = installTestBrowser("http://localhost/");
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => ({
        label: "Local environment",
        httpBaseUrl: "http://localhost:3773",
        wsBaseUrl: "ws://localhost:3773",
        bootstrapToken: "desktop-bootstrap-token",
      }),
    } as DesktopBridge;

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    const gateStatePromise = resolveInitialServerAuthGateState();
    await vi.advanceTimersByTimeAsync(100);

    await expect(gateStatePromise).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[2]?.[0]).toBe("http://localhost:3773/api/auth/session");
    expect(fetchMock.mock.calls[3]?.[0]).toBe("http://localhost:3773/api/auth/session");
  });

  it("memoizes the authenticated gate state after the first successful read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: true,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
          sessionMethod: "browser-session-cookie",
          expiresAt: "2026-04-05T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        sessionResponse({
          authenticated: false,
          auth: {
            policy: "loopback-browser",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const { resolveInitialServerAuthGateState } = await import("./environments/primary");

    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    await expect(resolveInitialServerAuthGateState()).resolves.toEqual({
      status: "authenticated",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creates a pairing credential from the authenticated auth endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      jsonResponse({
        id: "pairing-link-1",
        credential: "pairing-token",
        label: "Julius iPhone",
        expiresAt: "2026-04-05T00:00:00.000Z",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { createServerPairingCredential } = await import("./environments/primary");

    await expect(createServerPairingCredential("Julius iPhone")).resolves.toEqual({
      id: "pairing-link-1",
      credential: "pairing-token",
      label: "Julius iPhone",
      expiresAt: "2026-04-05T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith("http://localhost/api/auth/pairing-token", {
      body: JSON.stringify({ label: "Julius iPhone" }),
      credentials: "include",
      headers: {
        "content-type": "application/json",
      },
      method: "POST",
    });
  });
});
