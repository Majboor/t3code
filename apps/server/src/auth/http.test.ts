import { describe, expect, it } from "vitest";

import { decideAutoIssuedOwnerSession, detectForwardingProxyHeader } from "./http.ts";

describe("detectForwardingProxyHeader", () => {
  it("sees nothing to report on a request a browser sent straight to the port", () => {
    expect(
      detectForwardingProxyHeader({
        host: "127.0.0.1:3773",
        "user-agent": "Mozilla/5.0",
        accept: "*/*",
      }),
    ).toBeNull();
  });

  it("names the header a Cloudflare tunnel adds", () => {
    expect(
      detectForwardingProxyHeader({
        host: "polite-otter.trycloudflare.com",
        "cf-connecting-ip": "203.0.113.7",
        "x-forwarded-proto": "https",
      }),
    ).toBe("x-forwarded-proto");
  });

  it("catches each forwarding header on its own", () => {
    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
      "x-original-forwarded-for",
      "cf-connecting-ip",
      "cf-ray",
      "cf-visitor",
    ]) {
      expect(detectForwardingProxyHeader({ [header]: "value" })).toBe(header);
    }
  });

  it("ignores a header that is present but empty", () => {
    expect(detectForwardingProxyHeader({ "x-forwarded-for": "   " })).toBeNull();
  });
});

describe("decideAutoIssuedOwnerSession", () => {
  const localRequest = {
    configuredPolicy: "loopback-browser",
    publishedBeyondLoopback: false,
    basicAuthEnabled: false,
    forwardedByHeader: null,
  } as const;

  it("still signs in the local browser, which is how every desktop and CLI user gets in", () => {
    expect(decideAutoIssuedOwnerSession(localRequest)).toEqual({ issue: true });
  });

  it("still signs in a local browser against an --unsafe-no-auth server", () => {
    expect(
      decideAutoIssuedOwnerSession({ ...localRequest, configuredPolicy: "unsafe-no-auth" }),
    ).toEqual({ issue: true });
  });

  it("refuses once the server knows it is published, and says why", () => {
    const decision = decideAutoIssuedOwnerSession({
      ...localRequest,
      publishedBeyondLoopback: true,
    });

    expect(decision.issue).toBe(false);
    expect(decision.issue === false && decision.refusal?.code).toBe("server-published");
    expect(decision.issue === false && decision.refusal?.message).toMatch(/one-time token/i);
  });

  it("refuses a published --unsafe-no-auth server too", () => {
    const decision = decideAutoIssuedOwnerSession({
      ...localRequest,
      configuredPolicy: "unsafe-no-auth",
      publishedBeyondLoopback: true,
    });

    expect(decision.issue).toBe(false);
  });

  it("refuses a request that a proxy relayed, naming the header that gave it away", () => {
    const decision = decideAutoIssuedOwnerSession({
      ...localRequest,
      forwardedByHeader: "cf-connecting-ip",
    });

    expect(decision.issue).toBe(false);
    expect(decision.issue === false && decision.refusal?.code).toBe("request-forwarded");
    expect(decision.issue === false && decision.refusal?.message).toContain("cf-connecting-ip");
  });

  it("keeps issuing behind basic auth, where the caller proved the password rather than the address", () => {
    expect(
      decideAutoIssuedOwnerSession({
        ...localRequest,
        configuredPolicy: "unsafe-no-auth",
        basicAuthEnabled: true,
        publishedBeyondLoopback: true,
        forwardedByHeader: "x-forwarded-for",
      }),
    ).toEqual({ issue: true });
  });

  it("stays silent for policies that never auto-issued, so ordinary pairing is not reported as a refusal", () => {
    for (const configuredPolicy of ["desktop-managed-local", "remote-reachable"] as const) {
      expect(
        decideAutoIssuedOwnerSession({
          ...localRequest,
          configuredPolicy,
          forwardedByHeader: "x-forwarded-for",
        }),
      ).toEqual({ issue: false, refusal: null });
    }
  });
});
