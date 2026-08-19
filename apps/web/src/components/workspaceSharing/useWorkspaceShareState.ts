import type { DesktopWorkspaceShareState } from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { createIdleWorkspaceShareState } from "./workspaceSharing.logic";

export interface WorkspaceShareController {
  readonly state: DesktopWorkspaceShareState;
  /** False in the browser build, where the bridge that owns the tunnel is absent. */
  readonly isDesktop: boolean;
  readonly actionError: string | null;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/**
 * One subscription to the tunnel, shared by everything that shows it.
 *
 * The state is process-wide — there is one tunnel per machine, not one per panel
 * — so two views of it that each keep their own copy will disagree the moment a
 * tunnel is started somewhere else in the app.
 */
export function useWorkspaceShareState(): WorkspaceShareController {
  const [state, setState] = useState<DesktopWorkspaceShareState>(createIdleWorkspaceShareState);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge || typeof bridge.getWorkspaceShareState !== "function") return;

    let cancelled = false;
    void bridge.getWorkspaceShareState().then(
      (next) => {
        if (!cancelled) setState(next);
      },
      () => {},
    );

    const unsubscribe = bridge.onWorkspaceShareState?.((next) => {
      setState(next);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  const start = useCallback(async () => {
    setActionError(null);
    const bridge = window.desktopBridge;
    if (!bridge) return;
    try {
      setState(await bridge.startWorkspaceShare());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  const stop = useCallback(async () => {
    setActionError(null);
    const bridge = window.desktopBridge;
    if (!bridge) return;
    try {
      setState(await bridge.stopWorkspaceShare());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, []);

  return {
    state,
    isDesktop: typeof window !== "undefined" && window.desktopBridge !== undefined,
    actionError,
    start,
    stop,
  };
}
