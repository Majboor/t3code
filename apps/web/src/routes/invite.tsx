import { InviteId, type EnvironmentApi } from "@t3tools/contracts";
import { CheckCircle2Icon, Loader2Icon, XCircleIcon } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { PairingPendingSurface, PairingRouteSurface } from "../components/auth/PairingRouteSurface";
import { Button } from "../components/ui/button";
import { readEnvironmentApi } from "../environmentApi";
import {
  ensureEnvironmentConnectionBootstrapped,
  startEnvironmentConnectionService,
} from "../environments/runtime";
import {
  signOutLocalServerSession,
  submitServerAuthCredential,
  takePairingTokenFromUrl,
  usePrimaryEnvironmentId,
} from "../environments/primary";

export const Route = createFileRoute("/invite")({
  beforeLoad: async ({ context }) => {
    return {
      authGateState: context.authGateState,
    };
  },
  component: InviteRouteView,
  pendingComponent: PairingPendingSurface,
});

function InviteRouteView() {
  const { authGateState } = Route.useRouteContext();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const environmentId = usePrimaryEnvironmentId();
  const inviteId = useMemo(() => {
    const searchParams = new URLSearchParams(searchStr);
    const value = searchParams.get("inviteId") ?? searchParams.get("invite");
    return value && value.trim().length > 0 ? InviteId.make(value) : null;
  }, [searchStr]);
  const [state, setState] = useState<
    | { status: "idle" | "accepting" }
    | { status: "accepted"; email: string }
    | { status: "failed"; message: string }
  >({ status: "idle" });
  const setupCredentialExchangeRef = useRef<Promise<void> | null>(null);
  const retryWithAnotherAccount = async () => {
    await signOutLocalServerSession().catch(() => undefined);
    window.location.assign(window.location.href);
  };

  useEffect(() => {
    if (authGateState.status !== "authenticated" || !environmentId || !inviteId) {
      return;
    }
    let disposed = false;
    let stopConnectionService: (() => void) | undefined;
    setState({ status: "accepting" });

    void (async () => {
      try {
        const setupToken = takePairingTokenFromUrl();
        if (setupToken || setupCredentialExchangeRef.current) {
          const exchangePromise =
            setupCredentialExchangeRef.current ??
            submitServerAuthCredential(setupToken ?? "").finally(() => {
              setupCredentialExchangeRef.current = null;
            });
          setupCredentialExchangeRef.current = exchangePromise;
          try {
            await exchangePromise;
            if (!disposed) {
              window.location.assign(window.location.href);
            }
            return;
          } catch (error) {
            if (!isInvalidBootstrapCredentialError(error)) {
              throw error;
            }
          }
        }
        let api = readEnvironmentApi(environmentId);
        if (!api) {
          stopConnectionService = startEnvironmentConnectionService(queryClient);
          await ensureEnvironmentConnectionBootstrapped(environmentId);
          api = readEnvironmentApi(environmentId);
        }
        if (!api) {
          throw new Error("Environment API was not ready for invite acceptance.");
        }

        const result = await acceptAnyInvite(api, inviteId);
        if (disposed) return;
        setState({ status: "accepted", email: result.invite.email });
      } catch (error) {
        if (disposed) return;
        setState({
          status: "failed",
          message: error instanceof Error ? error.message : "Could not accept this invite.",
        });
      }
    })();

    return () => {
      disposed = true;
      stopConnectionService?.();
    };
  }, [authGateState.status, environmentId, inviteId, queryClient]);

  if (!authGateState) {
    return null;
  }

  if (authGateState.status === "authenticated") {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground">
        <section className="w-full max-w-md rounded-lg border border-border bg-card p-5">
          {!inviteId ? (
            <>
              <XCircleIcon className="size-5 text-destructive" />
              <h1 className="mt-3 text-base font-semibold">Invite link is missing</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Ask the sender for a fresh invite link.
              </p>
            </>
          ) : state.status === "accepted" ? (
            <>
              <CheckCircle2Icon className="size-5 text-foreground" />
              <h1 className="mt-3 text-base font-semibold">Invite accepted</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {state.email} now has access. You can return to the workspace.
              </p>
            </>
          ) : state.status === "failed" ? (
            <>
              <XCircleIcon className="size-5 text-destructive" />
              <h1 className="mt-3 text-base font-semibold">Invite could not be accepted</h1>
              <p className="mt-1 text-sm text-muted-foreground">{state.message}</p>
            </>
          ) : (
            <>
              <Loader2Icon className="size-5 animate-spin text-muted-foreground" />
              <h1 className="mt-3 text-base font-semibold">Accepting invite</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                Keep this window open while access is confirmed.
              </p>
            </>
          )}
          <div className="mt-5">
            {state.status === "accepted" ? (
              <Button size="sm" onClick={() => window.location.assign("/")}>
                Back to app
              </Button>
            ) : state.status === "failed" ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void retryWithAnotherAccount()}>
                  Use another account
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigate({ to: "/", replace: true })}
                >
                  Back to app
                </Button>
              </div>
            ) : (
              <Button size="sm" onClick={() => void navigate({ to: "/", replace: true })}>
                Back to app
              </Button>
            )}
          </div>
        </section>
      </div>
    );
  }

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

async function acceptAnyInvite(api: EnvironmentApi, inviteId: InviteId) {
  if (api.organizations?.acceptEmployeeInvite) {
    try {
      return await api.organizations.acceptEmployeeInvite({ inviteId });
    } catch (error) {
      if (!isInviteNotFoundError(error)) {
        throw error;
      }
    }
  }

  return api.collaboration.acceptInvite({ inviteId });
}

function isInviteNotFoundError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /\binvite\b.*\bnot found\b/i.test(error.message);
}

function isInvalidBootstrapCredentialError(error: unknown): boolean {
  return error instanceof Error && /\binvalid bootstrap credential\b/i.test(error.message);
}
