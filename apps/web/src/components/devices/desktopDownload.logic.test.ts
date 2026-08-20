import { describe, expect, it } from "vitest";

import {
  DESKTOP_DOWNLOAD_BASE_URL,
  DESKTOP_DOWNLOAD_TARGETS,
  desktopArtifactFileName,
  describeDesktopDownloadAvailability,
  detectDesktopPlatform,
  orderDesktopDownloadTargets,
  resolveDesktopDownloadUrl,
  type DesktopPlatform,
} from "./desktopDownload.logic";

// Real strings, copied from the browsers they came from. Substrings invented to
// suit the implementation would pass a test the implementation cannot.
const USER_AGENTS = {
  macChrome:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  windowsFirefox:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  linuxChrome:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  ipad: "Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  curl: "curl/8.7.1",
  empty: "",
} as const;

describe("detectDesktopPlatform", () => {
  it("recognises the three desktops it has builds for", () => {
    expect(detectDesktopPlatform(USER_AGENTS.macChrome)).toBe("macos");
    expect(detectDesktopPlatform(USER_AGENTS.macSafari)).toBe("macos");
    expect(detectDesktopPlatform(USER_AGENTS.windowsChrome)).toBe("windows");
    expect(detectDesktopPlatform(USER_AGENTS.windowsFirefox)).toBe("windows");
    expect(detectDesktopPlatform(USER_AGENTS.linuxFirefox)).toBe("linux");
    expect(detectDesktopPlatform(USER_AGENTS.linuxChrome)).toBe("linux");
  });

  it("is not fooled by phones and tablets impersonating the desktops they came from", () => {
    // iOS user agents say "like Mac OS X" and Android's say "Linux". A
    // substring match in the wrong order offers an iPad a .dmg.
    expect(detectDesktopPlatform(USER_AGENTS.iphone)).toBeNull();
    expect(detectDesktopPlatform(USER_AGENTS.ipad)).toBeNull();
    expect(detectDesktopPlatform(USER_AGENTS.android)).toBeNull();
  });

  it("declines ChromeOS, which has no build even though its UA says X11", () => {
    expect(detectDesktopPlatform(USER_AGENTS.chromeOs)).toBeNull();
  });

  it("returns null for a user agent it does not recognise rather than guessing", () => {
    expect(detectDesktopPlatform(USER_AGENTS.curl)).toBeNull();
    expect(detectDesktopPlatform(USER_AGENTS.empty)).toBeNull();
    expect(detectDesktopPlatform("Some Corporate Browser/3.1")).toBeNull();
  });

  it("does not care about case", () => {
    expect(detectDesktopPlatform(USER_AGENTS.windowsChrome.toUpperCase())).toBe("windows");
    expect(detectDesktopPlatform(USER_AGENTS.macChrome.toLowerCase())).toBe("macos");
  });
});

describe("orderDesktopDownloadTargets", () => {
  it("leads with the detected platform and keeps the other two", () => {
    for (const platform of ["macos", "windows", "linux"] satisfies ReadonlyArray<DesktopPlatform>) {
      const ordered = orderDesktopDownloadTargets(platform);
      expect(ordered).toHaveLength(3);
      expect(ordered[0]?.platform).toBe(platform);
      expect(new Set(ordered.map((target) => target.platform)).size).toBe(3);
    }
  });

  it("promotes nothing when detection declined to guess", () => {
    expect(orderDesktopDownloadTargets(null).map((target) => target.platform)).toEqual([
      "macos",
      "windows",
      "linux",
    ]);
  });
});

describe("desktopArtifactFileName", () => {
  it("matches the artifactName the build script hands electron-builder", () => {
    expect(desktopArtifactFileName({ platform: "macos", version: "0.0.20", arch: "arm64" })).toBe(
      "LogicPacks-0.0.20-arm64.dmg",
    );
    expect(desktopArtifactFileName({ platform: "windows", version: "0.0.20", arch: "x64" })).toBe(
      "LogicPacks-0.0.20-x64.exe",
    );
    expect(desktopArtifactFileName({ platform: "linux", version: "1.2.3", arch: "x64" })).toBe(
      "LogicPacks-1.2.3-x64.AppImage",
    );
  });
});

describe("download availability", () => {
  it("has no URL to offer, because nothing publishes the artifacts yet", () => {
    // Guards the honest degradation: the page draws a "not published" state off
    // the back of this null. If a release host is wired up, this test is the
    // reminder that the page's empty state should go with it.
    expect(DESKTOP_DOWNLOAD_BASE_URL).toBeNull();
    expect(
      resolveDesktopDownloadUrl({ platform: "macos", version: "0.0.20", arch: "arm64" }),
    ).toBeNull();
    expect(describeDesktopDownloadAvailability().published).toBe(false);
  });

  it("says so in words rather than leaving a dead button unexplained", () => {
    const availability = describeDesktopDownloadAvailability();
    expect(availability.title).toMatch(/not published/i);
    expect(availability.detail.length).toBeGreaterThan(0);
  });
});

describe("first-run warnings", () => {
  it("warns about the unsigned-binary step on every platform", () => {
    expect(DESKTOP_DOWNLOAD_TARGETS.macos.firstRunWarning).toMatch(/unidentified developer/i);
    expect(DESKTOP_DOWNLOAD_TARGETS.macos.firstRunWarning).toMatch(/right-click|control-click/i);
    expect(DESKTOP_DOWNLOAD_TARGETS.windows.firstRunWarning).toMatch(/smartscreen/i);
    expect(DESKTOP_DOWNLOAD_TARGETS.windows.firstRunWarning).toMatch(/run anyway/i);
    expect(DESKTOP_DOWNLOAD_TARGETS.linux.firstRunWarning).toMatch(/chmod \+x/i);
  });
});
