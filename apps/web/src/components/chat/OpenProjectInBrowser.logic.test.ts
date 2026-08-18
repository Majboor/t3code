import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildProjectBrowserUrl, copyLinkAndOpen } from "./OpenProjectInBrowser.logic";

describe("buildProjectBrowserUrl", () => {
  it("asks the environment resolver for the project route", () => {
    const resolveHttpUrl = vi.fn((pathname: string) => `http://127.0.0.1:5183${pathname}`);

    const url = buildProjectBrowserUrl({
      environmentId: EnvironmentId.make("environment-local"),
      projectId: ProjectId.make("project-1"),
      resolveHttpUrl,
    });

    expect(resolveHttpUrl).toHaveBeenCalledWith("/project/environment-local/project-1");
    expect(url).toBe("http://127.0.0.1:5183/project/environment-local/project-1");
  });

  it("escapes ids so a slash in one cannot invent a different route", () => {
    const resolveHttpUrl = vi.fn((pathname: string) => `http://127.0.0.1:5183${pathname}`);

    buildProjectBrowserUrl({
      environmentId: EnvironmentId.make("environment/local"),
      projectId: ProjectId.make("project 1"),
      resolveHttpUrl,
    });

    expect(resolveHttpUrl).toHaveBeenCalledWith("/project/environment%2Flocal/project%201");
  });
});

describe("copyLinkAndOpen", () => {
  it("copies before opening, so the clipboard write still has focus", async () => {
    const calls: string[] = [];

    const outcome = await copyLinkAndOpen({
      url: "http://127.0.0.1:5183/project/environment-local/project-1",
      copyToClipboard: async () => {
        calls.push("copy");
        return true;
      },
      openExternal: async () => {
        calls.push("open");
      },
    });

    expect(calls).toEqual(["copy", "open"]);
    expect(outcome).toEqual({ copied: true });
  });

  it("still opens when the clipboard refuses, and says the copy did not happen", async () => {
    const openExternal = vi.fn(async () => undefined);

    const outcome = await copyLinkAndOpen({
      url: "http://127.0.0.1:5183/project/environment-local/project-1",
      copyToClipboard: async () => {
        throw new Error("Clipboard unavailable.");
      },
      openExternal,
    });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ copied: false });
  });

  it("reports a clipboard that quietly declined", async () => {
    const outcome = await copyLinkAndOpen({
      url: "http://127.0.0.1:5183/project/environment-local/project-1",
      copyToClipboard: async () => false,
      openExternal: async () => undefined,
    });

    expect(outcome).toEqual({ copied: false });
  });

  it("propagates a failure to open, which is the part the user asked for", async () => {
    await expect(
      copyLinkAndOpen({
        url: "http://127.0.0.1:5183/project/environment-local/project-1",
        copyToClipboard: async () => true,
        openExternal: async () => {
          throw new Error("Unable to open link.");
        },
      }),
    ).rejects.toThrow("Unable to open link.");
  });
});
