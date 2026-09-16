import { describe, expect, it } from "vitest";

import {
  DESKTOP_DEEP_LINK_SCHEME,
  findDeepLinkInArgv,
  isDesktopDeepLink,
  parseDesktopDeepLink,
  resolveProtocolClientRegistration,
} from "./deepLink.ts";

describe("parseDesktopDeepLink", () => {
  it("reads the code out of the query form the approval page writes", () => {
    expect(parseDesktopDeepLink("logicpacks://enroll?code=ABC123xyz")).toEqual({
      action: "enroll",
      code: "ABC123xyz",
      server: null,
      outcome: null,
    });
  });

  it("reads the path form Windows tends to hand back", () => {
    expect(parseDesktopDeepLink("logicpacks://enroll/ABC123xyz")).toEqual({
      action: "enroll",
      code: "ABC123xyz",
      server: null,
      outcome: null,
    });
  });

  it("reads the schemeless-authority form some Linux handlers produce", () => {
    expect(parseDesktopDeepLink("logicpacks:enroll?code=ABC123xyz")?.code).toBe("ABC123xyz");
  });

  it("accepts the scheme in any case, because the OS decides the casing", () => {
    expect(parseDesktopDeepLink("LOGICPACKS://ENROLL?code=ABC123xyz")?.code).toBe("ABC123xyz");
  });

  it("carries the reported outcome when the page states one", () => {
    expect(parseDesktopDeepLink("logicpacks://enroll?code=ABC123xyz&status=denied")?.outcome).toBe(
      "denied",
    );
    expect(
      parseDesktopDeepLink("logicpacks://enroll?code=ABC123xyz&status=Approved")?.outcome,
    ).toBe("approved");
  });

  /*
   * A missing or unrecognised status must not read as approval. The link is a
   * nudge and the server is the authority; anything that can open a URL could
   * otherwise claim an approval nobody gave.
   */
  it("reports no outcome rather than guessing one", () => {
    expect(
      parseDesktopDeepLink("logicpacks://enroll?code=ABC123xyz&status=ok")?.outcome,
    ).toBeNull();
    expect(parseDesktopDeepLink("logicpacks://enroll?code=ABC123xyz")?.outcome).toBeNull();
  });

  it("prefers the query parameter when a link carries both forms", () => {
    expect(parseDesktopDeepLink("logicpacks://enroll/pathcode?code=querycode")?.code).toBe(
      "querycode",
    );
  });

  /*
   * Every one of these arrives from the operating system, fed by sources this
   * app does not control. None of them may throw: a throw on `open-url` or on
   * second-instance argv takes a launch down.
   */
  it.each([
    ["a plain empty string", ""],
    ["whitespace", "   "],
    ["another app's scheme", "vscode://enroll?code=ABC123xyz"],
    ["an http url", "https://example.com/enroll?code=ABC123xyz"],
    ["our scheme with no action", "logicpacks://"],
    ["an unknown action", "logicpacks://sign-in?code=ABC123xyz"],
    ["our action with no code", "logicpacks://enroll"],
    ["an empty code", "logicpacks://enroll?code="],
    ["a code that is only whitespace", "logicpacks://enroll?code=%20%20"],
    ["a code too short to be one", "logicpacks://enroll?code=abc"],
    ["a code carrying a path traversal", "logicpacks://enroll?code=../../etc/passwd"],
    ["a code carrying a slash", "logicpacks://enroll?code=abc/def"],
    ["a code carrying a newline", "logicpacks://enroll?code=abc%0Adef123"],
    ["a code far longer than any code", `logicpacks://enroll?code=${"a".repeat(200)}`],
    ["a bare word", "enroll"],
  ])("returns null for %s", (_label, input) => {
    expect(() => parseDesktopDeepLink(input)).not.toThrow();
    expect(parseDesktopDeepLink(input)).toBeNull();
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { code: "ABC123xyz" }],
    ["an array", ["logicpacks://enroll?code=ABC123xyz"]],
  ])("returns null for %s rather than throwing", (_label, input) => {
    expect(() => parseDesktopDeepLink(input)).not.toThrow();
    expect(parseDesktopDeepLink(input)).toBeNull();
  });

  it("names the scheme it parses, so registration and parsing cannot drift", () => {
    expect(
      parseDesktopDeepLink(`${DESKTOP_DEEP_LINK_SCHEME}://enroll?code=ABC123xyz`),
    ).not.toBeNull();
  });
});

