import { describe, expect, it } from "vitest";

import {
  accountConnected,
  defaultAccountOf,
  formatConnectedAt,
  parseConnections,
  suggestedAccountName,
  type Connection,
  type ProviderAccount,
} from "./providerAccounts.logic";

const NOW = "2026-08-16T10:00:00.000Z";

function account(patch: Partial<ProviderAccount> & { accountId: string }): ProviderAccount {
  return {
    provider: "claude",
    label: patch.accountId,
    createdAt: NOW,
    isDefault: false,
    connected: true,
    ...patch,
  };
}

function connection(patch: Partial<Connection>): Connection {
  return {
    provider: "claude",
    label: "Claude",
    connected: true,
    defaultAccountId: null,
    accounts: [],
    ...patch,
  };
}

describe("parseConnections", () => {
  it("reads accounts, the default and the provider flag", () => {
    const parsed = parseConnections({
      connections: [
        {
          provider: "claude",
          label: "Claude",
          connected: true,
          defaultAccountId: "work",
          accounts: [
            {
              accountId: "work",
              provider: "claude",
              label: "Work",
              createdAt: NOW,
              isDefault: true,
              connected: true,
            },
            {
              accountId: "personal",
              provider: "claude",
              label: "Personal",
              createdAt: NOW,
              isDefault: false,
              connected: false,
            },
          ],
        },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.defaultAccountId).toBe("work");
    expect(parsed[0]?.accounts.map((entry) => entry.accountId)).toEqual(["work", "personal"]);
    expect(parsed[0]?.accounts[1]?.connected).toBe(false);
  });

  it("keeps a connected provider visible when the server sends no accounts", () => {
    const parsed = parseConnections({
      connections: [{ provider: "codex", label: "Codex", connected: true }],
    });

    expect(parsed[0]?.accounts).toEqual([
      {
        accountId: "default",
        provider: "codex",
        label: "Codex",
        createdAt: "",
        isDefault: true,
        connected: true,
      },
    ]);
  });

  it("invents nothing for a provider that is not connected", () => {
    const parsed = parseConnections({
      connections: [{ provider: "codex", label: "Codex", connected: false }],
    });

    expect(parsed[0]?.accounts).toEqual([]);
  });

  it("drops entries it cannot make sense of", () => {
    const parsed = parseConnections({
      connections: [
        { provider: "gemini", connected: true },
        null,
        { provider: "claude", connected: false, accounts: [{ label: "no id" }, 7] },
      ],
    });

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.provider).toBe("claude");
    expect(parsed[0]?.accounts).toEqual([]);
  });

  it("falls back to the account id when the label is missing", () => {
    const parsed = parseConnections({
      connections: [
        { provider: "claude", connected: true, accounts: [{ accountId: "abc", connected: true }] },
      ],
    });

    expect(parsed[0]?.label).toBe("Claude");
    expect(parsed[0]?.accounts[0]?.label).toBe("abc");
  });

  it("returns nothing for a body that is not a connections list", () => {
    expect(parseConnections({ error: "sign in first" })).toEqual([]);
    expect(parseConnections(null)).toEqual([]);
  });
});

describe("accountConnected", () => {
  const connections = [
    connection({
      accounts: [
        account({ accountId: "first" }),
        account({ accountId: "second", connected: false }),
      ],
    }),
  ];

  it("is false for an account still being signed in to, even when the provider is connected", () => {
    expect(connections[0]?.connected).toBe(true);
    expect(accountConnected(connections, "claude", "second")).toBe(false);
  });

  it("is true once that account has a credential", () => {
    expect(accountConnected(connections, "claude", "first")).toBe(true);
  });

  it("is false for accounts and providers it has never heard of", () => {
    expect(accountConnected(connections, "claude", "third")).toBe(false);
    expect(accountConnected(connections, "codex", "first")).toBe(false);
  });
});

describe("defaultAccountOf", () => {
  it("names the nominated account", () => {
    const view = connection({
      defaultAccountId: "second",
      accounts: [
        account({ accountId: "first" }),
        account({ accountId: "second", isDefault: true }),
      ],
    });

    expect(defaultAccountOf(view)?.accountId).toBe("second");
  });

  it("moves to one that works when the nominated account is disconnected", () => {
    const view = connection({
      defaultAccountId: "first",
      accounts: [
        account({ accountId: "first", connected: false, isDefault: true }),
        account({ accountId: "second" }),
      ],
    });

    expect(defaultAccountOf(view)?.accountId).toBe("second");
  });

  it("is nothing when no account can run a turn", () => {
    const view = connection({
      connected: false,
      accounts: [account({ accountId: "first", connected: false })],
    });

    expect(defaultAccountOf(view)).toBeNull();
  });
});

describe("suggestedAccountName", () => {
  it("counts from the accounts already there, connected or not", () => {
    expect(suggestedAccountName(connection({ accounts: [] }))).toBe("Claude account 1");
    expect(
      suggestedAccountName(
        connection({
          accounts: [account({ accountId: "a" }), account({ accountId: "b", connected: false })],
        }),
      ),
    ).toBe("Claude account 3");
  });
});

describe("formatConnectedAt", () => {
  it("says nothing for a date the store could not read", () => {
    expect(formatConnectedAt(new Date(0).toISOString())).toBeNull();
    expect(formatConnectedAt("")).toBeNull();
    expect(formatConnectedAt("whenever")).toBeNull();
  });

  it("formats a real one", () => {
    expect(formatConnectedAt(NOW)).not.toBeNull();
  });
});
