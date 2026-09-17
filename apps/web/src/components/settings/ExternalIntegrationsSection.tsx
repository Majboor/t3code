import { useEffect, useState } from "react";

import {
  disconnectIntegration,
  fetchIntegrationsStatus,
  startIntegrationAuthorize,
  type IntegrationProvider,
  type IntegrationsStatus,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const PROVIDER_LABEL: Record<IntegrationProvider, string> = {
  github: "GitHub",
  cloudflare: "Cloudflare",
};

const PROVIDER_DESCRIPTION: Record<IntegrationProvider, string> = {
  github: "Lets your agent create repos, push files and read branches on your behalf.",
  cloudflare: "Lets your agent deploy to Cloudflare Pages and connect a custom domain.",
};

/**
 * Sits below the OAuth-account (Claude/Codex) sections on purpose: those are
 * "which AI account can this workspace use", this is "which external service
 * can an agent act on the user's behalf against" — a different question, same
 * page because both are answered by "what am I connected to".
 */
export function ExternalIntegrationsSection() {
  const [status, setStatus] = useState<IntegrationsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disconnectingProvider, setDisconnectingProvider] = useState<IntegrationProvider | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchIntegrationsStatus()
      .then((result) => {
        if (!cancelled) setStatus(result);
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) {
          setError(fetchError instanceof Error ? fetchError.message : "Failed to load connections.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleDisconnect = async (provider: IntegrationProvider) => {
    setDisconnectingProvider(provider);
    try {
      await disconnectIntegration(provider);
      setStatus((current) =>
        current ? { ...current, [provider]: { connected: false, label: null } } : current,
      );
    } catch (disconnectError) {
      toastManager.add({
        type: "error",
        title: `Could not disconnect ${PROVIDER_LABEL[provider]}`,
        description: disconnectError instanceof Error ? disconnectError.message : "The request failed.",
      });
    } finally {
      setDisconnectingProvider(null);
    }
  };

  return (
    <SettingsSection title="External integrations">
      {error ? (
        <SettingsRow title="Could not load connections" description={error} control={null} />
      ) : (
        (["github", "cloudflare"] as const).map((provider) => {
          const connection = status?.[provider];
          const isConnected = connection?.connected === true;
          return (
            <SettingsRow
              key={provider}
              title={PROVIDER_LABEL[provider]}
              description={
                isConnected
                  ? (connection?.label ?? "Connected")
                  : PROVIDER_DESCRIPTION[provider]
              }
              control={
                isConnected ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disconnectingProvider === provider}
                    onClick={() => void handleDisconnect(provider)}
                  >
                    {disconnectingProvider === provider ? "Disconnecting…" : "Disconnect"}
                  </Button>
                ) : (
                  <Button size="xs" onClick={() => startIntegrationAuthorize(provider)}>
                    Connect {PROVIDER_LABEL[provider]}
                  </Button>
                )
              }
            />
          );
        })
      )}
    </SettingsSection>
  );
}
