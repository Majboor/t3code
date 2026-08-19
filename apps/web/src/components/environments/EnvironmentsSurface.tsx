import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftIcon, KeyRoundIcon } from "lucide-react";
import { useCallback } from "react";

import { APP_DISPLAY_NAME } from "~/branding";
import { useStore } from "~/store";
import { Button } from "../ui/button";
import { AddEnvironmentForm } from "./AddEnvironmentForm";
import { EnvironmentConnectList } from "./EnvironmentConnectList";

export type EnvironmentsSurfaceVariant = "page" | "standalone";

function SurfaceHeading({
  eyebrow,
  title,
  description,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
}) {
  return (
    <header>
      <p className="text-[10px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
        {eyebrow}
      </p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
        {title}
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

function SectionCard({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border/80 bg-card/55">
      <div className="border-b border-border/60 px-4 py-3 sm:px-5">
        <h2 className="text-sm font-medium text-foreground">{title}</h2>
        {description ? (
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

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

  const body = (
    <div className="space-y-6">
      <SurfaceHeading
        eyebrow={variant === "standalone" ? APP_DISPLAY_NAME : "Environments"}
        title={
          variant === "standalone" ? "Connect the machine you work on" : "The machines you work on"
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

      <SectionCard
        title="Your environments"
        description="Saved in this browser. Each one reconnects on its own when its machine is running."
      >
        <EnvironmentConnectList {...(variant === "page" ? { onSelect: handleSelect } : {})} />
      </SectionCard>

      <SectionCard
        title="Add an environment"
        description="Run t3 on the machine you want to reach; it prints a pairing link and a code. Either one gets you in."
      >
        <div className="px-4 py-4 sm:px-5">
          <AddEnvironmentForm autoFocus={variant === "standalone"} />
        </div>
      </SectionCard>

      <div className="flex flex-wrap items-center gap-2">
        {variant === "standalone" ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void navigate({ to: "/pair" })}
            data-testid="environments-pairing-token-link"
          >
            <KeyRoundIcon />
            This device already has a pairing token
          </Button>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => void navigate({ to: "/" })}>
            <ArrowLeftIcon />
            Back to your work
          </Button>
        )}
      </div>
    </div>
  );

  if (variant === "page") {
    return (
      <div className="h-dvh min-h-0 overflow-y-auto bg-background text-foreground">
        <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">{body}</div>
      </div>
    );
  }

  return (
    <div className="relative min-h-dvh overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--primary)_14%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>
      <div className="relative mx-auto w-full max-w-2xl">{body}</div>
    </div>
  );
}
