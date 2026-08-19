import { ShieldAlertIcon } from "lucide-react";

import { Alert, AlertDescription } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogPortal,
  AlertDialogTitle,
  AlertDialogViewport,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { WORKSPACE_SHARE_EXPOSURE_WARNING } from "./workspaceSharing.logic";

/**
 * The one place a tunnel can be started from, wherever the button lives.
 *
 * Every entry point has to state the exposure before it happens, and consent
 * copy that is duplicated per surface is consent copy that drifts until one
 * surface is quietly weaker than the other.
 */
export function WorkspaceShareConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  testId = "workspace-sharing-confirm",
  confirmTestId = "workspace-sharing-confirm-start",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  testId?: string;
  confirmTestId?: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogPortal>
        <AlertDialogViewport>
          <AlertDialogPopup className="max-w-md" data-testid={testId}>
            <AlertDialogHeader>
              <AlertDialogTitle>Put this workspace on the internet?</AlertDialogTitle>
              <AlertDialogDescription>{WORKSPACE_SHARE_EXPOSURE_WARNING}</AlertDialogDescription>
            </AlertDialogHeader>
            <Alert variant="warning" className="mx-4">
              <ShieldAlertIcon aria-hidden />
              <AlertDescription>
                The link stays live until you stop sharing or quit the app, and a new link is issued
                every time you start again.
              </AlertDescription>
            </Alert>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button onClick={onConfirm} data-testid={confirmTestId}>
                Start sharing
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialogViewport>
      </AlertDialogPortal>
    </AlertDialog>
  );
}
