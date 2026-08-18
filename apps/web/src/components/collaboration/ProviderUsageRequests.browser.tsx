import "../../index.css";

import {
  EnvironmentId,
  ProviderAccountId,
  ProviderUsageRequestId,
  TenantId,
  UserId,
  WorkspaceId,
  type EnvironmentApi,
  type ProviderConnectedAccount,
  type ProviderUsageRequest,
} from "@t3tools/contracts";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from "@tanstack/react-router";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
  __resetEnvironmentApiOverridesForTests,
  __setEnvironmentApiOverrideForTests,
} from "../../environmentApi";
import { ProviderUsageRequests } from "./ProviderUsageRequests";

const ENVIRONMENT_ID = EnvironmentId.make("environment-usage-browser");
const TENANT_ID = TenantId.make("tenant-usage-browser");
const WORKSPACE_ID = WorkspaceId.make("workspace-usage-browser");
const VIEWER = UserId.make("user-usage-viewer");
const OTHER = UserId.make("user-usage-other");
const NOW = "2026-08-16T10:00:00.000Z";

function claudeAccount(accountId: string, isDefault: boolean): ProviderConnectedAccount {
  return {
    accountId: ProviderAccountId.make(accountId),
    provider: "claude",
    label: `Claude ${accountId}`,
    createdAt: NOW,
    isDefault,
  };
}

function request(
  patch: Omit<Partial<ProviderUsageRequest>, "id"> & { id: string },
): ProviderUsageRequest {
  return {
    tenantId: TENANT_ID,
    workspaceId: WORKSPACE_ID,
    requesterUserId: OTHER,
    requesterDisplayName: "Bo",
    provider: "claude",
    reason: "no-account",
    note: null,
    status: "pending",
    createdAt: NOW,
    respondedAt: null,
    respondedByUserId: null,
    ...patch,
    id: ProviderUsageRequestId.make(patch.id),
  };
}

function stubApi(input: {
  requests: readonly ProviderUsageRequest[];
  canRespond: boolean;
}): EnvironmentApi & {
  providerUsage: {
    createRequest: ReturnType<typeof vi.fn>;
    respondToRequest: ReturnType<typeof vi.fn>;
    withdrawRequest: ReturnType<typeof vi.fn>;
  };
} {
  const api = {
    providerUsage: {
      createRequest: vi.fn(async () => ({ request: request({ id: "req-created" }) })),
      listRequests: vi.fn(async () => ({
        requests: input.requests,
        canRespond: input.canRespond,
      })),
      respondToRequest: vi.fn(async () => ({ request: request({ id: "req-answered" }) })),
      withdrawRequest: vi.fn(async () => ({ request: request({ id: "req-withdrawn" }) })),
    },
  };
  __setEnvironmentApiOverrideForTests(ENVIRONMENT_ID, api as unknown as EnvironmentApi);
  return api as never;
}

async function renderSection(input: { viewerAccounts?: readonly ProviderConnectedAccount[] }) {
  const rootRoute = createRootRoute({
    component: () => (
      <ProviderUsageRequests
        environmentId={ENVIRONMENT_ID}
        tenantId={TENANT_ID}
        workspaceId={WORKSPACE_ID}
        workspaceLabel="Payments Team"
        viewerUserId={VIEWER}
        viewerAccounts={input.viewerAccounts ?? []}
        workspaceAccounts={[]}
      />
    ),
  });
  return render(
    <RouterProvider
      router={createRouter({
        routeTree: rootRoute,
        history: createMemoryHistory({ initialEntries: ["/"] }),
      })}
    />,
  );
}

