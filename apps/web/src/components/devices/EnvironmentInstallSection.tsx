import { CheckIcon, CopyIcon, ServerIcon, TriangleAlertIcon } from "lucide-react";
import { useMemo } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import { SurfaceSection } from "../SurfaceShell";
import { Button } from "../ui/button";
import {
  describeEnvironmentInstallCaveats,
  describeEnvironmentInstallLine,
  ENVIRONMENT_INSTALL_SCRIPT_PATH,
} from "./environmentInstall.logic";

/**
 * The other way to connect a machine, for the machine that cannot be handed an
 * app.
 *
 * Both surfaces that offer "connect a machine" show this next to the desktop
 * download, because the two audiences are genuinely different and neither is a
 * fallback for the other. A laptop wants a `.dmg` and a button. A VPS has no
 * desktop, no browser and nobody sitting at it — it wants a line, and the line
 * is what somebody types at an SSH prompt they already have open.
 *
 * The address is not hardcoded and not a release CDN: it is whatever server
 * this browser is talking to, which is also the hub the installed box will
 * enroll into. The server bakes that same origin into the script it serves, so
 * the pasted line is the whole configuration — no flag, no address to remember,
 * no chance of pointing a box at the wrong hub by mistyping one.
 *
 * @module EnvironmentInstallSection
 */
export function EnvironmentInstallSection() {
  const line = useMemo(() => {
    let scriptUrl: string | null = null;
    try {
      scriptUrl = resolvePrimaryEnvironmentHttpUrl(ENVIRONMENT_INSTALL_SCRIPT_PATH);
    } catch {
      // No primary environment resolved yet — a browser that has not been
      // pointed at a server. There is no address to print, so nothing is
      // printed; the section below says that rather than inventing one.
      scriptUrl = null;
    }
    return describeEnvironmentInstallLine(scriptUrl);
  }, []);

  const caveats = useMemo(() => describeEnvironmentInstallCaveats(line), [line]);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>();

  return (
    <SurfaceSection
      title="Or connect a server over SSH"
      description="For a VPS or a box with no desktop: one line, pasted at a root shell on that machine."
      data-testid="environment-install-section"
    >
      <div className="space-y-4 px-4 py-4 sm:px-5">
        <p className="text-sm leading-relaxed text-muted-foreground">
          This installs the server as a systemd service and asks to join your account, exactly like
          the app does. The address of this server is already written into the script, so there is
          nothing else to fill in — you approve the machine here when it asks.
        </p>

        {line === null ? (
          <p
            className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2 text-sm leading-relaxed text-muted-foreground"
            data-testid="environment-install-no-address"
          >
            This browser has not settled on a server address yet, so there is no line to copy.
            Connect an environment first and it appears here.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-border/70 bg-muted/45 px-3 py-2 font-mono text-xs whitespace-pre text-foreground"
              data-testid="environment-install-command"
            >
              {line.command}
            </code>
            <Button
              data-testid="environment-install-copy"
              disabled={isCopied}
              onClick={() => copyToClipboard(line.command)}
              size="sm"
              type="button"
              variant="outline"
            >
              {isCopied ? <CheckIcon className="text-success" /> : <CopyIcon />}
              {isCopied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ServerIcon className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Read it before you run it — <code className="font-mono">curl -fsSL …/install.sh</code>{" "}
            on its own prints the script, and <code className="font-mono">--dry-run</code> prints
            the plan and changes nothing. Anyone offering a pipe-to-shell line owes you that.
          </span>
        </p>

        {caveats.length > 0 ? (
          <ul className="space-y-2" data-testid="environment-install-caveats">
            {caveats.map((caveat) => (
              <li
                className="rounded-lg border border-border/70 bg-muted/35 px-3 py-2"
                key={caveat.title}
              >
                <div className="flex items-center gap-2">
                  <TriangleAlertIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">{caveat.title}</span>
                </div>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  {caveat.detail}
                </p>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </SurfaceSection>
  );
}
