import { useNavigate } from "@tanstack/react-router";
import { AlertTriangleIcon, DownloadIcon, KeyRoundIcon } from "lucide-react";
import { useMemo } from "react";

import { APP_BASE_NAME, APP_VERSION } from "~/branding";
import { SurfaceHeading, SurfaceSection, SurfaceShell, type SurfaceVariant } from "../SurfaceShell";
import { Button } from "../ui/button";
import {
  desktopArtifactFileName,
  describeDesktopDownloadAvailability,
  detectDesktopPlatform,
  orderDesktopDownloadTargets,
  resolveDesktopDownloadUrl,
  type DesktopDownloadTarget,
} from "./desktopDownload.logic";

/**
 * `/download` — the first half of connecting a machine.
 *
 * Two things this page refuses to do. It does not guess an operating system it
 * cannot recognise: an unrecognised visitor gets all three builds in a fixed
 * order rather than whichever one a substring match landed on, because the cost
 * of leading with the wrong one is a file that will not run. And it does not
 * draw a download button when there is nothing to download — see
 * `DESKTOP_DOWNLOAD_BASE_URL`. Nothing publishes these artifacts yet, so the
 * page says exactly that and keeps the manual route visible, which is worse
 * than a working button and much better than one that 404s.
 *
 * The unsigned-binary warning is on the page rather than in a support doc for
 * the reason it exists: a person who meets Gatekeeper or SmartScreen with no
 * warning concludes the app is broken, and the download was wasted.
 */
export function DesktopDownloadSurface({
  variant = "page",
}: {
  readonly variant?: SurfaceVariant;
}) {
  const navigate = useNavigate();
  const detected = useMemo(
    () =>
      typeof navigator === "undefined" ? null : detectDesktopPlatform(navigator.userAgent ?? ""),
    [],
  );
  const targets = useMemo(() => orderDesktopDownloadTargets(detected), [detected]);
  const availability = describeDesktopDownloadAvailability();
  const [primary, ...alternatives] = targets;

  return (
    <SurfaceShell variant={variant} breadcrumbLabel="Download">
      <div className="space-y-6">
        <SurfaceHeading
          eyebrow="Connect a machine"
          title={`Get ${APP_BASE_NAME} for this machine`}
          description="Install the app on the computer whose projects you want to work on, launch it, and it asks this browser for permission. There is no code to type — you approve it here, once."
        />

        {availability.published ? null : (
          <div
            className="rounded-xl border border-border/70 bg-muted/35 px-4 py-3"
            data-testid="download-unavailable"
          >
            <p className="text-sm font-medium text-foreground">{availability.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {availability.detail}
            </p>
          </div>
        )}

        {primary ? (
          <SurfaceSection
            title={
              detected === null
                ? "Pick your operating system"
                : `For ${primary.osName}${detected === primary.platform ? " — this machine" : ""}`
            }
            description={
              detected === null
                ? "We could not tell what this computer runs, so nothing is preselected. All three builds are below."
                : `A ${primary.fileKind}, named ${desktopArtifactFileName({ platform: primary.platform, version: APP_VERSION, arch: "arm64" })} or similar depending on the processor.`
            }
          >
            <div className="space-y-4 px-4 py-4 sm:px-5">
              <DownloadButton target={primary} emphasis="primary" />
              {alternatives.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
                  <span className="text-xs text-muted-foreground">Other builds:</span>
                  {alternatives.map((target) => (
                    <DownloadButton key={target.platform} target={target} emphasis="secondary" />
                  ))}
                </div>
              ) : null}
            </div>
          </SurfaceSection>
        ) : null}

        <SurfaceSection
          title="Your computer will warn you the first time"
          description="Nothing is wrong with the download — the app is not code-signed yet, and both operating systems say so loudly."
        >
          <ul className="divide-y divide-border/60" data-testid="download-unsigned-warnings">
            {targets.map((target) => (
              <li className="px-4 py-3 sm:px-5" key={target.platform}>
                <div className="flex items-center gap-2">
                  <AlertTriangleIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{target.osName}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {target.firstRunWarning}
                </p>
              </li>
            ))}
          </ul>
        </SurfaceSection>

        <SurfaceSection
          title="After it opens"
          description="The app makes a short-lived request and opens your browser at it."
        >
          <div className="px-4 py-4 text-sm leading-relaxed text-muted-foreground sm:px-5">
            You will see the machine's name, what it runs and the address it asked from, with one
            Connect button. Approve it only if that is the computer in front of you. The request
            expires within minutes, and nothing is granted until you press the button.
          </div>
        </SurfaceSection>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            data-testid="download-back-to-environments"
            onClick={() => void navigate({ to: "/environments" })}
            size="sm"
            variant="ghost"
          >
            <KeyRoundIcon />
            Already have a pairing link? Add the machine by hand
          </Button>
        </div>
      </div>
    </SurfaceShell>
  );
}

/**
 * A real link when there is a file, and a disabled button that says why when
 * there is not. Never an anchor to a URL nobody has published.
 */
function DownloadButton({
  target,
  emphasis,
}: {
  readonly target: DesktopDownloadTarget;
  readonly emphasis: "primary" | "secondary";
}) {
  const href = resolveDesktopDownloadUrl({
    platform: target.platform,
    version: APP_VERSION,
    arch: "arm64",
  });
  const label = `Download for ${target.osName} (.${target.fileExtension})`;

  if (href === null) {
    return (
      <Button
        data-testid={`download-button-${target.platform}`}
        disabled
        size={emphasis === "primary" ? "lg" : "sm"}
        variant={emphasis === "primary" ? "default" : "outline"}
        title="No release has been published yet."
      >
        <DownloadIcon />
        {label}
      </Button>
    );
  }

  return (
    <Button
      data-testid={`download-button-${target.platform}`}
      render={<a href={href} download />}
      size={emphasis === "primary" ? "lg" : "sm"}
      variant={emphasis === "primary" ? "default" : "outline"}
    >
      <DownloadIcon />
      {label}
    </Button>
  );
}
