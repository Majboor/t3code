import type { ReactElement } from "react";
import { useState } from "react";

import type { SavedEnvironmentRecord } from "~/environments/runtime";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { toastManager } from "../ui/toast";
import { AddEnvironmentForm } from "./AddEnvironmentForm";

/**
 * The add-environment surface as a dialog, for places that already have their
 * own page — the connections settings, mainly. Same form, same wording, same
 * failure states as the standalone `/environments` route.
 */
export function AddEnvironmentDialog({
  trigger,
  onAdded,
}: {
  readonly trigger: ReactElement;
  readonly onAdded?: (record: SavedEnvironmentRecord) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger} />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Add an environment</DialogTitle>
          <DialogDescription>
            An environment is a machine running the T3 server. Run t3 there and it prints a pairing
            link and a code — either one gets you in.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <AddEnvironmentForm
            autoFocus
            onAdded={(record) => {
              setOpen(false);
              toastManager.add({
                type: "success",
                title: "Environment connected",
                description: `${record.label} will reconnect on its own whenever that machine is running.`,
              });
              onAdded?.(record);
            }}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