describe("ProviderUsageRequests", () => {
  afterEach(() => {
    __resetEnvironmentApiOverridesForTests();
    document.body.innerHTML = "";
  });

  it("offers an ask, with an optional note, to somebody who cannot run turns", async () => {
    const api = stubApi({ requests: [], canRespond: false });
    const screen = await renderSection({});
    try {
      await page.getByRole("button", { name: "Ask the workspace for Claude usage" }).click();
      await page.getByLabelText("Note for your Claude request").fill("just for the migration");
      await page.getByRole("button", { name: "Send request" }).click();

      await expect.poll(() => api.providerUsage.createRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.createRequest.mock.calls[0]?.[0]).toEqual({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        provider: "claude",
        reason: "no-account",
        note: "just for the migration",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("sends a null note rather than dropping the field when it is left empty", async () => {
    const api = stubApi({ requests: [], canRespond: false });
    const screen = await renderSection({});
    try {
      await page.getByRole("button", { name: "Ask the workspace for Claude usage" }).click();
      await page.getByRole("button", { name: "Send request" }).click();

      await expect.poll(() => api.providerUsage.createRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.createRequest.mock.calls[0]?.[0]).toMatchObject({ note: null });
    } finally {
      await screen.unmount();
    }
  });

  it("offers a withdrawal instead of a second ask once one is open", async () => {
    const api = stubApi({
      requests: [request({ id: "req-mine", requesterUserId: VIEWER, requesterDisplayName: "Ana" })],
      canRespond: false,
    });
    const screen = await renderSection({});
    try {
      await expect.element(page.getByText("Waiting on Claude")).toBeInTheDocument();
      expect(
        document.querySelectorAll('[data-testid="provider-usage-ask"][data-provider="claude"]'),
      ).toHaveLength(0);

      await page.getByRole("button", { name: "Withdraw" }).click();
      await expect.poll(() => api.providerUsage.withdrawRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.withdrawRequest.mock.calls[0]?.[0]).toEqual({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        requestId: "req-mine",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("says what a grant costs before the click, and grants the chosen account", async () => {
    const api = stubApi({ requests: [request({ id: "req-bo" })], canRespond: true });
    const screen = await renderSection({
      viewerAccounts: [claudeAccount("work", false), claudeAccount("personal", true)],
    });
    try {
      await expect
        .element(page.getByText(/Their turns spend your subscription/))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Claude work" }).click();
      await page.getByRole("button", { name: "Grant" }).click();

      await expect.poll(() => api.providerUsage.respondToRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.respondToRequest.mock.calls[0]?.[0]).toEqual({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        requestId: "req-bo",
        decision: "grant",
        accountId: "work",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("declines without naming an account", async () => {
    const api = stubApi({ requests: [request({ id: "req-bo" })], canRespond: true });
    const screen = await renderSection({ viewerAccounts: [claudeAccount("personal", true)] });
    try {
      await page.getByRole("button", { name: "Decline" }).click();
      await expect.poll(() => api.providerUsage.respondToRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.respondToRequest.mock.calls[0]?.[0]).toEqual({
        tenantId: TENANT_ID,
        workspaceId: WORKSPACE_ID,
        requestId: "req-bo",
        decision: "decline",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("tells a contributor nobody has asked, and tells nobody else anything", async () => {
    stubApi({ requests: [], canRespond: true });
    const contributor = await renderSection({ viewerAccounts: [claudeAccount("personal", true)] });
    try {
      await expect.element(page.getByText(/Nobody has asked/)).toBeInTheDocument();
    } finally {
      await contributor.unmount();
    }

    __resetEnvironmentApiOverridesForTests();
    stubApi({ requests: [], canRespond: false });
    const member = await renderSection({ viewerAccounts: [claudeAccount("personal", true)] });
    try {
      await expect.element(page.getByTestId("provider-usage-requests")).toBeInTheDocument();
      expect(document.querySelectorAll('[data-testid="provider-usage-inbox"]')).toHaveLength(0);
    } finally {
      await member.unmount();
    }
  });

  it("keeps the ask out of the way of somebody who can already run turns", async () => {
    stubApi({ requests: [], canRespond: false });
    const screen = await renderSection({
      viewerAccounts: [claudeAccount("personal", true)],
    });
    try {
      expect(
        document.querySelectorAll('[data-testid="provider-usage-ask"][data-provider="claude"]'),
      ).toHaveLength(0);
      await page.getByRole("button", { name: "Ask for a workspace account anyway" }).click();
      await expect.element(page.getByText("Use the workspace's Claude")).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("lets somebody with an account say they have hit their limit", async () => {
    const api = stubApi({ requests: [], canRespond: false });
    const screen = await renderSection({ viewerAccounts: [claudeAccount("personal", true)] });
    try {
      await page.getByRole("button", { name: "Ask for a workspace account anyway" }).click();
      await page.getByRole("button", { name: "Ask for Claude anyway" }).click();
      await page.getByRole("button", { name: "I've hit my limit" }).click();
      await page.getByRole("button", { name: "Send request" }).click();

      await expect.poll(() => api.providerUsage.createRequest.mock.calls.length).toBe(1);
      expect(api.providerUsage.createRequest.mock.calls[0]?.[0]).toMatchObject({
        reason: "limit-reached",
      });
    } finally {
      await screen.unmount();
    }
  });

  it("points a granted requester at the fact that their turns run now", async () => {
    stubApi({
      requests: [
        request({
          id: "req-mine",
          requesterUserId: VIEWER,
          requesterDisplayName: "Ana",
          status: "granted",
          respondedAt: NOW,
          respondedByUserId: OTHER,
        }),
      ],
      canRespond: false,
    });
    const screen = await renderSection({});
    try {
      await expect.element(page.getByText("Claude granted")).toBeInTheDocument();
      await expect
        .element(page.getByText(/send a prompt and it will go through/))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("lets a declined requester ask again", async () => {
    stubApi({
      requests: [
        request({
          id: "req-mine",
          requesterUserId: VIEWER,
          requesterDisplayName: "Ana",
          status: "declined",
          respondedAt: NOW,
          respondedByUserId: OTHER,
        }),
      ],
      canRespond: false,
    });
    const screen = await renderSection({});
    try {
      await expect.element(page.getByText("Claude request declined")).toBeInTheDocument();
      await expect.element(page.getByRole("button", { name: "Ask again" })).toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("tells somebody who asked and then connected their own account that they are unblocked", async () => {
    stubApi({
      requests: [
        request({
          id: "req-mine",
          requesterUserId: VIEWER,
          requesterDisplayName: "Ana",
          reason: "no-account",
        }),
      ],
      canRespond: false,
    });
    const screen = await renderSection({ viewerAccounts: [claudeAccount("personal", true)] });
    try {
      await expect
        .element(page.getByText(/You have connected your own Claude since asking/))
        .toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
