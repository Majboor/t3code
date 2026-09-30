import { describe, expect, it } from "vitest";

import { mayUseOperatorProviderCredentials } from "./operatorCredentialLending.ts";

const at = (host: string | undefined, localAccountCount: number, published?: boolean) =>
  mayUseOperatorProviderCredentials({
    host,
    publishedBeyondLoopback: published,
    localAccountCount,
  });

describe("lending the operator's provider credential", () => {
  // The case the whole mechanism exists for.
  it("allows it on a desktop with one account", () => {
    expect(at("127.0.0.1", 1)).toBe(true);
    expect(at("localhost", 1)).toBe(true);
    expect(at(undefined, 1)).toBe(true);
  });

  // `t3 serve --host 0.0.0.0` is the documented way to reach your own machine
  // from your own phone. A wildcard bind is not evidence of a crowd, and the
  // first attempt at this guard broke pairing by assuming it was.
  it("allows LAN pairing for a single user", () => {
    expect(at("0.0.0.0", 1)).toBe(true);
  });

  // The leak: a stranger's prompt billed to, and answered by, the operator's
  // subscription.
  it("refuses once a second account can sign in", () => {
    expect(at("127.0.0.1", 2)).toBe(false);
    expect(at("0.0.0.0", 5)).toBe(false);
  });

  // The defaulting mistake that made the first guard inert: an opt-in env var
  // that is false by default, on a server bound to loopback behind a proxy.
  it("refuses when the operator declared the server published", () => {
    expect(at("127.0.0.1", 1, true)).toBe(false);
  });

  // An unreadable count arrives as Infinity, and must not be read as "one".
  it("refuses when the account count could not be read", () => {
    expect(at("127.0.0.1", Number.POSITIVE_INFINITY)).toBe(false);
  });
});
