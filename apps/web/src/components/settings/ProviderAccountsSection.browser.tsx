import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ProviderAccountsSection } from "./ProviderAccountsSection";
import type { ProviderName } from "./providerAccounts.logic";

// The panel talks to the server over plain fetch, so the whole of its behaviour
// is which request it sends and what it does with the answer.
vi.mock("../../environments/primary/target", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string) => `https://server.test${pathname}`,
}));
vi.mock("../../environments/primary/auth", () => ({
  readSupabaseBrowserAccessToken: () => null,
}));

const NOW = "2026-08-16T10:00:00.000Z";

type Call = { readonly path: string; readonly body: Record<string, unknown> | null };

function account(
  provider: ProviderName,
  accountId: string,
  patch: { label?: string; isDefault?: boolean; connected?: boolean } = {},
) {
  return {
    accountId,
    provider,
    label: patch.label ?? accountId,
    createdAt: NOW,
    isDefault: patch.isDefault ?? false,
    connected: patch.connected ?? true,
  };
}

function connection(
  provider: ProviderName,
  accounts: ReadonlyArray<ReturnType<typeof account>>,
  defaultAccountId: string | null = null,
) {
  return {
    provider,
    label: provider === "claude" ? "Claude" : "Codex",
    connected: accounts.some((entry) => entry.connected),
    defaultAccountId,
    accounts,
  };
}

