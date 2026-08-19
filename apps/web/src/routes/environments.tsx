import { createFileRoute } from "@tanstack/react-router";

import { EnvironmentsSurface } from "../components/environments/EnvironmentsSurface";
import { canBrowserSatisfyAuthGate } from "../components/environments/environmentConnect.logic";

const GATE_EXPLANATION =
  "The environment that served this page only admits its own desktop app, so there is no code this browser could paste. Connect a machine of your own below instead.";

/**
 * `/environments` — the web app's front door onto machines.
 *
 * Deliberately not gated behind `resolvePrivateRouteRedirect`: the session that
 * most needs this page is the one that has just been refused by the
 * environment it was served from, and bouncing it to `/pair` is the dead end
 * this route exists to end.
 */
export const Route = createFileRoute("/environments")({
  beforeLoad: ({ context }) => ({ authGateState: context.authGateState }),
  component: EnvironmentsRouteView,
});

function EnvironmentsRouteView() {
  const { authGateState } = Route.useRouteContext();

  if (authGateState.status === "authenticated") {
    return <EnvironmentsSurface variant="page" />;
  }

  return (
    <EnvironmentsSurface
      variant="standalone"
      gateExplanation={canBrowserSatisfyAuthGate(authGateState.auth) ? null : GATE_EXPLANATION}
    />
  );
}
