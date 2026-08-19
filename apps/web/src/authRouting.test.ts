import { describe, expect, it } from "vitest";

import { resolveAuthGateRedirect, resolvePrivateRouteRedirect } from "./authRouting";

describe("resolveAuthGateRedirect", () => {
  it("sends first-time authenticated Supabase users without membership to invite onboarding", () => {
    expect(
      resolveAuthGateRedirect({
        authGateState: { status: "authenticated", tenantStatus: "pending-membership" },
        pathname: "/",
      }),
    ).toBe("/invite");
  });

  it("keeps pending-membership users on the invite route so invite acceptance can run", () => {
    expect(
      resolveAuthGateRedirect({
        authGateState: { status: "authenticated", tenantStatus: "pending-membership" },
        pathname: "/invite",
      }),
    ).toBeNull();
  });

  it("leaves a share recipient on the join page, which is where membership comes from", () => {
    // Somebody who has just created an account to open a share link has no
    // membership yet — acquiring one is what the page they are on does.
    // Bouncing them to `/invite` would drop the share token and strand them on
    // "invite link is missing".
    expect(
      resolveAuthGateRedirect({
        authGateState: { status: "authenticated", tenantStatus: "pending-membership" },
        pathname: "/share",
      }),
    ).toBeNull();
  });

  it("does not redirect active members or unauthenticated visitors", () => {
    expect(
      resolveAuthGateRedirect({
        authGateState: { status: "authenticated", tenantStatus: "active" },
        pathname: "/",
      }),
    ).toBeNull();
    expect(
      resolveAuthGateRedirect({
        authGateState: {
          status: "requires-auth",
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
          },
        },
        pathname: "/",
      }),
    ).toBeNull();
  });
});

describe("resolvePrivateRouteRedirect", () => {
  it("redirects unauthenticated private route access to the auth entry point", () => {
    expect(
      resolvePrivateRouteRedirect({
        authGateState: {
          status: "requires-auth",
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie", "bearer-session-token"],
            sessionCookieName: "t3_session",
          },
        },
      }),
    ).toBe("/pair");
  });

  it("keeps authenticated private route access in the app shell", () => {
    expect(
      resolvePrivateRouteRedirect({
        authGateState: { status: "authenticated", tenantStatus: "active" },
      }),
    ).toBeNull();
  });

  it("uses the caller-provided auth entry path for alternate surfaces", () => {
    expect(
      resolvePrivateRouteRedirect({
        authGateState: {
          status: "requires-auth",
          auth: {
            policy: "remote-reachable",
            bootstrapMethods: ["one-time-token"],
            sessionMethods: ["browser-session-cookie"],
            sessionCookieName: "t3_session",
          },
        },
        authEntryPath: "/custom-login",
      }),
    ).toBe("/custom-login");
  });
});
