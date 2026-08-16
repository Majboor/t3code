import { PROVIDER_DISPLAY_NAMES, type ServerProvider } from "@t3tools/contracts";
import { memo } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { CircleAlertIcon } from "lucide-react";

/**
 * The provider's own words for "you are not signed in" name a CLI command —
 * `codex login`, `claude auth login` — because they are written for someone
 * sitting at that machine's terminal. A person using T3 in a browser cannot
 * run them and has no reason to know Connections is where the same thing is
 * offered, so the banner says where to go.
 */
function isNotAuthenticated(message: string | null): boolean {
  return message !== null && /not authenticated/i.test(message);
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  status,
}: {
  status: ServerProvider | null;
}) {
  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
  const defaultMessage =
    status.status === "error"
      ? `${providerLabel} provider is unavailable.`
      : `${providerLabel} provider has limited availability.`;
  const title = `${providerLabel} provider status`;

  return (
    <div className="pt-3 mx-auto max-w-3xl">
      <Alert variant={status.status === "error" ? "error" : "warning"}>
        <CircleAlertIcon />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription title={status.message ?? defaultMessage}>
          <span className="line-clamp-3">{status.message ?? defaultMessage}</span>
          {isNotAuthenticated(status.message ?? null) ? (
            <Link
              to="/settings/connections"
              className="mt-1 inline-block font-medium underline underline-offset-2"
              data-testid="provider-status-connect-link"
            >
              Connect {providerLabel}
            </Link>
          ) : null}
        </AlertDescription>
      </Alert>
    </div>
  );
});
