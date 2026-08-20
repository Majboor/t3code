import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { PairingPendingSurface } from "../components/auth/PairingRouteSurface";
import { DeviceConnectRoute } from "../components/devices/DeviceConnectRoute";
import { readDeviceEnrollmentCodeFromSearch } from "../components/devices/deviceEnrollment";

/**
 * `/connect?code=…` — where the desktop app sends the browser after it asks to
 * join an account.
 *
 * Deliberately not guarded like a private route, and for the same reason
 * `/share` is not: `resolvePrivateRouteRedirect` would bounce a signed-out
 * visitor to `/pair`, and this visitor has no pairing token — the machine that
 * opened this page is the thing that wants one. So the route owns its sign-in
 * and comes back to this address, code intact, once there is a session.
 *
 * It also has to survive `pending-membership`. Somebody who has just made an
 * account has no workspace yet, and a machine of their own is a reasonable
 * first thing to attach to it; bouncing them to `/invite` would drop the code
 * at the last step of a flow that was working.
 */
export const Route = createFileRoute("/connect")({
  beforeLoad: async ({ context }) => {
    return {
      authGateState: context.authGateState,
    };
  },
  component: ConnectRouteView,
  pendingComponent: PairingPendingSurface,
});

function ConnectRouteView() {
  const { authGateState } = Route.useRouteContext();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const code = useMemo(() => readDeviceEnrollmentCodeFromSearch(searchStr), [searchStr]);

  if (!authGateState) {
    return null;
  }

  return <DeviceConnectRoute authGateState={authGateState} code={code} />;
}
