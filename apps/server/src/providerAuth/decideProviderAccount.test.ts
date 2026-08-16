import { describe, expect, it } from "vitest";

import {
  decideProviderAccount,
  type DecideProviderAccountInput,
  type ProviderAccountDecision,
} from "./decideProviderAccount.ts";

const OWNER = "auth:lena";

const input = (
  overrides: Partial<DecideProviderAccountInput> = {},
): DecideProviderAccountInput => ({
  provider: "claude",
  providerLabel: "Claude",
  ownAccounts: [],
  grant: null,
  policy: null,
  sharedAccounts: [],
  ...overrides,
});

const ownAccount = (accountId: string, isDefault = true) => ({ accountId, isDefault });

const sharedAccount = (overrides: Partial<{ enabled: boolean; connected: boolean }> = {}) => ({
  ownerUserId: OWNER,
  accountId: "acc-owner",
  enabled: true,
  connected: true,
  ...overrides,
});

const workspacePolicy = (overrides: Partial<{ sharedAccountId: string | null }> = {}) =>
  ({
    mode: "shared",
    sharedOwnerUserId: OWNER,
    sharedAccountId: "acc-owner",
    ...overrides,
  }) as const;

function expectAccount(decision: ProviderAccountDecision) {
  if (decision.outcome !== "account") {
    throw new Error(`expected an account, got a refusal: ${decision.refusal}`);
  }
  return decision;
}

function expectRefusal(decision: ProviderAccountDecision) {
  if (decision.outcome !== "refused") {
    throw new Error(`expected a refusal, got ${decision.source} account ${decision.accountId}`);
  }
  return decision;
}

describe("decideProviderAccount", () => {
  it("runs a person on their own account when nobody has decided anything", () => {
    const decision = expectAccount(
      decideProviderAccount(input({ ownAccounts: [ownAccount("acc-mine")] })),
    );
    expect(decision).toMatchObject({ accountId: "acc-mine", ownerUserId: null, source: "own" });
  });

  it("refuses a person with no account, and says both ways out", () => {
    const decision = expectRefusal(decideProviderAccount(input()));
    expect(decision.refusal).toContain("Settings → Connections");
    expect(decision.refusal).toContain("admin");
  });

  it("lends the workspace account to a member granted workspace access", () => {
    const decision = expectAccount(
      decideProviderAccount(
        input({
          grant: { access: "workspace" },
          policy: workspacePolicy(),
          sharedAccounts: [sharedAccount()],
        }),
      ),
    );
    expect(decision).toMatchObject({
      accountId: "acc-owner",
      ownerUserId: OWNER,
      source: "workspace",
    });
  });

  it("treats a shared workspace policy as the default for members with no grant", () => {
    const decision = expectAccount(
      decideProviderAccount(
        input({ policy: workspacePolicy(), sharedAccounts: [sharedAccount()] }),
      ),
    );
    expect(decision.source).toBe("workspace");
  });

  it("lets a grant of own override a workspace that shares", () => {
    const decision = expectAccount(
      decideProviderAccount(
        input({
          grant: { access: "own" },
          policy: workspacePolicy(),
          ownAccounts: [ownAccount("acc-mine")],
          sharedAccounts: [sharedAccount()],
        }),
      ),
    );
    expect(decision).toMatchObject({ accountId: "acc-mine", source: "own" });
  });

  // The one guarantee somebody lending their subscription is relying on.
  it("stops lending the moment the owner switches sharing off", () => {
    const decision = expectRefusal(
      decideProviderAccount(
        input({
          grant: { access: "workspace" },
          policy: workspacePolicy(),
          sharedAccounts: [sharedAccount({ enabled: false })],
        }),
      ),
    );
    expect(decision.refusal).toContain("no longer shared");
  });

  it("does not lend an account whose credential has been disconnected", () => {
    const decision = expectRefusal(
      decideProviderAccount(
        input({
          grant: { access: "workspace" },
          policy: workspacePolicy(),
          sharedAccounts: [sharedAccount({ connected: false })],
        }),
      ),
    );
    expect(decision.refusal).toContain("no longer shared");
  });

  it("falls back to a member's own account when the workspace one has gone", () => {
    const decision = expectAccount(
      decideProviderAccount(
        input({
          grant: { access: "workspace" },
          policy: workspacePolicy(),
          ownAccounts: [ownAccount("acc-mine")],
          sharedAccounts: [sharedAccount({ enabled: false })],
        }),
      ),
    );
    expect(decision).toMatchObject({ accountId: "acc-mine", source: "own" });
  });

  // Billing a colleague nobody named is worse than refusing.
  it("never substitutes a different shared account for the one the admin named", () => {
    const decision = expectRefusal(
      decideProviderAccount(
        input({
          grant: { access: "workspace" },
          policy: workspacePolicy(),
          sharedAccounts: [
            sharedAccount({ enabled: false }),
            {
              ownerUserId: "auth:someone-else",
              accountId: "acc-other",
              enabled: true,
              connected: true,
            },
          ],
        }),
      ),
    );
    expect(decision.refusal).toContain("no longer shared");
  });

  it("says so plainly when a workspace shares but no account was ever chosen", () => {
    const decision = expectRefusal(
      decideProviderAccount(
        input({
          policy: { mode: "shared", sharedOwnerUserId: null, sharedAccountId: null },
          sharedAccounts: [sharedAccount()],
        }),
      ),
    );
    expect(decision.refusal).toContain("no account has been chosen");
  });

  it("points a member without access at the admin when the workspace does have one to lend", () => {
    const decision = expectRefusal(
      decideProviderAccount(input({ sharedAccounts: [sharedAccount()] })),
    );
    expect(decision.refusal).toContain("let you use the workspace account");
  });

  it("prefers the default account when a person has several", () => {
    const decision = expectAccount(
      decideProviderAccount(
        input({ ownAccounts: [ownAccount("acc-first", false), ownAccount("acc-default")] }),
      ),
    );
    expect(decision.accountId).toBe("acc-default");
  });

  // Bookkeeping should not lock anybody out of a credential that works.
  it("uses the only account there is when no default is marked", () => {
    const decision = expectAccount(
      decideProviderAccount(input({ ownAccounts: [ownAccount("acc-orphan", false)] })),
    );
    expect(decision.accountId).toBe("acc-orphan");
  });

  it("names the provider the way a person would", () => {
    const decision = expectRefusal(
      decideProviderAccount(input({ provider: "codex", providerLabel: "Codex" })),
    );
    expect(decision.refusal).toContain("No Codex account is connected");
  });
});
