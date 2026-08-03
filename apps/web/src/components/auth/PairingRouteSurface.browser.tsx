import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { PairingRouteSurface } from "./PairingRouteSurface";

const primaryAuthHarness = vi.hoisted(() => ({
  peekPairingTokenFromUrl: vi.fn(() => null as string | null),
  stripPairingTokenFromUrl: vi.fn(),
  submitServerAuthCredential: vi.fn(async (_credential: string) => undefined),
  submitLocalPasswordAuth: vi.fn(async (_input: unknown) => ({
    authenticated: true,
    auth: {
      policy: "loopback-browser",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    role: "client",
    sessionMethod: "browser-session-cookie",
    tenantStatus: "active",
  })),
  submitSupabasePasswordAuth: vi.fn(async (_input: unknown) => ({
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
    },
    role: "client",
    sessionMethod: "bearer-session-token",
    tenantStatus: "active",
  })),
  reset() {
    this.peekPairingTokenFromUrl.mockReturnValue(null);
    this.stripPairingTokenFromUrl.mockClear();
    this.submitServerAuthCredential.mockReset();
    this.submitServerAuthCredential.mockResolvedValue(undefined);
    this.submitLocalPasswordAuth.mockReset();
    this.submitLocalPasswordAuth.mockResolvedValue({
      authenticated: true,
      auth: {
        policy: "loopback-browser",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "t3_session",
      },
      role: "client",
      sessionMethod: "browser-session-cookie",
      tenantStatus: "active",
    });
    this.submitSupabasePasswordAuth.mockReset();
    this.submitSupabasePasswordAuth.mockResolvedValue({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: ["one-time-token"],
        sessionMethods: ["browser-session-cookie", "bearer-session-token"],
        sessionCookieName: "t3_session",
      },
      role: "client",
      sessionMethod: "bearer-session-token",
      tenantStatus: "active",
    });
  },
}));

vi.mock("../../environments/primary", () => ({
  peekPairingTokenFromUrl: primaryAuthHarness.peekPairingTokenFromUrl,
  stripPairingTokenFromUrl: primaryAuthHarness.stripPairingTokenFromUrl,
  submitLocalPasswordAuth: primaryAuthHarness.submitLocalPasswordAuth,
  submitServerAuthCredential: primaryAuthHarness.submitServerAuthCredential,
  submitSupabasePasswordAuth: primaryAuthHarness.submitSupabasePasswordAuth,
}));

async function clearBrowserState() {
  localStorage.clear();
  sessionStorage.clear();
  if ("caches" in window) {
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)));
  }
  document.cookie.split(";").forEach((cookie) => {
    const name = cookie.split("=")[0]?.trim();
    if (name) {
      document.cookie = `${name}=; Max-Age=0; path=/`;
    }
  });

  if ("indexedDB" in window && typeof indexedDB.databases === "function") {
    const databases = await indexedDB.databases();
    await Promise.all(
      databases
        .map((database) => database.name)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .map(
          (name) =>
            new Promise<void>((resolve) => {
              const request = indexedDB.deleteDatabase(name);
              request.addEventListener("success", () => resolve());
              request.addEventListener("error", () => resolve());
              request.addEventListener("blocked", () => resolve());
            }),
        ),
    );
  }
}

const baseAuth = {
  policy: "remote-reachable" as const,
  bootstrapMethods: ["one-time-token" as const],
  sessionMethods: ["browser-session-cookie" as const, "bearer-session-token" as const],
  sessionCookieName: "t3_session",
};

