import { describe, expect, it } from "vitest";

import { shouldShowProviderStatus } from "./providerStatusBanner.logic";

describe("shouldShowProviderStatus", () => {
  // The production bug: the registry probes the server's own global provider
  // home, which belongs to no user. It went unauthenticated after a debugging
  // pass wiped /root/.codex, and every person with a perfectly good account of
  // their own got a red "provider is unavailable" that no successful turn and
  // no hard reload would clear.
  it("hides a global failure from somebody who has their own account", () => {
    expect(
      shouldShowProviderStatus({
        status: "error",
        viewerConnectedAccounts: 1,
        noAccountForMe: false,
      }),
    ).toBe(false);
  });

  it("still shows a global failure to somebody with nothing connected", () => {
    // For them the global home really is what a turn falls back to.
    expect(
      shouldShowProviderStatus({
        status: "error",
        viewerConnectedAccounts: 0,
        noAccountForMe: false,
      }),
    ).toBe(true);
  });

  it("shows it while the per-account list is still loading", () => {
    expect(
      shouldShowProviderStatus({
        status: "error",
        viewerConnectedAccounts: null,
        noAccountForMe: false,
      }),
    ).toBe(true);
  });

  it("always tells somebody a turn of theirs would be refused", () => {
    expect(
      shouldShowProviderStatus({
        status: "ready",
        viewerConnectedAccounts: 0,
        noAccountForMe: true,
      }),
    ).toBe(true);
  });

  it("says nothing when the provider is healthy or switched off", () => {
    expect(
      shouldShowProviderStatus({
        status: "ready",
        viewerConnectedAccounts: 1,
        noAccountForMe: false,
      }),
    ).toBe(false);
    expect(
      shouldShowProviderStatus({
        status: "disabled",
        viewerConnectedAccounts: 0,
        noAccountForMe: true,
      }),
    ).toBe(false);
  });
});
