import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildProjectBrowserUrl,
  buildProjectHandoffUrl,
  handOffProjectToBrowser,
} from "./OpenProjectInBrowser.logic";

const PROJECT_URL = "http://127.0.0.1:5183/project/environment-local/project-1";

describe("buildProjectBrowserUrl", () => {
  it("asks the environment resolver for the project route", () => {
    const resolveHttpUrl = vi.fn((pathname: string) => `http://127.0.0.1:5183${pathname}`);

    const url = buildProjectBrowserUrl({
      environmentId: EnvironmentId.make("environment-local"),
      projectId: ProjectId.make("project-1"),
      resolveHttpUrl,
    });

    expect(resolveHttpUrl).toHaveBeenCalledWith("/project/environment-local/project-1");
    expect(url).toBe(PROJECT_URL);
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

describe("buildProjectHandoffUrl", () => {
  it("carries the credential in the fragment, which never leaves the browser", () => {
    const url = new URL(buildProjectHandoffUrl({ url: PROJECT_URL, credential: "ABC123XYZ789" }));

    expect(url.hash).toBe("#token=ABC123XYZ789");
    expect(url.search).toBe("");
    expect(url.pathname).toBe("/project/environment-local/project-1");
  });
});

describe("handOffProjectToBrowser", () => {
  it("copies the plain address, then opens the one carrying the credential", async () => {
    const calls: string[] = [];
    const copied: string[] = [];
    const opened: string[] = [];

    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      mintPairingCredential: async () => {
        calls.push("mint");
        return "ABC123XYZ789";
      },
      copyToClipboard: async (text) => {
        calls.push("copy");
        copied.push(text);
        return true;
      },
      openExternal: async (target) => {
        calls.push("open");
        opened.push(target);
      },
    });

    // Copy first: the clipboard write has to happen while the click is still a
    // user gesture, and it can, because the copied value needs no credential.
    expect(calls).toEqual(["copy", "mint", "open"]);
    expect(copied).toEqual([PROJECT_URL]);
    expect(opened).toEqual([`${PROJECT_URL}#token=ABC123XYZ789`]);
    expect(outcome).toEqual({ status: "opened", copied: true, handedOff: true });
  });

  it("keeps the credential off the clipboard, so a paste is never a dead one-use link", async () => {
    const copied: string[] = [];

    await handOffProjectToBrowser({
      url: PROJECT_URL,
      mintPairingCredential: async () => "ABC123XYZ789",
      copyToClipboard: async (text) => {
        copied.push(text);
        return true;
      },
      openExternal: async () => undefined,
    });

    expect(copied).toEqual([PROJECT_URL]);
    expect(copied[0]).not.toContain("ABC123XYZ789");
  });

  it("mints nothing when the target browser already holds this session's cookie", async () => {
    const opened: string[] = [];

    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      copyToClipboard: async () => true,
      openExternal: async (target) => {
        opened.push(target);
      },
    });

    expect(opened).toEqual([PROJECT_URL]);
    expect(outcome).toEqual({ status: "opened", copied: true, handedOff: false });
  });

  it("opens nothing when the credential cannot be minted, and says why", async () => {
    const openExternal = vi.fn(async () => undefined);

    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      mintPairingCredential: async () => {
        throw new Error("Only owner sessions can hand this session to a browser.");
      },
      copyToClipboard: async () => true,
      openExternal,
    });

    expect(openExternal).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      status: "not-opened",
      copied: true,
      reason: "Only owner sessions can hand this session to a browser.",
    });
  });

  it("explains a mint failure that arrived without a message", async () => {
    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      mintPairingCredential: async () => {
        throw new Error("   ");
      },
      copyToClipboard: async () => false,
      openExternal: async () => undefined,
    });

    expect(outcome).toEqual({
      status: "not-opened",
      copied: false,
      reason: "The server would not issue a sign-in credential for your browser.",
    });
  });

  it("still opens when the clipboard refuses, and says the copy did not happen", async () => {
    const openExternal = vi.fn(async () => undefined);

    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      copyToClipboard: async () => {
        throw new Error("Clipboard unavailable.");
      },
      openExternal,
    });

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ status: "opened", copied: false, handedOff: false });
  });

  it("reports a clipboard that quietly declined", async () => {
    const outcome = await handOffProjectToBrowser({
      url: PROJECT_URL,
      copyToClipboard: async () => false,
      openExternal: async () => undefined,
    });

    expect(outcome).toEqual({ status: "opened", copied: false, handedOff: false });
  });

  it("propagates a failure to open, which is the part the user asked for", async () => {
    await expect(
      handOffProjectToBrowser({
        url: PROJECT_URL,
        copyToClipboard: async () => true,
        openExternal: async () => {
          throw new Error("Unable to open link.");
        },
      }),
    ).rejects.toThrow("Unable to open link.");
  });
});
