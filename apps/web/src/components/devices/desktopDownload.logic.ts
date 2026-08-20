/**
 * Which installer to put in front of somebody, and what to warn them about.
 *
 * Pure, and taking the user-agent string as an argument rather than reading
 * `navigator`, because the interesting cases are the ones that are hard to get
 * a real browser into: an iPhone whose UA says "Mac OS X", an Android whose UA
 * says "Linux", and the visitor nothing matches. Guessing wrong is not a
 * cosmetic mistake — it offers a person a file their machine cannot run.
 *
 * @module DesktopDownload
 */

export type DesktopPlatform = "macos" | "windows" | "linux";

export interface DesktopDownloadTarget {
  readonly platform: DesktopPlatform;
  /** What a person calls their operating system. */
  readonly osName: string;
  /** The extension `scripts/build-desktop-artifact.ts` gives this platform. */
  readonly fileExtension: "dmg" | "exe" | "AppImage";
  /** What the file is, for somebody who has not met the extension before. */
  readonly fileKind: string;
  /**
   * The step between downloading and the app opening. Every one of these is a
   * moment where the operating system says something alarming about software
   * nobody has paid to sign, and a person who was not told is entitled to
   * conclude the app is broken.
   */
  readonly firstRunWarning: string;
}

/**
 * The build script's `--win` default target is `nsis`, which electron-builder
 * writes out as an `.exe`; `--mac` is `dmg` and `--linux` is `AppImage`.
 * Mirrors `PLATFORM_CONFIG` in `scripts/build-desktop-artifact.ts`.
 */
export const DESKTOP_DOWNLOAD_TARGETS: Readonly<Record<DesktopPlatform, DesktopDownloadTarget>> = {
  macos: {
    platform: "macos",
    osName: "macOS",
    fileExtension: "dmg",
    fileKind: "disk image",
    firstRunWarning:
      "The app is not signed with an Apple developer certificate yet, so double-clicking it gets you “cannot be opened because it is from an unidentified developer”. Drag it to Applications, then right-click (or Control-click) it there and choose Open, and Open again in the dialog. macOS remembers the answer after the first time.",
  },
  windows: {
    platform: "windows",
    osName: "Windows",
    fileExtension: "exe",
    fileKind: "installer",
    firstRunWarning:
      "The installer is not code-signed yet, so SmartScreen shows a blue “Windows protected your PC” panel with only a Don’t run button visible. Click More info, then Run anyway. Your antivirus may also want a moment with the file first.",
  },
  linux: {
    platform: "linux",
    osName: "Linux",
    fileExtension: "AppImage",
    fileKind: "AppImage",
    firstRunWarning:
      "An AppImage arrives without the executable bit set, so nothing happens when you double-click it. Run chmod +x on the downloaded file, or tick Allow executing file as program in its properties, then launch it.",
  },
};

/**
 * Which build this visitor should be offered first, or null when we should not
 * guess.
 *
 * Order is the whole substance of this function. Phones and tablets are ruled
 * out before anything else because their user agents impersonate the desktops
 * they descend from — iOS says "like Mac OS X", Android says "Linux" — and a
 * naive substring match hands an iPad a .dmg. ChromeOS is excluded for the
 * plainer reason that there is no build for it.
 *
 * Anything left unrecognised returns null rather than falling back to a guess:
 * showing all three and letting a person choose is a small inconvenience, while
 * leading with the wrong one is a download that cannot work.
 */
export function detectDesktopPlatform(userAgent: string): DesktopPlatform | null {
  const ua = userAgent.toLowerCase();

  if (/android|iphone|ipad|ipod|cros|windows phone/.test(ua)) {
    return null;
  }
  if (/windows|win32|win64/.test(ua)) {
    return "windows";
  }
  if (/macintosh|mac os x|macintel/.test(ua)) {
    return "macos";
  }
  if (/linux|x11|freebsd|ubuntu/.test(ua)) {
    return "linux";
  }
  return null;
}

/**
 * The detected build first, the other two after it, in a stable order.
 *
 * Called with null when detection declined to guess, and then the order is
 * simply the declaration order — no platform is quietly promoted to default.
 */
export function orderDesktopDownloadTargets(
  detected: DesktopPlatform | null,
): ReadonlyArray<DesktopDownloadTarget> {
  const all: ReadonlyArray<DesktopDownloadTarget> = [
    DESKTOP_DOWNLOAD_TARGETS.macos,
    DESKTOP_DOWNLOAD_TARGETS.windows,
    DESKTOP_DOWNLOAD_TARGETS.linux,
  ];
  if (detected === null) {
    return all;
  }
  return [
    DESKTOP_DOWNLOAD_TARGETS[detected],
    ...all.filter((target) => target.platform !== detected),
  ];
}

/**
 * What the build script writes, so the page can name the file a person is
 * looking for in their downloads folder.
 *
 * `LogicPacks-${version}-${arch}.${ext}` is electron-builder's `artifactName`
 * in `scripts/build-desktop-artifact.ts`; keep the two in step.
 */
export function desktopArtifactFileName(input: {
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly arch: string;
}): string {
  const target = DESKTOP_DOWNLOAD_TARGETS[input.platform];
  return `LogicPacks-${input.version}-${input.arch}.${target.fileExtension}`;
}

/**
 * Where a published installer would be fetched from.
 *
 * NOTHING PUBLISHES THESE FILES YET. `scripts/build-desktop-artifact.ts` builds
 * them onto the machine that ran it and no job uploads them anywhere, so there
 * is no host this could point at. The value stays null on purpose, and
 * `resolveDesktopDownloadUrl` returns null with it, so the page draws a plain
 * "not published yet" state instead of a button that 404s. A URL invented here
 * to make the page look finished would be worse than no button: it would look
 * like the release exists.
 *
 * When there is a release host, this is the one line that changes — set it to
 * the directory the artifacts are uploaded to and every button lights up.
 */
export const DESKTOP_DOWNLOAD_BASE_URL: string | null = null;

/**
 * The link for a build, or null when there is nowhere to link to.
 *
 * Callers must handle the null rather than defaulting it — that is the point of
 * returning it.
 */
export function resolveDesktopDownloadUrl(input: {
  readonly platform: DesktopPlatform;
  readonly version: string;
  readonly arch: string;
}): string | null {
  if (DESKTOP_DOWNLOAD_BASE_URL === null) {
    return null;
  }
  const base = DESKTOP_DOWNLOAD_BASE_URL.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(desktopArtifactFileName(input))}`;
}

export interface DesktopDownloadAvailability {
  readonly published: boolean;
  readonly title: string;
  readonly detail: string;
}

/**
 * What to say on a page whose downloads do not exist.
 *
 * Said plainly and in one place, because the alternative — a disabled button
 * with no explanation — reads as a bug in the page rather than a release that
 * has not happened.
 */
export function describeDesktopDownloadAvailability(): DesktopDownloadAvailability {
  if (DESKTOP_DOWNLOAD_BASE_URL !== null) {
    return {
      published: true,
      title: "Downloads are ready",
      detail: "Pick your operating system and the installer starts immediately.",
    };
  }
  return {
    published: false,
    title: "Downloads are not published yet",
    detail:
      "The desktop app builds, but no release has been uploaded anywhere, so there is nothing to hand you here yet. Until then a machine still joins your account the manual way: run the server on it and paste the pairing link it prints.",
  };
}
