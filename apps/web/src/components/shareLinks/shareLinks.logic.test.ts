import type { ShareLink } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  buildShareLinkUrl,
  checkShareLinkTarget,
  describeMintedShareLink,
  describeShareLinkFailure,
  describeShareLinkScope,
  describeShareLinkState,
  describeShareLinkViews,
  readShareLinkErrorCode,
  readShareLinkState,
  selectShareLinksForPanel,
  shareLinkTitle,
  sortShareLinks,
} from "./shareLinks.logic";

const NOW = "2026-08-18T12:00:00.000Z";

function makeLink(overrides: Partial<ShareLink> = {}): ShareLink {
  return {
    id: "link-1",
    token: "token-1",
    scope: "file",
    tenantId: "tenant-1",
    workspaceId: "workspace-1",
    projectId: "project-1",
    filePath: "src/index.ts",
    createdByUserId: "user-1",
    label: null,
    createdAt: "2026-08-17T09:00:00.000Z",
    expiresAt: null,
    revokedAt: null,
    lastViewedAt: null,
    viewCount: 0,
    ...overrides,
  } as ShareLink;
}

describe("buildShareLinkUrl", () => {
  it("joins an origin and a token without doubling the slash", () => {
    expect(buildShareLinkUrl("token-1", "https://t3.example.com/")).toBe(
      "https://t3.example.com/s/token-1",
    );
  });

  it("escapes a token rather than trusting it to be URL-safe", () => {
    expect(buildShareLinkUrl("a/b+c", "https://t3.example.com")).toBe(
      "https://t3.example.com/s/a%2Fb%2Bc",
    );
  });
});

describe("readShareLinkErrorCode", () => {
  it("reads the contract's codes and nothing else", () => {
    expect(readShareLinkErrorCode({ code: "forbidden" })).toBe("forbidden");
    expect(readShareLinkErrorCode({ code: "invalid-target" })).toBe("invalid-target");
    expect(readShareLinkErrorCode({ code: "teapot" })).toBeNull();
    expect(readShareLinkErrorCode(new Error("boom"))).toBeNull();
    expect(readShareLinkErrorCode(null)).toBeNull();
  });
});

describe("describeShareLinkFailure", () => {
  it("tells someone refused by forbidden who can do it instead", () => {
    const notice = describeShareLinkFailure({ code: "forbidden" }, { fallbackTitle: "nope" });

    expect(notice.tone).toBe("error");
    expect(notice.title).toBe("You cannot share this");
    expect(notice.description).toMatch(/admin/i);
  });

  it("treats an already-revoked link as news, not as a mistake", () => {
    expect(describeShareLinkFailure({ code: "revoked" }, { fallbackTitle: "nope" }).tone).toBe(
      "info",
    );
  });

  it("falls back to the error's own message", () => {
    const notice = describeShareLinkFailure(new Error("socket closed"), {
      fallbackTitle: "Could not make the link",
    });

    expect(notice).toMatchObject({
      tone: "error",
      title: "Could not make the link",
      description: "socket closed",
    });
  });
});

describe("readShareLinkState", () => {
  it("calls a link with no expiry active", () => {
    expect(readShareLinkState(makeLink(), NOW)).toBe("active");
  });

  it("calls a lapsed expiry expired", () => {
    expect(readShareLinkState(makeLink({ expiresAt: "2026-08-18T11:59:59.000Z" }), NOW)).toBe(
      "expired",
    );
  });

  it("keeps a future expiry active", () => {
    expect(readShareLinkState(makeLink({ expiresAt: "2026-08-19T00:00:00.000Z" }), NOW)).toBe(
      "active",
    );
  });

  it("reports revoked even when the link had also lapsed", () => {
    const link = makeLink({
      expiresAt: "2026-08-01T00:00:00.000Z",
      revokedAt: "2026-08-02T00:00:00.000Z",
    });

    expect(readShareLinkState(link, NOW)).toBe("revoked");
  });
});

describe("describeShareLinkState", () => {
  it("says when access ended rather than that it has", () => {
    const link = makeLink({ revokedAt: "2026-08-02T10:30:00.000Z" });

    expect(describeShareLinkState(link, NOW)).toMatch(/^Stopped working /);
  });

  it("promises nothing about a link with no expiry beyond revocation", () => {
    expect(describeShareLinkState(makeLink(), NOW)).toBe("Works until you revoke it");
  });
});

describe("describeShareLinkViews", () => {
  it("says nothing has opened it rather than showing a zero", () => {
    expect(describeShareLinkViews(makeLink())).toBe("Not opened yet");
  });

  it("counts one view in the singular", () => {
    expect(describeShareLinkViews(makeLink({ viewCount: 1 }))).toBe("1 view");
  });

  it("adds the last view when there is one", () => {
    const summary = describeShareLinkViews(
      makeLink({ viewCount: 4, lastViewedAt: "2026-08-18T09:15:00.000Z" }),
    );

    expect(summary).toMatch(/^4 views · last /);
  });
});

