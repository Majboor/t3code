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
  describeMachineRole,
  formatMachineLastSeen,
  sortAccountMachines,
  type AccountMachine,
} from "../devices/accountMachines.logic";
import { describeMachineRoleChange } from "../devices/deviceEnrollment.logic";
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
 *
 * Every row carries its role for the same reason. "My laptop" and "my deploy
 * box" are the two things on this list somebody most needs to tell apart before
 * pressing Disconnect, and until the badge existed they were the two rows most
 * likely to look identical — same account, same platform, similar name.
 *
 * The badge also used to be a dead end. It is the one field on the row a person
 * is likely to disagree with — approving a deploy box as a workspace takes one
 * mis-click and then asks its owner for a Claude account forever — and the row
 * said nothing about what to do next. Each row now opens, in place, onto what
 * the other role would mean, what this one is costing, and the steps that move
 * it. The steps are a procedure rather than a control because the role is
 * written by an approval and nothing edits it afterwards; a control here would
 * have to invent a route that does not exist, and a button that fails on press
 * is worse than a row that explains itself.
 *
 * None of this is a permission. The role says what a machine is *for*, and it
 * must never become a boundary: `decideProviderAccount` does not read it, and a
 * turn dispatched from either kind of machine still resolves a real per-user
 * credential or is refused. Everything on this panel is about what the product
 * asks for, never about what a session may reach.
 */

const ITEM_ROW_CLASSNAME = "border-t border-border/60 px-4 py-4 first:border-t-0 sm:px-5";

const ITEM_ROW_INNER_CLASSNAME =
  "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between";

type ConnectedMachineRowProps = {
  machine: AccountMachine;
  isDisconnecting: boolean;
  /** Whether this row's role panel is the open one. At most one is. */
  isRoleOpen: boolean;
  onToggleRole: (machineId: string) => void;
  onRequestDisconnect: (machine: AccountMachine) => void;
};

const ConnectedMachineRow = memo(function ConnectedMachineRow({
  machine,
  isDisconnecting,
  isRoleOpen,
  onToggleRole,
  onRequestDisconnect,
}: ConnectedMachineRowProps) {
  const described = describeAccountMachine(machine);
  const role = describeMachineRole(machine.role);
  const roleChange = describeMachineRoleChange(machine.role);
  const otherRole = describeMachineRole(roleChange.otherRole);
  const lastSeen = formatMachineLastSeen(machine.lastSeenAt);
  const rolePanelId = `machine-role-panel-${machine.machineId}`;

  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium text-foreground">{described.title}</h3>
            {/* Always drawn, for both roles. A badge that appeared only on
                runners would make its absence carry meaning, and absence on
                this page already means "an older server said nothing" — which
                is a different thing from "this is a workspace".

                It is also the control. A person who disagrees with a role
                reaches for the thing that states it, not for a separate word
                further along the row, so making the badge itself open the role
                panel puts the way in where it is already being looked at. */}
            <button
              type="button"
              className="shrink-0 rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground/80 hover:border-border hover:text-foreground"
              title={role.detail}
              aria-expanded={isRoleOpen}
              aria-controls={rolePanelId}
              data-testid="machine-role"
              onClick={() => onToggleRole(machine.machineId)}
            >
              {role.badge}
            </button>
            {machine.current ? (
              <span className="rounded-md border border-border/50 bg-muted/50 px-1 py-0.5 text-[10px] text-muted-foreground/80">
                This device
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {[role.detail, described.detail, lastSeen].join(" · ")}
          </p>
        </div>
        <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto sm:justify-end">
          {/* Spelled out as well as sitting on the badge, because "Workspace"
              does not read as something you can press. Offered on the current
              device too: the machine you are reading this on is as likely to
              have been approved as the wrong kind as any other. */}
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={isRoleOpen}
            aria-controls={rolePanelId}
            data-testid="machine-role-toggle"
            onClick={() => onToggleRole(machine.machineId)}
          >
            {isRoleOpen ? "Hide role" : "Change role"}
          </Button>
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
      {/* Steps first. Somebody who opened this already knows they want the other
          role; the reasoning underneath is for the person who is not sure yet. */}
      {isRoleOpen ? (
        <div
          id={rolePanelId}
          data-testid="machine-role-panel"
          className="mt-3 space-y-2 rounded-md border border-border/50 bg-muted/30 p-3"
        >
          <p className="text-xs text-muted-foreground">{roleChange.steps}</p>
          <p className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{otherRole.badge}</span>{" "}
            {roleChange.otherDetail}
          </p>
          <p className="text-xs text-muted-foreground">{roleChange.consequence}</p>
        </div>
      ) : null}
    </div>
  );
});

export function ConnectedMachinesSection() {
  const [machines, setMachines] = useState<ReadonlyArray<AccountMachine>>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingDisconnect, setPendingDisconnect] = useState<AccountMachine | null>(null);
  const [disconnectingMachineId, setDisconnectingMachineId] = useState<string | null>(null);
  /**
   * One panel at a time, held by id rather than by index. Ids survive the
   * refresh this page does on a timer and after a disconnect; an index does
   * not, and a list that re-sorts under an open panel would leave the
   * explanation of one machine's role attached to a different machine's row.
   */
  const [openRoleMachineId, setOpenRoleMachineId] = useState<string | null>(null);

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

  const handleToggleRole = useCallback((machineId: string) => {
    setOpenRoleMachineId((current) => (current === machineId ? null : machineId));
  }, []);

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
          isRoleOpen={openRoleMachineId === machine.machineId}
          onToggleRole={handleToggleRole}
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
