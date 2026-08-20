import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { DownloadIcon, KeyRoundIcon } from "lucide-react";
import { useCallback } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { useStore } from "~/store";
import { SurfaceHeading, SurfaceSection, SurfaceShell } from "../SurfaceShell";
import { Button } from "../ui/button";
import { AddEnvironmentForm } from "./AddEnvironmentForm";
import { EnvironmentConnectList } from "./EnvironmentConnectList";

export type EnvironmentsSurfaceVariant = "page" | "standalone";

/**
 * The web app's front door onto machines.
 *
 * `page` renders inside the authenticated shell at `/environments`.
 * `standalone` renders for a browser that has been refused by the environment
 * it was served from — the case that used to land on "paste a pairing token",
 * a credential a browser has no way to obtain.
 *
 * Shape adapted from upstream's connect surfaces (eyebrow, title, one sentence
 * about what happens next, then the list and the form); the mechanics are
 * ours, since our environments are reached directly rather than via a relay.
 *
 * Two ways in, on purpose. "Connect a machine" leads to the download, which is
 * the answer for somebody who has nothing yet and would not know what a pairing
 * token is. Underneath it, the form that takes a pairing link stays exactly
 * where it was: a developer who already ran the server on a box and has its
 * link in the clipboard does not want to be sent through an installer.
 */
export function EnvironmentsSurface({
  variant = "page",
  gateExplanation = null,
}: {
  readonly variant?: EnvironmentsSurfaceVariant;
  readonly gateExplanation?: string | null;
}) {
  const navigate = useNavigate();
  const setActiveEnvironmentId = useStore((state) => state.setActiveEnvironmentId);

  const handleSelect = useCallback(
    (environmentId: EnvironmentId) => {
      setActiveEnvironmentId(environmentId);
      void navigate({ to: "/" });
    },
    [navigate, setActiveEnvironmentId],
  );

  return (
    <SurfaceShell variant={variant} breadcrumbLabel="Environments">
      <div className="space-y-6">
        <SurfaceHeading
          eyebrow={variant === "standalone" ? APP_DISPLAY_NAME : "Environments"}
          title={
            variant === "standalone"
              ? "Connect the machine you work on"
              : "The machines you work on"
          }
          description={
            variant === "standalone"
              ? "An environment is a machine running the T3 server — usually your own laptop, sometimes a server you keep. Your projects stay on it; this browser just connects to it."
              : "An environment is a machine running the T3 server. Add one and its projects, sessions and terminals appear here."
          }
        />

        {gateExplanation ? (
          <div
            className="rounded-xl border border-border/70 bg-muted/35 px-4 py-3"
            data-testid="environments-gate-explanation"
          >
            <p className="text-sm leading-relaxed text-muted-foreground">{gateExplanation}</p>
          </div>
        ) : null}

        <SurfaceSection
          title="Your environments"
          description="Saved in this browser. Each one reconnects on its own when its machine is running."
        >
          <EnvironmentConnectList {...(variant === "page" ? { onSelect: handleSelect } : {})} />
        </SurfaceSection>

        <SurfaceSection
          title="Connect a machine"
          description="The short way: install the app on that computer and approve it from here. Nothing to copy."
        >
          <div className="px-4 py-4 sm:px-5">
            <p className="text-sm leading-relaxed text-muted-foreground">
              Download the app onto the computer you want to work on and launch it. It asks to join
              your account, and this browser shows you which machine is asking so you can say yes
              once.
            </p>
            <Button
              className="mt-4"
              data-testid="environments-connect-machine"
              onClick={() => void navigate({ to: "/download" })}
              size="lg"
            >
              <DownloadIcon />
              Connect a machine
            </Button>
          </div>
        </SurfaceSection>

        <SurfaceSection
          title="Add an environment by hand"
          description="Run t3 on the machine you want to reach; it prints a pairing link and a code. Either one gets you in."
        >
          <div className="px-4 py-4 sm:px-5">
            <AddEnvironmentForm autoFocus={variant === "standalone"} />
          </div>
        </SurfaceSection>

        {variant === "standalone" ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void navigate({ to: "/pair" })}
              data-testid="environments-pairing-token-link"
            >
              <KeyRoundIcon />
              This device already has a pairing token
            </Button>
          </div>
        ) : null}
      </div>
    </SurfaceShell>
  );
}
