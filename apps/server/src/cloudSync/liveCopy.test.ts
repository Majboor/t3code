import {
  CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS,
  ProjectId,
  TenantId,
  WorkspaceId,
  type ProjectCloudSync,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { CloudSyncHandoffRegistry, classifyVisit } from "./liveCopy.ts";

const now = new Date("2026-08-19T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
const tunnelUrl = "https://tiny-fox-42.trycloudflare.com";

const sync: ProjectCloudSync = {
  projectId: ProjectId.make("project-atlas"),
  tenantId: TenantId.make("tenant-atlas"),
  workspaceId: WorkspaceId.make("workspace-platform"),
  mode: "mirror",
  status: "transferring",
  lastAgreedAt: null,
  lastError: null,
  filesTotal: 400,
  filesDone: 120,
  bytesTotal: 900_000,
  bytesDone: 240_000,
  activelyChanging: true,
  conflictCount: 0,
  createdAt: "2026-08-19T11:58:00.000Z",
  updatedAt: "2026-08-19T11:59:30.000Z",
};

describe("what a visitor to the cloud URL is told", () => {
  it("offers the live copy while the first pass is still running", () => {
    const view = classifyVisit({
      sync,
      liveCopyUrl: tunnelUrl,
      laptopConfirmedAt: ago(5_000),
      now,
    });

    expect(view.state).toBe("first-pass-live");
    expect(view.liveCopy?.url).toBe(tunnelUrl);
    // Progress travels with it, because the offer is "go through, or watch".
    expect(view.sync?.filesDone).toBe(120);
    // And a turn is still refused. An agent let loose on a half-uploaded tree
    // reads a truncated file and confidently "fixes" working code.
    expect(view.turnsAllowed).toBe(false);
  });

  it("says there is no live copy without pretending the laptop is gone", () => {
    // cloudflared missing, or the auth gate refusing to publish this server.
    // The sync is running, the heartbeat proves it, and there is simply nothing
    // to click.
    const view = classifyVisit({ sync, liveCopyUrl: null, laptopConfirmedAt: ago(5_000), now });

    expect(view.state).toBe("first-pass");
    expect(view.liveCopy).toBeNull();
    expect(view.sync?.status).toBe("transferring");
  });

  it("tells a stopped heartbeat apart from a slow upload", () => {
    // The difference is whether anyone can do anything, and it comes from the
    // heartbeat rather than from guessing at a progress bar that has not moved.
    const away = classifyVisit({
      sync,
      liveCopyUrl: tunnelUrl,
      laptopConfirmedAt: ago(CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS + 1),
      now,
    });
    expect(away.state).toBe("sharer-away");
    // Not even the address it last registered: a tunnel dies with the laptop,
    // so offering it now is offering a link that fails.
    expect(away.liveCopy).toBeNull();

    const slow = classifyVisit({
      sync,
      liveCopyUrl: tunnelUrl,
      laptopConfirmedAt: ago(CLOUD_SYNC_LIVE_COPY_STALE_AFTER_MS - 1),
      now,
    });
    expect(slow.state).toBe("first-pass-live");
  });

  it("never registered a heartbeat at all reads as away, not as syncing", () => {
    expect(classifyVisit({ sync, liveCopyUrl: null, laptopConfirmedAt: null, now }).state).toBe(
      "sharer-away",
    );
  });

  it("serves from the cloud once the two sides have agreed, whatever the laptop is doing", () => {
    const agreed: ProjectCloudSync = { ...sync, lastAgreedAt: "2026-08-19T11:59:00.000Z" };

    // The laptop closed thirty minutes ago and it does not matter: the cloud
    // copy is canonical, and every link that was handed out pointed here.
    const view = classifyVisit({
      sync: agreed,
      liveCopyUrl: tunnelUrl,
      laptopConfirmedAt: ago(30 * 60_000),
      now,
    });
    expect(view.state).toBe("synced");
    expect(view.turnsAllowed).toBe(true);
    // No live copy is offered after this point even if one is still registered:
    // the tunnel has done its job and the cloud is the answer.
    expect(view.liveCopy).toBeNull();
  });

  it("a project nobody ever synced is not a project that is loading", () => {
    const view = classifyVisit({ sync: null, liveCopyUrl: null, laptopConfirmedAt: null, now });
    expect(view.state).toBe("not-syncing");
    expect(view.turnsAllowed).toBe(false);
  });

  it("will not offer an address it would refuse today", () => {
    // An older build, or a column edited by hand. The check is re-run on the
    // way out because the way out is a redirect.
    const view = classifyVisit({
      sync,
      liveCopyUrl: "javascript:alert(1)",
      laptopConfirmedAt: ago(1_000),
      now,
    });
    expect(view.state).toBe("first-pass");
    expect(view.liveCopy).toBeNull();
  });
});

describe("handing a visitor over once the pass is done", () => {
  const projectId = ProjectId.make("project-atlas");

  it("sends them to the cloud address the link always pointed at", () => {
    const registry = new CloudSyncHandoffRegistry();
    expect(registry.get(projectId)).toBeNull();

    expect(
      registry.register(projectId, "https://app.t3.tools/p/atlas", "2026-08-19T12:00:00.000Z"),
    ).toBe(true);
    expect(registry.get(projectId)?.canonicalUrl).toBe("https://app.t3.tools/p/atlas");

    registry.release(projectId);
    expect(registry.get(projectId)).toBeNull();
  });

  it("refuses an address that would make the redirect the attack", () => {
    const registry = new CloudSyncHandoffRegistry();
    expect(registry.register(projectId, "javascript:alert(1)", "2026-08-19T12:00:00.000Z")).toBe(
      false,
    );
    expect(
      registry.register(projectId, "https://a:b@evil.example", "2026-08-19T12:00:00.000Z"),
    ).toBe(false);
    expect(registry.get(projectId)).toBeNull();
  });
});
