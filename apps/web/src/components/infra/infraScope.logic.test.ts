import { describe, expect, it } from "vitest";

import { resolveInfraScope } from "./infraScope.logic";

const workspace = (id: string, tenantId: string) => ({ id, tenantId }) as never;

const ownership = (tenantId: string, workspaceId: string) => ({ tenantId, workspaceId }) as never;

describe("resolveInfraScope", () => {
  it("takes the workspace that owns the project, not the first one listed", () => {
    const scope = resolveInfraScope({
      ownership: ownership("tenant-2", "workspace-2"),
      workspaces: [workspace("workspace-1", "tenant-1"), workspace("workspace-2", "tenant-2")],
    });

    expect(scope).toEqual({ tenantId: "tenant-2", workspaceId: "workspace-2" });
  });

  it("trusts ownership even when the session lists no workspace of its own", () => {
    const scope = resolveInfraScope({
      ownership: ownership("tenant-2", "workspace-2"),
      workspaces: [],
    });

    expect(scope).toEqual({ tenantId: "tenant-2", workspaceId: "workspace-2" });
  });

  it("guesses the first workspace when the project carries no ownership", () => {
    const scope = resolveInfraScope({
      ownership: undefined,
      workspaces: [workspace("workspace-1", "tenant-1"), workspace("workspace-2", "tenant-2")],
    });

    expect(scope).toEqual({ tenantId: "tenant-1", workspaceId: "workspace-1" });
  });

  it("has no scope when there is neither ownership nor a workspace to guess from", () => {
    expect(resolveInfraScope({ ownership: null, workspaces: [] })).toBeNull();
  });
});
