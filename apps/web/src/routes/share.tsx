import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useMemo } from "react";

import { ShareJoinRoute } from "../components/shareLinks/ShareJoinRoute";
import { readShareLinkTokenFromSearch } from "../components/shareLinks/shareJoin";

/**
 * `/share?s=<token>` — where `/s/<token>` sends a workspace link.
 *
 * Deliberately not guarded like a private route. `resolvePrivateRouteRedirect`
 * would bounce an unauthenticated visitor to `/pair`, which is the pairing-token
 * screen — the exact dead end this whole route exists to remove. A share
 * recipient has no pairing token and no way to obtain one, so this page owns its
 * own sign-in and never delegates to that surface.
 *
 * It also has to be exempt from the pending-membership redirect to `/invite`,
 * for the same reason in the opposite direction: somebody who has just signed up
 * *has* no membership yet — acquiring one is what they came here to do.
 */
export const Route = createFileRoute("/share")({
  beforeLoad: async ({ context }) => {
    return {
      authGateState: context.authGateState,
    };
  },
  component: ShareRouteView,
  pendingComponent: ShareRoutePendingView,
});

function ShareRouteView() {
  const { authGateState } = Route.useRouteContext();
  const searchStr = useLocation({ select: (location) => location.searchStr });
  const token = useMemo(() => readShareLinkTokenFromSearch(searchStr), [searchStr]);

  if (!authGateState) {
    return null;
  }

  return <ShareJoinRoute authGateState={authGateState} token={token} />;
}

function ShareRoutePendingView() {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-background px-4 py-10 text-foreground" />
  );
}
