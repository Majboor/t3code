import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  ProjectId,
  ShareLink,
  ShareLinkCreateInput,
  ShareLinkId,
  ShareLinkScope,
  ShareLinkToken,
  ShareLinkView,
  ShareLinkViewId,
  TenantId,
  UserId,
  WorkspaceId,
  WS_METHODS,
} from "./index.ts";

const decodeLink = Schema.decodeUnknownSync(ShareLink);
const decodeView = Schema.decodeUnknownSync(ShareLinkView);
const decodeCreate = Schema.decodeUnknownSync(ShareLinkCreateInput);

const tenantId = TenantId.make("tenant-acme");
const workspaceId = WorkspaceId.make("workspace-platform");
const projectId = ProjectId.make("project-atlas");
const createdByUserId = UserId.make("user-ana");
const linkId = ShareLinkId.make("link-1");
const token = ShareLinkToken.make("Qy8m1nT2xw0aVb9kZr7pLc4gJd6eHs3uNf5iOa8tRw0");

const baseLink = {
  id: linkId,
  token,
  scope: "file",
  tenantId,
  workspaceId,
  projectId,
  filePath: "src/index.ts",
  createdByUserId,
  label: null,
  createdAt: "2026-08-16T09:00:00.000Z",
  expiresAt: null,
  revokedAt: null,
  lastViewedAt: null,
  viewCount: 0,
};

describe("share link contracts", () => {
  it("names exactly the three scopes and nothing adjacent", () => {
    expect(Schema.decodeUnknownSync(ShareLinkScope)("workspace")).toBe("workspace");
    expect(() => Schema.decodeUnknownSync(ShareLinkScope)("folder")).toThrow();
    expect(() => Schema.decodeUnknownSync(ShareLinkScope)("thread")).toThrow();
  });

  it("carries a workspace link with no project or file target", () => {
    const parsed = decodeLink({
      ...baseLink,
      scope: "workspace",
      projectId: null,
      filePath: null,
    });

    expect(parsed.scope).toBe("workspace");
    expect(parsed.projectId).toBeNull();
    expect(parsed.filePath).toBeNull();
  });

  it("keeps expiry and revocation as distinct timestamps, not one flag", () => {
    const parsed = decodeLink({
      ...baseLink,
      expiresAt: "2026-09-01T00:00:00.000Z",
      revokedAt: "2026-08-20T12:00:00.000Z",
    });

    expect(parsed.expiresAt).toBe("2026-09-01T00:00:00.000Z");
    expect(parsed.revokedAt).toBe("2026-08-20T12:00:00.000Z");
  });

  it("refuses a negative view count, which could only come from a bad decrement", () => {
    expect(() => decodeLink({ ...baseLink, viewCount: -1 })).toThrow();
    expect(decodeLink({ ...baseLink, viewCount: 12 }).viewCount).toBe(12);
  });

  it("records an anonymous view, since that is the ordinary case", () => {
    const parsed = decodeView({
      id: ShareLinkViewId.make("view-1"),
      linkId,
      viewedAt: "2026-08-17T10:00:00.000Z",
      viewerUserId: null,
      viewerFingerprint: "sha256:9f2c",
    });

    expect(parsed.viewerUserId).toBeNull();
    // A raw address must never reach this table; the field is a hash.
    expect(parsed.viewerFingerprint).not.toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("never lets the caller choose the token or the author", () => {
    const parsed = decodeCreate({
      tenantId,
      workspaceId,
      scope: "project",
      projectId,
      token: "chosen-by-the-caller",
      createdByUserId: UserId.make("user-someone-else"),
    });

    expect("token" in parsed).toBe(false);
    expect("createdByUserId" in parsed).toBe(false);
  });

  it("distinguishes an omitted target from an explicitly cleared one", () => {
    const cleared = decodeCreate({
      tenantId,
      workspaceId,
      scope: "workspace",
      projectId: null,
      filePath: null,
    });
    expect(cleared.projectId).toBeNull();

    const omitted = decodeCreate({ tenantId, workspaceId, scope: "workspace" });
    expect("projectId" in omitted).toBe(false);
  });

  it("exposes the three share link methods under the spec's names", () => {
    expect(WS_METHODS.shareLinksCreate).toBe("shareLinks.create");
    expect(WS_METHODS.shareLinksList).toBe("shareLinks.list");
    expect(WS_METHODS.shareLinksRevoke).toBe("shareLinks.revoke");
  });
});
