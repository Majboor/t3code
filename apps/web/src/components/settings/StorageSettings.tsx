import { useEffect, useState } from "react";

import { resolvePrimaryEnvironmentHttpUrl } from "../../environments/primary/target";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

interface StorageUsage {
  readonly usedBytes: number;
  readonly allocatedBytes: number;
}

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

async function fetchStorageUsage(): Promise<StorageUsage> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl("/api/storage/usage"), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to load storage usage (${response.status}).`);
  }
  const body = (await response.json()) as { used_bytes: number; allocated_bytes: number };
  return { usedBytes: body.used_bytes, allocatedBytes: body.allocated_bytes };
}

export function StorageUsageBar({ compact = false }: { compact?: boolean }) {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchStorageUsage()
      .then((result) => {
        if (!cancelled) setUsage(result);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load storage.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return compact ? null : <p className="text-xs text-destructive">{error}</p>;
  }
  if (!usage) {
    return compact ? null : <p className="text-xs text-muted-foreground">Loading storage…</p>;
  }

  const percentUsed = Math.min(100, (usage.usedBytes / Math.max(1, usage.allocatedBytes)) * 100);
  const isNearLimit = percentUsed >= 90;

  return (
    <div className={compact ? "flex flex-col gap-1 px-2 py-1.5" : "space-y-2"}>
      {!compact ? (
        <div className="flex items-center justify-between text-sm">
          <span>Storage</span>
          <span className="text-muted-foreground">
            {formatBytes(usage.usedBytes)} of {formatBytes(usage.allocatedBytes)}
          </span>
        </div>
      ) : (
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Storage</span>
          <span>
            {formatBytes(usage.usedBytes)} / {formatBytes(usage.allocatedBytes)}
          </span>
        </div>
      )}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full transition-[width] ${isNearLimit ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${percentUsed}%` }}
        />
      </div>
    </div>
  );
}

export function StorageSettings() {
  return (
    <SettingsPageContainer>
      <SettingsSection title="Storage">
        <SettingsRow
          title="Used storage"
          description="How much of your allocation your projects and files are using."
          control={<StorageUsageBar />}
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}
