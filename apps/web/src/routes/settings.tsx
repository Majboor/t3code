import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import {
  Outlet,
  createFileRoute,
  redirect,
  useCanGoBack,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { resolvePrivateRouteRedirect } from "../authRouting";
import { SettingsBreadcrumb } from "../components/settings/SettingsBreadcrumb";
import { useSettingsRestore } from "../components/settings/SettingsPanels";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

function SettingsContentLayout() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const [restoreSignal, setRestoreSignal] = useState(0);
  const { changedSettingLabels, restoreDefaults } = useSettingsRestore(() =>
    setRestoreSignal((value) => value + 1),
  );
  // Opening settings straight from the desktop menu, a bookmark or a reload
  // leaves no history to go back to, and `history.back()` would leave the app.
  const goBack = useCallback(() => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  }, [canGoBack, navigate]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        goBack();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [goBack]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls
          className="border-b border-border"
        >
          <div className="flex w-full min-w-0 items-center gap-2">
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Back to chat"
              title="Back to chat"
              className={isElectron ? "[-webkit-app-region:no-drag]" : undefined}
              onClick={goBack}
            >
              <ArrowLeftIcon className="size-4" />
            </Button>
            <SidebarTrigger
              className={
                isElectron
                  ? "size-7 shrink-0 md:hidden [-webkit-app-region:no-drag]"
                  : "size-7 shrink-0 md:hidden"
              }
            />
            <SettingsBreadcrumb pathname={pathname} />
            <div className="ms-auto flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={changedSettingLabels.length === 0}
                onClick={() => void restoreDefaults()}
              >
                <RotateCcwIcon className="size-3.5" />
                Restore defaults
              </Button>
            </div>
          </div>
        </WorkspacePageHeader>

        <div key={restoreSignal} className="min-h-0 flex flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}

function SettingsRouteLayout() {
  return <SettingsContentLayout />;
}

export const Route = createFileRoute("/settings")({
  beforeLoad: async ({ context, location }) => {
    const redirectTo = resolvePrivateRouteRedirect({ authGateState: context.authGateState });
    if (redirectTo) {
      throw redirect({ to: redirectTo, replace: true });
    }

    if (location.pathname === "/settings") {
      throw redirect({ to: "/settings/general", replace: true });
    }
  },
  component: SettingsRouteLayout,
});