describe("isDesktopDeepLink", () => {
  it("separates a malformed link of ours from an argument that is not ours at all", () => {
    expect(isDesktopDeepLink("logicpacks://enroll")).toBe(true);
    expect(isDesktopDeepLink("--enable-features=Foo")).toBe(false);
    expect(isDesktopDeepLink(7)).toBe(false);
  });
});

describe("findDeepLinkInArgv", () => {
  /*
   * The shape Windows and Linux actually deliver: the executable, whatever
   * switches Electron adds, and the URL somewhere among them. Reading argv[1]
   * would find a switch here, which is why this scans.
   */
  it("finds the link among the switches a real launch carries", () => {
    const argv = [
      "/Applications/LogicPacks.app/Contents/MacOS/LogicPacks",
      "--allow-file-access-from-files",
      "logicpacks://enroll?code=ABC123xyz",
      "--no-sandbox",
    ];
    expect(findDeepLinkInArgv(argv)?.code).toBe("ABC123xyz");
  });

  it("takes the later link when a launch somehow carries two", () => {
    const argv = ["app", "logicpacks://enroll?code=firstcode", "logicpacks://enroll?code=lastcode"];
    expect(findDeepLinkInArgv(argv)?.code).toBe("lastcode");
  });

  it("ignores a malformed link rather than reporting it as a launch argument", () => {
    expect(findDeepLinkInArgv(["app", "logicpacks://enroll"])).toBeNull();
  });

  it("returns null for an ordinary launch and for no argv at all", () => {
    expect(findDeepLinkInArgv(["app", "--inspect"])).toBeNull();
    expect(findDeepLinkInArgv(undefined)).toBeNull();
  });
});

describe("resolveProtocolClientRegistration", () => {
  it("points the OS straight at a packaged app", () => {
    expect(
      resolveProtocolClientRegistration({
        isDefaultApp: false,
        execPath: "/Applications/LogicPacks.app/Contents/MacOS/LogicPacks",
        argv: ["/Applications/LogicPacks.app/Contents/MacOS/LogicPacks"],
      }),
    ).toEqual({ execPath: "/Applications/LogicPacks.app/Contents/MacOS/LogicPacks", args: [] });
  });

  /*
   * In development `execPath` is the Electron binary and the app is an argument
   * to it. Registering without that argument tells the OS to launch bare
   * Electron, which opens a blank window and drops the link.
   */
  it("carries the script path in development so the OS launches the app, not Electron", () => {
    expect(
      resolveProtocolClientRegistration({
        isDefaultApp: true,
        execPath: "/repo/node_modules/electron/dist/electron",
        argv: ["/repo/node_modules/electron/dist/electron", "/repo/apps/desktop"],
      }),
    ).toEqual({
      execPath: "/repo/node_modules/electron/dist/electron",
      args: ["/repo/apps/desktop"],
    });
  });

  /*
   * A wrong registration outlives the run that made it — it stays in the
   * registry or the desktop database. Declining is the safer failure.
   */
  it("declines rather than registering a handler that would launch the wrong thing", () => {
    expect(
      resolveProtocolClientRegistration({
        isDefaultApp: true,
        execPath: "/repo/node_modules/electron/dist/electron",
        argv: ["/repo/node_modules/electron/dist/electron"],
      }),
    ).toBeNull();
  });
});
