import { resolvePrimaryEnvironmentHttpUrl } from "./target";

export type IntegrationProvider = "github" | "cloudflare";

export interface IntegrationConnectionStatus {
  readonly connected: boolean;
  readonly label: string | null;
}

export interface IntegrationsStatus {
  readonly github: IntegrationConnectionStatus;
  readonly cloudflare: IntegrationConnectionStatus;
}

export interface CloudflareZoneAnalytics {
  readonly requests: number;
  readonly uniqueVisitors: number;
  readonly bandwidthBytes: number;
}

function parseIntegrationErrorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return parsed.message;
    }
  } catch {
    return trimmed;
  }
  return null;
}

async function readIntegrationErrorMessage(
  response: Response,
  fallbackMessage: string,
): Promise<string> {
  const text = await response.text();
  return parseIntegrationErrorMessage(text) ?? fallbackMessage;
}

export async function fetchIntegrationsStatus(): Promise<IntegrationsStatus> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/integrations/status"), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(
      await readIntegrationErrorMessage(
        response,
        `Failed to load connection status (${response.status}).`,
      ),
    );
  }
  return (await response.json()) as IntegrationsStatus;
}

/** Not a fetch — navigates the whole page into the OAuth consent redirect. */
export function startIntegrationAuthorize(provider: IntegrationProvider): void {
  window.location.href = resolvePrimaryEnvironmentHttpUrl(`/api/oauth/${provider}/start`);
}

export async function disconnectIntegration(provider: IntegrationProvider): Promise<void> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl(`/api/integrations/${provider}/disconnect`),
    {
      credentials: "include",
      method: "POST",
    },
  );
  if (!response.ok) {
    throw new Error(
      await readIntegrationErrorMessage(
        response,
        `Failed to disconnect ${provider} (${response.status}).`,
      ),
    );
  }
}

export async function fetchCloudflareZoneAnalytics(
  zoneId: string,
): Promise<CloudflareZoneAnalytics> {
  const response = await fetch(
    resolvePrimaryEnvironmentHttpUrl(
      `/api/integrations/cloudflare/zones/${encodeURIComponent(zoneId)}/analytics`,
    ),
    { credentials: "include" },
  );
  if (!response.ok) {
    throw new Error(
      await readIntegrationErrorMessage(
        response,
        `Failed to load zone analytics (${response.status}).`,
      ),
    );
  }
  return (await response.json()) as CloudflareZoneAnalytics;
}