describe("shareLinkTitle", () => {
  it("prefers what the maker called it", () => {
    expect(shareLinkTitle(makeLink({ label: "For the client" }))).toBe("For the client");
  });

  it("falls back to the path, the project, or the workspace", () => {
    expect(shareLinkTitle(makeLink())).toBe("src/index.ts");
    expect(shareLinkTitle(makeLink({ scope: "project", filePath: null }))).toBe("Whole project");
    expect(shareLinkTitle(makeLink({ scope: "workspace", projectId: null, filePath: null }))).toBe(
      "Whole workspace",
    );
  });
});

describe("describeShareLinkScope", () => {
  const names = { projectLabel: "checkout", workspaceLabel: "Acme" };

  it("warns that a workspace link makes the visitor a collaborator", () => {
    const copy = describeShareLinkScope("workspace", names);

    expect(copy.consequence).toMatch(/collaborator/i);
    expect(copy.action).toBe("Invite someone into Acme");
  });

  it("says a project link is read-only and needs no account", () => {
    const copy = describeShareLinkScope("project", names);

    expect(copy.consequence).toMatch(/cannot change anything/i);
    expect(copy.consequence).toMatch(/no account/i);
  });

  it("gives each scope its own wording", () => {
    const actions = (["file", "project", "workspace"] as const).map(
      (scope) => describeShareLinkScope(scope, names).action,
    );

    expect(new Set(actions).size).toBe(3);
  });
});

describe("checkShareLinkTarget", () => {
  it("clears the target of a workspace link", () => {
    expect(
      checkShareLinkTarget({ scope: "workspace", projectId: "p-1" as never, filePath: "a.ts" }),
    ).toEqual({ ok: true, projectId: null, filePath: null });
  });

  it("drops a stale file path from a project link", () => {
    expect(
      checkShareLinkTarget({ scope: "project", projectId: "p-1" as never, filePath: "a.ts" }),
    ).toEqual({ ok: true, projectId: "p-1", filePath: null });
  });

  it("refuses a file link with no path, which the server would call invalid-target", () => {
    expect(
      checkShareLinkTarget({ scope: "file", projectId: "p-1" as never, filePath: "   " }),
    ).toEqual({ ok: false, reason: "Pick a file to share." });
  });

  it("refuses anything project-shaped with no project", () => {
    expect(checkShareLinkTarget({ scope: "project", projectId: null, filePath: null })).toEqual({
      ok: false,
      reason: "Open a project before sharing from it.",
    });
  });

  it("trims the path it passes on", () => {
    expect(
      checkShareLinkTarget({ scope: "file", projectId: "p-1" as never, filePath: " src/a.ts " }),
    ).toMatchObject({ ok: true, filePath: "src/a.ts" });
  });
});

describe("sortShareLinks", () => {
  it("puts the newest first and leaves the input alone", () => {
    const links = [
      makeLink({ id: "old" as never, createdAt: "2026-08-01T00:00:00.000Z" }),
      makeLink({ id: "new" as never, createdAt: "2026-08-17T00:00:00.000Z" }),
    ];

    expect(sortShareLinks(links).map((link) => link.id)).toEqual(["new", "old"]);
    expect(links.map((link) => link.id)).toEqual(["old", "new"]);
  });
});

describe("selectShareLinksForPanel", () => {
  it("keeps this project's links and every workspace link, newest first", () => {
    const links = [
      makeLink({ id: "mine" as never, createdAt: "2026-08-02T00:00:00.000Z" }),
      makeLink({
        id: "theirs" as never,
        projectId: "project-2" as never,
        createdAt: "2026-08-03T00:00:00.000Z",
      }),
      makeLink({
        id: "workspace" as never,
        scope: "workspace",
        projectId: null,
        filePath: null,
        createdAt: "2026-08-01T00:00:00.000Z",
      }),
    ];

    expect(selectShareLinksForPanel(links, "project-1" as never).map((link) => link.id)).toEqual([
      "mine",
      "workspace",
    ]);
  });
});

describe("describeMintedShareLink", () => {
  it("says the URL will not be shown again once it is on the clipboard", () => {
    const notice = describeMintedShareLink({ scope: "file", copied: true });

    expect(notice.tone).toBe("success");
    expect(notice.description).toMatch(/not shown again/i);
  });

  it("names an invite an invite", () => {
    expect(describeMintedShareLink({ scope: "workspace", copied: true }).title).toBe(
      "Invite link copied",
    );
  });

  it("treats a failed copy as an error, because the token cannot be fetched again", () => {
    const notice = describeMintedShareLink({ scope: "project", copied: false });

    expect(notice.tone).toBe("error");
    expect(notice.description).toMatch(/only time/i);
  });
});