/** Answers every provider-auth call from one handler, and records the asks. */
function installFetch(handler: (call: Call) => unknown): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: unknown, init?: { body?: unknown }) => {
    const path = new URL(String(input)).pathname.replace("/api/provider-auth/", "");
    const call: Call = {
      path,
      body: init?.body === undefined ? null : JSON.parse(String(init.body)),
    };
    calls.push(call);
    return new Response(JSON.stringify(handler(call) ?? {}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

function lastCall(calls: readonly Call[], path: string): Call | undefined {
  return calls.findLast((call) => call.path === path);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ProviderAccountsSection", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("says which account this person's own turns run on", async () => {
    installFetch(() => ({
      connections: [
        connection(
          "claude",
          [
            account("claude", "work", { label: "Work" }),
            account("claude", "personal", { label: "Personal", isDefault: true }),
          ],
          "personal",
        ),
      ],
    }));
    const screen = await render(<ProviderAccountsSection />);
    try {
      await expect
        .element(page.getByText("Your Claude turns run as Personal."))
        .toBeInTheDocument();
      // Both accounts listed, and the badge on the one that answers a turn.
      expect(document.querySelectorAll('[data-testid="provider-account-row"]')).toHaveLength(2);
      expect(document.querySelector('[data-account="work"]')?.textContent).toContain("Work");
      expect(document.querySelector('[data-account="personal"]')?.textContent).toContain(
        "Your turns",
      );
    } finally {
      await screen.unmount();
    }
  });

  it("connects an extra account under the name the person typed", async () => {
    const calls = installFetch((call) =>
      call.path === "start"
        ? {
            provider: "claude",
            label: "Claude",
            accountId: "acc-2",
            accountLabel: "Side project",
            url: "https://claude.ai/device",
            wantsCode: true,
          }
        : {
            connections: [
              connection("claude", [account("claude", "acc-1", { isDefault: true })], "acc-1"),
            ],
          },
    );
    const screen = await render(<ProviderAccountsSection />);
    try {
      await page
        .getByRole("textbox", { name: "Name for the next Claude account" })
        .fill("Side project");
      await page.getByRole("button", { name: "Connect another Claude account" }).click();

      await expect.element(page.getByText("Finish signing in to Side project")).toBeInTheDocument();
      expect(lastCall(calls, "start")?.body).toEqual({
        provider: "claude",
        newAccount: true,
        label: "Side project",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("leaves the first sign-in exactly as it was", async () => {
    const calls = installFetch((call) =>
      call.path === "start"
        ? {
            provider: "codex",
            label: "Codex",
            accountId: "default",
            url: "https://auth.openai.com/device",
            code: "U8X6-IJJIR",
            wantsCode: false,
          }
        : { connections: [connection("codex", [])] },
    );
    const screen = await render(<ProviderAccountsSection />);
    try {
      await page.getByRole("button", { name: "Open Codex sign-in" }).click();

      await expect.element(page.getByText("U8X6-IJJIR")).toBeInTheDocument();
      // No account id and no `newAccount`: the request the server has always had.
      expect(lastCall(calls, "start")?.body).toEqual({ provider: "codex" });
    } finally {
      await screen.unmount();
    }
  });

  it("waits for the account being connected, not for the provider", async () => {
    let secondConnected = false;
    installFetch((call) =>
      call.path === "start"
        ? {
            provider: "codex",
            label: "Codex",
            accountId: "acc-2",
            accountLabel: "Codex account 2",
            url: "https://auth.openai.com/device",
            wantsCode: false,
          }
        : {
            connections: [
              connection(
                "codex",
                [
                  account("codex", "acc-1", { label: "Work", isDefault: true }),
                  account("codex", "acc-2", {
                    label: "Codex account 2",
                    connected: secondConnected,
                  }),
                ],
                "acc-1",
              ),
            ],
          },
    );
    const screen = await render(<ProviderAccountsSection />);
    try {
      await page.getByRole("button", { name: "Connect another Codex account" }).click();
      await expect.element(page.getByText(/Waiting for you to finish/)).toBeInTheDocument();

      // Two polls into a sign-in that has not happened. The provider has read as
      // connected throughout — the first account never stopped working — so a
      // watch on the provider would already have declared this one signed in.
      await sleep(7_000);
      expect(page.getByText(/Waiting for you to finish/).query()).not.toBeNull();
      expect(page.getByText(/Codex account 2 connected\./).query()).toBeNull();

      secondConnected = true;
      await expect
        .element(page.getByText("Codex account 2 connected."), { timeout: 15_000 })
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("moves this person's turns onto the account they pick", async () => {
    const calls = installFetch(() => ({
      connections: [
        connection(
          "claude",
          [
            account("claude", "work", { label: "Work" }),
            account("claude", "personal", { label: "Personal", isDefault: true }),
          ],
          "personal",
        ),
      ],
    }));
    const screen = await render(<ProviderAccountsSection />);
    try {
      // Only the account that is not already the default offers it.
      await page.getByRole("button", { name: "Use for my turns" }).click();

      expect(lastCall(calls, "account")?.body).toEqual({
        provider: "claude",
        accountId: "work",
        makeDefault: true,
      });
    } finally {
      await screen.unmount();
    }
  });

  it("disconnects and tests one named account", async () => {
    const calls = installFetch((call) =>
      call.path === "prompt"
        ? { provider: "claude", accountId: "work", prompt: "Reply with exactly: OK", output: "OK" }
        : {
            connections: [
              connection("claude", [account("claude", "work", { label: "Work" })], "work"),
            ],
          },
    );
    const screen = await render(<ProviderAccountsSection />);
    try {
      await page.getByRole("button", { name: "Test" }).click();
      await expect
        .element(page.getByTestId("provider-account-test-output"))
        .toHaveTextContent("OK");
      expect(lastCall(calls, "prompt")?.body).toMatchObject({
        provider: "claude",
        accountId: "work",
      });

      await page.getByRole("button", { name: "Disconnect" }).click();
      expect(lastCall(calls, "logout")?.body).toEqual({ provider: "claude", accountId: "work" });
    } finally {
      await screen.unmount();
    }
  });

  it("renames an account from the name it already has", async () => {
    const calls = installFetch(() => ({
      connections: [
        connection(
          "claude",
          [account("claude", "work", { label: "Work", isDefault: true })],
          "work",
        ),
      ],
    }));
    const screen = await render(<ProviderAccountsSection />);
    try {
      await page.getByRole("button", { name: "Rename Work" }).click();
      const field = page.getByRole("textbox", { name: "Name for Work" });
      await expect.element(field).toHaveValue("Work");
      await field.fill("Work (billing)");
      await page.getByRole("button", { name: "Save the name" }).click();

      expect(lastCall(calls, "account")?.body).toEqual({
        provider: "claude",
        accountId: "work",
        label: "Work (billing)",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("points at the collaboration panel rather than growing sharing controls", async () => {
    installFetch(() => ({ connections: [connection("claude", [])] }));
    const screen = await render(<ProviderAccountsSection />);
    try {
      await expect
        .element(page.getByText(/collaboration panel in that workspace/))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
