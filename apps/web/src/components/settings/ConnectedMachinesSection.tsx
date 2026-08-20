import { RefreshCwIcon } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useState } from "react";

import {
  AccountMachineError,
  disconnectAccountMachine,
  fetchAccountMachines,
} from "../devices/accountMachines";
import {
  describeAccountMachine,
  describeDisconnectConfirmation,
  formatMachineLastSeen,
  sortAccountMachines,
  type AccountMachine,
} from "../devices/accountMachines.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsSection, useRelativeTimeTick } from "./settingsLayout";

/**
 * The machines this account has handed a credential to, and the button that
 * takes one back.
 *
 * It lives beside the pairing links and client sessions because it answers the
 * same question they do — who can reach my work — but from the account's side
 * rather than one backend's. A pairing link is about this machine letting
 * others in; this list is about everywhere the account itself is signed in, and
 * it is the only surface that can answer "I lost my laptop".
 *
 * Which is why the Disconnect here goes through a confirmation that names the
 * machine and spells out the consequence. Revoking is immediate, total and not
 * undoable from the other side: the machine has to be approved again from
 * scratch. A one-click version of that in a list of near-identical rows is a
 * trap, and the row a person is most likely to misclick is their own.
 */

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

type ConnectedMachineRowProps = {
  machine: AccountMachine;
  isDisconnecting: boolean;
  onRequestDisconnect: (machine: AccountMachine) => void;
};

const ConnectedMachineRow = memo(function ConnectedMachineRow({
  machine,
  isDisconnecting,
  onRequestDisconnect,
}: ConnectedMachineRowProps) {
  const described = describeAccountMachine(machine);
  const lastSeen = formatMachineLastSeen(machine.lastSeenAt);

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{described.title}</h3>
            {machine.current ? (
              <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground/80">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[described.detail, lastSeen].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {/* Never offered for the current device: the first thing a Disconnect
              button in a list of look-alikes does is sign somebody out of the
              page they would have used to undo it. */}
          {machine.current ? null : (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={isDisconnecting}
              onClick={() => onRequestDisconnect(machine)}
            >
              {isDisconnecting ? "Disconnecting…" : "Disconnect"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
});

export function ConnectedMachinesSection() {
  const [machines, setMachines] = useState<ReadonlyArray<AccountMachine>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<AccountMachine | null>(null);
  const [disconnectingMachineId, setDisconnectingMachineId] = useState<string | null>(null);

  // "Last seen 3 minutes ago" is only true while the page is watching the
  // clock; without this it silently ages into a lie.
  useRelativeTimeTick(30_000);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const listed = await fetchAccountMachines();
      setMachines(listed);
      setLoadError(null);
    } catch (error) {
      const message =
        error instanceof AccountMachineError
          ? error.message
          : "Could not list the machines connected to your account.";
      setLoadError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleConfirmDisconnect = useCallback(async () => {
    const machine = pendingDisconnect;
    if (machine === null) return;
    setDisconnectingMachineId(machine.machineId);
    try {
      await disconnectAccountMachine(machine.machineId);
      // Dropped locally as well as re-fetched: the row is gone the instant the
      // server says the credential is, and a person watching for that should
      // not have to trust a round trip to believe it.
      setMachines((current) => current.filter((entry) => entry.machineId !== machine.machineId));
      setPendingDisconnect(null);
      toastManager.add({
        type: "success",
        title: "Machine disconnected",
        description: `${describeAccountMachine(machine).title} can no longer reach this account.`,
      });
      await load();
    } catch (error) {
      const message =
        error instanceof AccountMachineError ? error.message : "Could not disconnect that machine.";
      toastManager.add({
        type: "error",
        title: "Could not disconnect that machine",
        description: message,
      });
    } finally {
      setDisconnectingMachineId(null);
    }
  }, [load, pendingDisconnect]);

  const sorted = useMemo(() => sortAccountMachines(machines), [machines]);
  const confirmation = pendingDisconnect ? describeDisconnectConfirmation(pendingDisconnect) : null;

  return (
    <SettingsSection
      title="Connected machines"
      headerAction={
        <Button size="xs" variant="ghost" disabled={isLoading} onClick={() => void load()}>
          <RefreshCwIcon className="size-3" />
          Refresh
        </Button>
      }
    >
      {loadError ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-destructive">{loadError}</p>
        </div>
      ) : null}

      {sorted.map((machine) => (
        <ConnectedMachineRow
          key={machine.machineId}
          machine={machine}
          isDisconnecting={disconnectingMachineId === machine.machineId}
          onRequestDisconnect={setPendingDisconnect}
        />
      ))}

      {sorted.length === 0 && !isLoading && loadError === null ? (
        <div className={ITEM_ROW_CLASSNAME}>
          <p className="text-xs text-muted-foreground">
            No machines are connected to this account yet. Launching the desktop app and approving
            it adds it here.
          </p>
        </div>
      ) : null}

      <AlertDialog
        open={pendingDisconnect !== null}
        onOpenChange={(open) => {
          if (disconnectingMachineId !== null) return;
          if (!open) setPendingDisconnect(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmation?.title ?? "Disconnect this machine?"}</AlertDialogTitle>
            <AlertDialogDescription>{confirmation?.description ?? ""}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={disconnectingMachineId !== null}
              render={<Button variant="outline" disabled={disconnectingMachineId !== null} />}
            >
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={disconnectingMachineId !== null}
              onClick={() => void handleConfirmDisconnect()}
            >
              {disconnectingMachineId !== null ? "Disconnecting…" : "Disconnect"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
