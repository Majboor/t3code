import {
  CheckCircle2Icon,
  ClockIcon,
  Loader2Icon,
  MonitorSmartphoneIcon,
  ShieldQuestionMarkIcon,
  XCircleIcon,
} from "lucide-react";
import { decideProviderSetupPrompt, type MachineRole } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { cn } from "~/lib/utils";

import { APP_DISPLAY_NAME } from "../../branding";
import type { ServerAuthGateState } from "../../environments/primary";
import { PairingRouteSurface } from "../auth/PairingRouteSurface";
import { Button } from "../ui/button";
import {
  approveDeviceEnrollment,
  denyDeviceEnrollment,
  DeviceEnrollmentError,
  fetchDeviceEnrollmentPreview,
  fetchProviderAccountConnected,
} from "./deviceEnrollment";
import {
  describeDevicePlatform,
  describeEnrollmentOutcome,
  describeMachineLabel,
  describeRequestedIp,
  formatEnrollmentTimeLeft,
  MACHINE_ROLE_CHOICES,
  readEnrollmentOutcome,
  type EnrollmentPreview,
} from "./deviceEnrollment.logic";

/**
 * Where a machine's request to join an account is answered.
 *
 * The whole feature rests on this one screen, and specifically on the four
 * lines in the middle of it. A machine asking for a session is asking for the
 * ability to open every project on this account and run commands in them, and
 * the only defence is a person recognising the thing that asked. "Approve this
 * machine?" with nothing named underneath is a dialog people click through, so
 * the name, the platform, the address it came from and the time it has left are
 * not decoration and are never hidden — an unnamed machine says so in words.
 *
 * Nothing here mints anything. The code in the URL is a handle on a request,
 * not a credential: it gets you this page, and the session is granted on the
 * server against the account this browser is signed in as.
 */
