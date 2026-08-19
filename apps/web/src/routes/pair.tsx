import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";

import { PairingPendingSurface, PairingRouteSurface } from "../components/auth/PairingRouteSurface";
import { canBrowserSatisfyAuthGate } from "../components/environments/environmentConnect.logic";
import { peekPairingTokenFromUrl } from "../environments/primary";

export const Route = createFileRoute("/pair")({
  beforeLoad: async ({ context }) => {
    const { authGateState } = context;
    if (authGateState.status === "authenticated") {
      throw redirect({ to: "/", replace: true });
    }
    // This page is correct for a device that genuinely holds a bootstrap
    // credential, and only then. Arriving empty-handed at an environment that
    // accepts nothing a browser can produce is the dead end — those visitors
    // belong on the surface that connects a machine of their own.
    if (!canBrowserSatisfyAuthGate(authGateState.auth) && peekPairingTokenFromUrl() === null) {
      throw redirect({ to: "/environments", replace: true });
    }
    return {
      authGateState,
    };
  },
  component: PairRouteView,
  pendingComponent: PairRoutePendingView,
});

function PairRouteView() {
  const { authGateState } = Route.useRouteContext();
  const navigate = useNavigate();

  if (!authGateState) {
    return null;
  }

  return (
    <PairingRouteSurface
      auth={authGateState.auth}
      onAuthenticated={() => {
        void navigate({ to: "/", replace: true });
      }}
      {...(authGateState.errorMessage ? { initialErrorMessage: authGateState.errorMessage } : {})}
    />
  );
}

function PairRoutePendingView() {
  return <PairingPendingSurface />;
}