describe("PairingRouteSurface browser auth flows", () => {
  beforeEach(async () => {
    await clearBrowserState();
    document.body.innerHTML = "";
    window.history.replaceState({}, "", "/");
    primaryAuthHarness.reset();
  });

  afterEach(() => {
    document.body.innerHTML = "";
    primaryAuthHarness.reset();
  });

  it("signs in a unique fresh Supabase browser user from clean state", async () => {
    const onAuthenticated = vi.fn();
    const email = `fresh-supabase-${Date.now()}@example.test`;
    const password = `Fresh-password-${Date.now()}`;

    const screen = await render(
      <PairingRouteSurface
        auth={{
          ...baseAuth,
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
            audience: "authenticated",
          },
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    try {
      await page.getByLabelText("Email").fill(email);
      await page.getByLabelText("Password").fill(password);
      await page.getByRole("button", { name: "Login" }).click();

      await vi.waitFor(() => {
        expect(primaryAuthHarness.submitSupabasePasswordAuth).toHaveBeenCalledWith({
          config: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
            audience: "authenticated",
          },
          email,
          password,
          mode: "login",
        });
        expect(onAuthenticated).toHaveBeenCalledTimes(1);
      });
      expect(localStorage.length).toBe(0);
    } finally {
      await screen.unmount();
    }
  });

  it("creates a unique fresh Supabase browser user from clean state", async () => {
    const onAuthenticated = vi.fn();
    const email = `new-supabase-${Date.now()}@example.test`;
    const password = `Fresh-password-${Date.now()}`;

    const screen = await render(
      <PairingRouteSurface
        auth={{
          ...baseAuth,
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    try {
      await page.getByRole("button", { name: "Sign up" }).click();
      await page.getByLabelText("Email").fill(email);
      await page.getByLabelText("Password").fill(password);
      await page.getByRole("button", { name: "Create account" }).click();

      await vi.waitFor(() => {
        expect(primaryAuthHarness.submitSupabasePasswordAuth).toHaveBeenCalledWith({
          config: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
          email,
          password,
          mode: "signup",
        });
        expect(onAuthenticated).toHaveBeenCalledTimes(1);
      });
    } finally {
      await screen.unmount();
    }
  });

  it("creates a local password account when local auth is advertised", async () => {
    const onAuthenticated = vi.fn();
    const email = `new-local-${Date.now()}@example.test`;
    const password = `Local-password-${Date.now()}`;

    const screen = await render(
      <PairingRouteSurface
        auth={{
          ...baseAuth,
          localPassword: { enabled: true },
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    try {
      await page.getByRole("button", { name: "Sign up" }).click();
      await page.getByLabelText("Email").fill(email);
      await page.getByLabelText("Password").fill(password);
      await page.getByRole("button", { name: "Create account" }).click();

      await vi.waitFor(() => {
        expect(primaryAuthHarness.submitLocalPasswordAuth).toHaveBeenCalledWith({
          email,
          password,
          mode: "signup",
        });
        expect(onAuthenticated).toHaveBeenCalledTimes(1);
      });
      expect(primaryAuthHarness.submitSupabasePasswordAuth).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("keeps returning users on the auth surface when Supabase login fails", async () => {
    primaryAuthHarness.submitSupabasePasswordAuth.mockRejectedValueOnce(
      new Error("Supabase session was not accepted."),
    );
    const onAuthenticated = vi.fn();
    const email = `returning-supabase-${Date.now()}@example.test`;

    const screen = await render(
      <PairingRouteSurface
        auth={{
          ...baseAuth,
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    try {
      await page.getByLabelText("Email").fill(email);
      await page.getByLabelText("Password").fill("stale-password");
      await page.getByRole("button", { name: "Login" }).click();

      await expect
        .element(page.getByText("Supabase session was not accepted."))
        .toBeInTheDocument();
      expect(primaryAuthHarness.submitSupabasePasswordAuth).toHaveBeenCalledWith(
        expect.objectContaining({ email, mode: "login" }),
      );
      expect(onAuthenticated).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not auto-consume invite setup tokens when Supabase auth is available", async () => {
    window.history.replaceState({}, "", "/invite?inviteId=invite-1#token=setup-token");
    primaryAuthHarness.peekPairingTokenFromUrl.mockReturnValue("setup-token");
    const onAuthenticated = vi.fn();

    const screen = await render(
      <PairingRouteSurface
        auth={{
          ...baseAuth,
          supabase: {
            projectUrl: "https://project-ref.supabase.co",
            anonKey: "public-anon-key",
          },
        }}
        onAuthenticated={onAuthenticated}
      />,
    );

    try {
      await expect.element(page.getByRole("button", { name: "Login" })).toBeInTheDocument();
      await vi.waitFor(() => {
        expect(primaryAuthHarness.stripPairingTokenFromUrl).toHaveBeenCalledTimes(1);
      });
      expect(primaryAuthHarness.submitServerAuthCredential).not.toHaveBeenCalled();
      expect(onAuthenticated).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("does not show Supabase token controls when the server does not advertise Supabase auth", async () => {
    const screen = await render(<PairingRouteSurface auth={baseAuth} onAuthenticated={vi.fn()} />);

    try {
      await expect.element(page.getByRole("button", { name: "Login" })).not.toBeInTheDocument();
      expect(primaryAuthHarness.submitSupabasePasswordAuth).not.toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });
});
