import { useEffect, useState } from "react";

import {
  fetchCloudflareZoneAnalytics,
  fetchIntegrationsStatus,
  type CloudflareZoneAnalytics,
} from "../../environments/primary";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Same binary-prefix formatting as `StorageSettings.tsx`'s storage bar, reused here for bandwidth. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

/**
 * Basic traffic stats for a Cloudflare zone, pulled from the Zone Analytics API
 * (`GET /zones/:zoneId/analytics/dashboard`) using the same connected Cloudflare
 * account as the rest of `ExternalIntegrationsSection` — no new OAuth scope, this
 * account already has Zone Analytics (Read).
 *
 * There is nowhere yet that this app persists a zone id once `cloudflare-domain`
 * creates one (`t3 publish cloudflare-domain` just prints it), so this asks for it
 * rather than pretending to know it — a real gap, not a design choice: a project
 * that stored its zone id per deploy target would let this look itself up.
 */
export function CloudflareAnalyticsSection() {
  const [isCloudflareConnected, setIsCloudflareConnected] = useState<boolean | null>(null);
  const [zoneIdInput, setZoneIdInput] = useState("");
  const [analytics, setAnalytics] = useState<CloudflareZoneAnalytics | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchIntegrationsStatus()
      .then((status) => {
        if (!cancelled) setIsCloudflareConnected(status.cloudflare.connected);
      })
      .catch(() => {
        if (!cancelled) setIsCloudflareConnected(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isCloudflareConnected) {
    return null;
  }

  const handleLoad = async () => {
    const zoneId = zoneIdInput.trim();
    if (!zoneId) return;
    setIsLoading(true);
    setError(null);
    try {
      setAnalytics(await fetchCloudflareZoneAnalytics(zoneId));
    } catch (loadError) {
      setAnalytics(null);
      setError(loadError instanceof Error ? loadError.message : "Failed to load zone analytics.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <SettingsSection title="Cloudflare traffic">
      <SettingsRow
        title="Zone analytics"
        description="Last 24 hours of requests and bandwidth for a Cloudflare zone, straight from Cloudflare's Zone Analytics API."
        status={error ? <span className="text-destructive">{error}</span> : null}
      >
        <div className="flex flex-col gap-3 pb-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input
              value={zoneIdInput}
              onChange={(event) => setZoneIdInput(event.target.value)}
              placeholder="Zone id, e.g. from `t3 publish cloudflare-domain`"
              className="sm:max-w-xs"
            />
            <Button
              size="xs"
              disabled={isLoading || zoneIdInput.trim().length === 0}
              onClick={() => void handleLoad()}
            >
              {isLoading ? "Loading…" : "Load stats"}
            </Button>
          </div>
          {analytics ? (
            <dl className="grid grid-cols-3 gap-3 text-xs">
              <div className="rounded-lg border border-border/60 px-3 py-2">
                <dt className="text-muted-foreground">Requests</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {analytics.requests.toLocaleString()}
                </dd>
              </div>
              <div className="rounded-lg border border-border/60 px-3 py-2">
                <dt className="text-muted-foreground">Unique visitors</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {analytics.uniqueVisitors.toLocaleString()}
                </dd>
              </div>
              <div className="rounded-lg border border-border/60 px-3 py-2">
                <dt className="text-muted-foreground">Bandwidth</dt>
                <dd className="mt-0.5 text-sm font-medium text-foreground">
                  {formatBytes(analytics.bandwidthBytes)}
                </dd>
              </div>
            </dl>
          ) : null}
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
