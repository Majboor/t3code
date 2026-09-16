import { Loader2Icon, MonitorSmartphoneIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type EnvironmentId } from "@t3tools/contracts";
import { SurfaceSection } from "../SurfaceShell";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { cn } from "../../lib/utils";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import { addRelayedEnvironment, listSavedEnvironmentRecords } from "~/environments/runtime";
import { describeRelayLinkState, fetchRelayLinks, type RelayLink } from "./relayLinks";

/**
 * The machines enrolled to the account — the other half of "Connect a machine".
 *
 * Enrollment puts the laptop in `account_machines`; the app on it then dials
 * this portal and claims an environment id, which is what shows up here. Open
 * routes the browser through the portal's relay, so the laptop needs no address
 * of its own. A closed app reads as offline rather than vanishing.
 */
export function AccountMachinesSection({
  onOpen,
}: {
  readonly onOpen?: (environmentId: EnvironmentId) => void;
}) {
  const [links, setLinks] = useState<ReadonlyArray<RelayLink> | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLinks(await fetchRelayLinks().catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  const open = useCallback(
    async (link: RelayLink) => {
      setOpening(link.environmentId);
      try {
        const saved = listSavedEnvironmentRecords().find(
          (record) => record.environmentId === link.environmentId,
        );
        if (!saved) {
          await addRelayedEnvironment({
            environmentId: link.environmentId,
            label: link.label,
            hubHttpBaseUrl: new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin,
          });
        }
        onOpen?.(link.environmentId as EnvironmentId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Could not open ${link.label}`,
          description: error instanceof Error ? error.message : "The request failed.",
        });
      } finally {
        setOpening(null);
      }
    },
    [onOpen],
  );

  return (
    <SurfaceSection
      title="Your machines"
      description="Computers enrolled to your account. Each one connects to this portal by itself while its app is open; Open reaches it through here."
    >
      <div className="px-4 py-3 sm:px-5" data-testid="account-machines">
        {links === null ? (
          <p className="text-sm text-muted-foreground">Looking for your machines…</p>
        ) : links.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="account-machines-empty">
            No machines yet. Install the app on a computer and approve it here, and it appears in this list.
          </p>
        ) : (
          <ul className="divide-y divide-border/60">
            {links.map((link) => {
              const state = describeRelayLinkState(link.state);
              const online = link.state === "connected";
              return (
                <li
                  key={link.environmentId}
                  className="flex flex-wrap items-center gap-3 py-2.5"
                  data-testid="account-machine-row"
                  data-environment-id={link.environmentId}
                  data-state={link.state}
                >
                  <MonitorSmartphoneIcon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{link.label}</div>
                    <div
                      className={cn(
                        "text-xs",
                        state.tone === "good"
                          ? "text-emerald-600 dark:text-emerald-400"
                          : state.tone === "warn"
                            ? "text-amber-600 dark:text-amber-400"
                            : "text-muted-foreground",
                      )}
                      data-testid="account-machine-state"
                    >
                      {state.label}
                    </div>
                  </div>
                  <Button
                    data-testid="account-machine-open"
                    disabled={!online || opening === link.environmentId}
                    onClick={() => void open(link)}
                    size="sm"
                    title={online ? undefined : "Open the app on that machine first."}
                  >
                    {opening === link.environmentId ? <Loader2Icon className="animate-spin" /> : null}
                    Open
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-2 flex justify-end">
          <Button data-testid="account-machines-refresh" onClick={() => void refresh()} size="xs" variant="ghost">
            <RefreshCwIcon />
            Refresh
          </Button>
        </div>
      </div>
    </SurfaceSection>
  );
}