export function DeviceConnectRoute({
  authGateState,
  /** Straight out of the URL; null when the visitor arrived without one. */
  code,
}: {
  readonly authGateState: ServerAuthGateState;
  readonly code: string | null;
}) {
  const authenticated = authGateState.status === "authenticated";

  const [preview, setPreview] = useState<
    | { readonly status: "loading" }
    | { readonly status: "ready"; readonly preview: EnrollmentPreview }
    | {
        readonly status: "unreadable";
        readonly outcome: "unknown-code" | "failed";
        readonly message: string;
      }
  >({ status: "loading" });
  const [decision, setDecision] = useState<
    | { readonly status: "idle" | "approving" | "denying" | "denied" }
    | { readonly status: "approved"; readonly machineRole: MachineRole }
    | { readonly status: "refused"; readonly message: string }
    | { readonly status: "signed-out"; readonly message: string }
  >({ status: "idle" });
  /**
   * What this machine is for, answered before Connect rather than after.
   *
   * Defaulted to the workspace host because that is what almost every machine
   * is, and because it is the answer that leads somewhere — a person who does
   * not read the choice ends up on the path that asks for a provider account,
   * which is the recoverable mistake. Defaulting to `runner` would silently
   * skip the one prompt a new workspace actually needs.
   */
  const [machineRole, setMachineRole] = useState<MachineRole>("workspace-host");
  /**
   * Looked up so the screen after Connect does not tell somebody to go and
   * connect an account they connected months ago. Unknown counts as "no": see
   * `fetchProviderAccountConnected`.
   */
  const [providerAccountConnected, setProviderAccountConnected] = useState(false);
  // Re-rendered once a second only while somebody is deciding, so the deadline
  // on screen is the deadline, not the one that applied when the page loaded.
  const [nowMs, setNowMs] = useState(() => Date.now());

  const load = useCallback(async () => {
    if (code === null) {
      return;
    }
    setPreview({ status: "loading" });
    try {
      setPreview({ status: "ready", preview: await fetchDeviceEnrollmentPreview(code) });
    } catch (error: unknown) {
      const kind = error instanceof DeviceEnrollmentError ? error.kind : "failed";
      setPreview({
        status: "unreadable",
        outcome: kind === "unknown-code" ? "unknown-code" : "failed",
        message: error instanceof Error ? error.message : "Could not read this connection request.",
      });
    }
  }, [code]);

  // Only once there is somebody to answer as. Reading it while signed out would
  // hand the label and address of a machine to anyone holding the code.
  useEffect(() => {
    if (!authenticated) {
      return;
    }
    void load();
  }, [authenticated, load]);

  /**
   * Asked once, in the background, and never blocking the decision.
   *
   * Nothing on this page waits for it: the answer only changes a sentence on
   * the screen *after* Connect, and a person must never be kept from approving
   * their own machine because a provider lookup is slow or the route is not
   * served here at all.
   */
  useEffect(() => {
    if (!authenticated) {
      return;
    }
    let cancelled = false;
    void fetchProviderAccountConnected().then((connected) => {
      if (!cancelled) {
        setProviderAccountConnected(connected);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [authenticated]);

  const outcome =
    preview.status === "ready"
      ? readEnrollmentOutcome(preview.preview, nowMs)
      : preview.status === "unreadable" && preview.outcome === "unknown-code"
        ? "unknown-code"
        : null;
  const advice = outcome === null ? null : describeEnrollmentOutcome(outcome);
  const deciding = decision.status === "approving" || decision.status === "denying";

  useEffect(() => {
    if (outcome !== "pending") {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [outcome]);

  const decide = useCallback(
    async (intent: "approve" | "deny") => {
      if (code === null) {
        return;
      }
      setDecision({ status: intent === "approve" ? "approving" : "denying" });
      try {
        if (intent === "deny") {
          await denyDeviceEnrollment(code);
          setDecision({ status: "denied" });
          return;
        }
        // The server's answer, not this page's: a server that predates roles
        // files the machine as a workspace host whatever this browser sent, and
        // the screen must describe what actually happened.
        setDecision({
          status: "approved",
          machineRole: await approveDeviceEnrollment(code, machineRole),
        });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : "That did not go through.";
        if (error instanceof DeviceEnrollmentError && error.kind === "signed-out") {
          setDecision({ status: "signed-out", message });
          return;
        }
        setDecision({ status: "refused", message });
        // Whatever the server now says is the truth; the page was working from
        // a status that has moved on.
        await load();
      }
    },
    [code, load, machineRole],
  );

  if (code === null) {
    return (
      <ConnectShell>
        <Dead
          title="This link is missing its code"
          detail="There is no connection request in this address, so there is nothing here to approve."
          advice="Start again on the machine: launch the app and ask to connect, and let it open this page itself."
        />
      </ConnectShell>
    );
  }

  // Sign-in first, and back to this exact address afterwards — a full reload of
  // the current URL, code and all. Dropping the code here is the bug that
  // stranded share recipients on "link is missing" at the last step, and it is
  // the same shape of mistake: the credential the page needs is the session,
  // and the thing it must not lose on the way is the code.
  if (!authenticated) {
    return (
      <PairingRouteSurface
        auth={authGateState.auth}
        onAuthenticated={() => {
          window.location.assign(window.location.href);
        }}
        {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
      />
    );
  }

  if (decision.status === "approved") {
    return (
      <ConnectShell>
        <div className="mt-4" data-testid="device-connect-approved">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle2Icon className="size-4" />
            Machine connected
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            {preview.status === "ready"
              ? `${describeMachineLabel(preview.preview.deviceLabel)} is now part of your account.`
              : "That machine is now part of your account."}{" "}
            It picks up its session on its own — give it a moment to appear in your machines, and
            keep the app open on it meanwhile.
          </p>
          {/* The one place a connected machine leads somebody into provider
              setup, and therefore the one place a runner has to be exempt.
              What to say is decided by a shared pure function rather than by
              this branch, so the server and this screen cannot disagree about
              whether a deploy box gets asked to log into Claude. */}
          <ProviderSetupNote
            machineRole={decision.machineRole}
            connected={providerAccountConnected}
          />
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            You can cut it off again at any time under Settings → Connections.
          </p>
          <Button
            className="mt-4"
            size="sm"
            onClick={() => window.location.assign("/environments")}
          >
            See your machines
          </Button>
        </div>
      </ConnectShell>
    );
  }

  if (decision.status === "denied") {
    return (
      <ConnectShell>
        <div className="mt-4" data-testid="device-connect-denied">
          <div className="flex items-center gap-2 text-sm font-medium">
            <XCircleIcon className="size-4" />
            Request turned down
          </div>
          <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
            Nothing was granted, and this code cannot be approved later — a refusal is final.
          </p>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
            If you did not start this yourself, somebody else knows enough about your account to
            try. Changing your password is the useful next step.
          </p>
          <Button className="mt-4" size="sm" onClick={() => window.location.assign("/")}>
            Back to the app
          </Button>
        </div>
      </ConnectShell>
    );
  }

  if (decision.status === "signed-out") {
    return (
      <ConnectShell>
        <Dead
          title="Your session ended before that went through"
          detail={decision.message}
          advice="Nothing was decided. Sign in again and this page comes straight back with the same request."
        />
        <Button
          className="mt-4"
          size="sm"
          onClick={() => window.location.assign(window.location.href)}
        >
          Sign in again
        </Button>
      </ConnectShell>
    );
  }

  if (preview.status === "loading") {
    return (
      <ConnectShell>
        <Pending title="Reading this request" detail="Finding out which machine is asking." />
      </ConnectShell>
    );
  }

  if (preview.status === "unreadable" && preview.outcome === "failed") {
    return (
      <ConnectShell>
        <Dead
          title="Could not read this request"
          detail={preview.message}
          advice="Nothing has been approved. Reload to try again — the request is still waiting if it has not run out of time."
        />
        <Button className="mt-4" size="sm" variant="outline" onClick={() => void load()}>
          Try again
        </Button>
      </ConnectShell>
    );
  }

  if (advice === null) {
    return (
      <ConnectShell>
        <Pending title="Reading this request" detail="Finding out which machine is asking." />
      </ConnectShell>
    );
  }

  return (
    <ConnectShell>
      <div className="mt-4 flex items-center gap-2">
        {advice.tone === "decide" ? (
          <ShieldQuestionMarkIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : advice.tone === "positive" ? (
          <CheckCircle2Icon className="size-4 shrink-0 text-muted-foreground" />
        ) : advice.tone === "warning" ? (
          <ClockIcon className="size-4 shrink-0 text-muted-foreground" />
        ) : (
          <XCircleIcon className="size-4 shrink-0 text-destructive" />
        )}
        <h1 className="text-base font-semibold" data-testid="device-connect-title">
          {advice.title}
        </h1>
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{advice.detail}</p>

      {preview.status === "ready" ? (
        <dl
          className="mt-4 divide-y divide-border/60 rounded-lg border border-border bg-background/40 px-3"
          data-testid="device-connect-machine"
        >
          <DetailRow label="Machine" value={describeMachineLabel(preview.preview.deviceLabel)} />
          <DetailRow
            label="Platform"
            value={describeDevicePlatform(preview.preview.devicePlatform)}
          />
          <DetailRow label="Asked from" value={describeRequestedIp(preview.preview.requestedIp)} />
          <DetailRow
            label="Time left"
            value={formatEnrollmentTimeLeft(preview.preview.expiresAtMs, nowMs)}
          />
        </dl>
      ) : null}

      <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{advice.advice}</p>

      {decision.status === "refused" ? (
        <div
          className="mt-4 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive"
          data-testid="device-connect-refused"
        >
          {decision.message}
        </div>
      ) : null}

      {/* Asked before Connect, not after. The role decides whether the next
          screen walks this person into a provider login, and there is no later
          moment to ask: the code is spent the instant the machine collects. */}
      {advice.canApprove ? (
        <fieldset className="mt-4" data-testid="device-connect-role">
          <legend className="text-xs text-muted-foreground">What is this machine for?</legend>
          <div className="mt-2 space-y-2">
            {MACHINE_ROLE_CHOICES.map((choice) => (
              <label
                className={cn(
                  "flex cursor-pointer gap-2 rounded-lg border px-3 py-2 text-left",
                  machineRole === choice.role
                    ? "border-foreground/40 bg-muted/50"
                    : "border-border bg-background/40",
                )}
                key={choice.role}
              >
                <input
                  checked={machineRole === choice.role}
                  className="mt-1 shrink-0"
                  disabled={deciding}
                  name="machine-role"
                  onChange={() => setMachineRole(choice.role)}
                  type="radio"
                  value={choice.role}
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{choice.title}</span>
                  <span className="block text-xs leading-relaxed text-muted-foreground">
                    {choice.detail}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : null}

      {advice.canApprove || advice.canDeny ? (
        <div className="mt-5 flex flex-wrap gap-2">
          {advice.canApprove ? (
            <Button
              data-testid="device-connect-approve"
              disabled={deciding}
              onClick={() => void decide("approve")}
              size="lg"
            >
              {decision.status === "approving" ? (
                <Loader2Icon className="animate-spin" />
              ) : (
                <MonitorSmartphoneIcon />
              )}
              {decision.status === "approving" ? "Connecting…" : "Connect"}
            </Button>
          ) : null}
          {advice.canDeny ? (
            <Button
              data-testid="device-connect-deny"
              disabled={deciding}
              onClick={() => void decide("deny")}
              size="lg"
              variant="destructive-outline"
            >
              {decision.status === "denying" ? <Loader2Icon className="animate-spin" /> : null}
              {decision.status === "denying" ? "Denying…" : "Deny"}
            </Button>
          ) : null}
        </div>
      ) : (
        <Button className="mt-5" size="sm" onClick={() => window.location.assign("/environments")}>
          See your machines
        </Button>
      )}
    </ConnectShell>
  );
}

function ConnectShell({ children }: { readonly children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground"
      data-testid="device-connect"
    >
      <section className="w-full max-w-md rounded-lg border border-border bg-card p-6 shadow-sm">
        <p className="text-sm font-semibold">{APP_DISPLAY_NAME}</p>
        {children}
      </section>
    </div>
  );
}

/**
 * What the machine still needs, if anything, once it is connected.
 *
 * A runner's sentence is deliberately drawn in the same slot as the workspace
 * host's prompt rather than left out. Somebody who has connected a laptop
 * before expects to be told about a provider account here; silence would read
 * as a screen that failed to finish, and the exemption is the feature.
 */
function ProviderSetupNote({
  machineRole,
  connected,
}: {
  readonly machineRole: MachineRole;
  readonly connected: boolean;
}) {
  const prompt = decideProviderSetupPrompt({
    machine: { role: machineRole },
    providerAccountConnected: connected,
  });
  if (prompt.message === null) {
    return null;
  }
  return (
    <p
      className="mt-3 text-sm leading-relaxed text-muted-foreground"
      data-testid={prompt.ask ? "device-connect-provider-prompt" : "device-connect-provider-exempt"}
    >
      {prompt.message}
    </p>
  );
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Pending({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <div className="mt-4" data-testid="device-connect-pending">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Loader2Icon className="size-4 animate-spin text-muted-foreground" />
        {title}
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{detail}</p>
    </div>
  );
}

function Dead({
  title,
  detail,
  advice,
}: {
  readonly title: string;
  readonly detail: string;
  readonly advice: string;
}) {
  return (
    <div className="mt-4" data-testid="device-connect-dead">
      <div className="flex items-center gap-2 text-sm font-medium">
        <XCircleIcon className="size-4 text-destructive" />
        {title}
      </div>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{detail}</p>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{advice}</p>
    </div>
  );
}
