import type { OrchestrationProjectOwnership } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  CREATABLE_PROJECT_KINDS,
  DEFAULT_PROJECT_KIND,
  describeProjectKindChoice,
  resolveProjectKindAvailability,
  resolveProjectKindChoices,
  resolveSelectedProjectKind,
  type ProjectKindAvailability,
} from "./projectKind.logic";

const OWNERSHIP = {
  tenantId: "tenant_1",
  tenantDisplayName: "Acme",
  workspaceId: "workspace_1",
  workspaceTitle: "Acme workspace",
  organizationId: null,
  organizationDisplayName: null,
  ownerUserId: null,
  ownerDisplayName: null,
} as unknown as OrchestrationProjectOwnership;

function availability(overrides: Partial<ProjectKindAvailability> = {}): ProjectKindAvailability {
  return { workspaceSource: "this-server", cloudSyncConfigured: true, ...overrides };
}

function kindsOffered(input: ProjectKindAvailability): string[] {
  return resolveProjectKindChoices(input)
    .filter((choice) => choice.available)
    .map((choice) => choice.kind);
}

describe("resolveProjectKindAvailability", () => {
  it("reads an absent workspace source as this-server", () => {
    // The field is optional on every server built before it existed, and the
    // absence means `this-server`. A picker that treated absence as unknown
    // would hide hosting from every older environment.
    expect(resolveProjectKindAvailability({ auth: {}, ownership: OWNERSHIP })).toEqual({
      workspaceSource: "this-server",
      cloudSyncConfigured: true,
    });
    expect(resolveProjectKindAvailability({ auth: null, ownership: OWNERSHIP })).toEqual({
      workspaceSource: "this-server",
      cloudSyncConfigured: true,
    });
  });

  it("treats a missing workspace ownership as nowhere to host", () => {
    expect(
      resolveProjectKindAvailability({ auth: { workspaceSource: "this-server" }, ownership: null }),
    ).toEqual({ workspaceSource: "this-server", cloudSyncConfigured: false });
  });
});

describe("resolveProjectKindChoices", () => {
  it("never offers joined, because a share link produces it", () => {
    expect(CREATABLE_PROJECT_KINDS).not.toContain("joined");
    expect(resolveProjectKindChoices(availability()).map((choice) => choice.kind)).toEqual([
      "local",
      "hosted",
      "self-hosted",
    ]);
  });

  it("offers all three when the server keeps projects and there is a workspace", () => {
    expect(kindsOffered(availability())).toEqual(["local", "hosted", "self-hosted"]);
  });

  it("refuses hosted on a paired-environment server", () => {
    const choices = resolveProjectKindChoices(
      availability({ workspaceSource: "paired-environment" }),
    );
    const hosted = choices.find((choice) => choice.kind === "hosted");
    expect(hosted?.available).toBe(false);
    expect(hosted?.unavailableReason).toContain("holds accounts");
    expect(kindsOffered(availability({ workspaceSource: "paired-environment" }))).toEqual([
      "local",
      "self-hosted",
    ]);
  });

  it("refuses hosted when there is no cloud workspace to hand off to", () => {
    const choices = resolveProjectKindChoices(availability({ cloudSyncConfigured: false }));
    const hosted = choices.find((choice) => choice.kind === "hosted");
    expect(hosted?.available).toBe(false);
    expect(hosted?.unavailableReason).toContain("shared workspace");
  });

  it("prefers the server-shaped reason when both are true", () => {
    // A paired-environment server has no projects at all, so "add it to a
    // workspace" would be advice that cannot be followed. The bigger fact wins.
    const hosted = resolveProjectKindChoices(
      availability({ workspaceSource: "paired-environment", cloudSyncConfigured: false }),
    ).find((choice) => choice.kind === "hosted");
    expect(hosted?.unavailableReason).toContain("holds accounts");
  });

  it("keeps local and self-hosted available on every instance", () => {
    for (const workspaceSource of ["this-server", "paired-environment"] as const) {
      for (const cloudSyncConfigured of [true, false]) {
        const offered = kindsOffered(availability({ workspaceSource, cloudSyncConfigured }));
        expect(offered).toContain("local");
        expect(offered).toContain("self-hosted");
      }
    }
  });

  it("returns unavailable choices too, with a reason rather than a hole", () => {
    const choices = resolveProjectKindChoices(availability({ cloudSyncConfigured: false }));
    expect(choices).toHaveLength(3);
    for (const choice of choices) {
      expect(choice.available === (choice.unavailableReason === null)).toBe(true);
    }
  });
});

describe("the copy", () => {
  it("says nobody else can reach a local project, and says it is gone", () => {
    const local = resolveProjectKindChoices(availability()).find(
      (choice) => choice.kind === "local",
    )!;
    expect(local.whereFilesLive).toContain("this computer");
    expect(local.whenComputerIsOff).toContain("Nobody else can reach it");
  });

  it("says a hosted project stays reachable when the computer is off", () => {
    const hosted = resolveProjectKindChoices(availability()).find(
      (choice) => choice.kind === "hosted",
    )!;
    expect(hosted.whenComputerIsOff).toContain("reachable when this computer is off");
  });

  it("answers where the files live and what happens when the computer is off, for every kind", () => {
    // The comparison is the point: three options that answer different questions
    // cannot be compared, and comparing them is the whole job of this control.
    for (const choice of resolveProjectKindChoices(availability())) {
      expect(choice.label.length).toBeGreaterThan(0);
      expect(choice.whereFilesLive).toMatch(/\.$/);
      expect(choice.whenComputerIsOff).toMatch(/computer is off|reach it/);
      expect(describeProjectKindChoice(choice)).toBe(
        `${choice.whereFilesLive} ${choice.whenComputerIsOff}`,
      );
    }
  });
});

describe("resolveSelectedProjectKind", () => {
  it("defaults to local rather than to anything that uploads", () => {
    expect(DEFAULT_PROJECT_KIND).toBe("local");
    expect(resolveSelectedProjectKind(availability(), null)).toBe("local");
    expect(resolveSelectedProjectKind(availability(), undefined)).toBe("local");
  });

  it("keeps a choice that is still true", () => {
    expect(resolveSelectedProjectKind(availability(), "hosted")).toBe("hosted");
    expect(resolveSelectedProjectKind(availability(), "self-hosted")).toBe("self-hosted");
  });

  it("falls back to local when the target stops being able to host", () => {
    // Somebody picks hosted for one workspace, then switches the palette to an
    // environment that cannot host. Dispatching `hosted` anyway would either be
    // refused or, far worse, be honoured somewhere they did not mean.
    expect(resolveSelectedProjectKind(availability({ cloudSyncConfigured: false }), "hosted")).toBe(
      "local",
    );
    expect(
      resolveSelectedProjectKind(availability({ workspaceSource: "paired-environment" }), "hosted"),
    ).toBe("local");
  });
});
