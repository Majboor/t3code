import { createFileRoute } from "@tanstack/react-router";

import { DesktopDownloadSurface } from "../components/devices/DesktopDownloadSurface";

/**
 * `/download` — the app itself, for the machine that is going to become an
 * environment.
 *
 * Ungated on purpose. The people who most need it are the two who cannot get
 * past a sign-in gate to a downloads page: somebody whose browser has just been
 * refused by the environment it was served from, and somebody who has not
 * installed anything yet. Signed in, it draws inside the shell so the sidebar
 * stays where it was.
 */
export const Route = createFileRoute("/download")({
  beforeLoad: ({ context }) => ({ authGateState: context.authGateState }),
  component: DownloadRouteView,
});

function DownloadRouteView() {
  const { authGateState } = Route.useRouteContext();

  return (
    <DesktopDownloadSurface
      variant={authGateState.status === "authenticated" ? "page" : "standalone"}
    />
  );
}
