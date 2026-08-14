/**
 * The pack itself, read without leaving the composer.
 *
 * The point of a suggestion is to be cheap to check: opening a tab to decide
 * whether a pack is relevant costs more than ignoring it, so most people would
 * ignore it. This shows what the pack is for and what it says went wrong
 * before, which is the part worth reading and the part a one-line summary
 * cannot carry.
 *
 * What it deliberately does not do is summarise. The failure modes are the
 * pack's own words: a paraphrase of "the deploy reports success and serves the
 * old version" is how that knowledge stops being actionable.
 */
import { AlertTriangleIcon, CheckIcon, LoaderIcon, XIcon } from "lucide-react";
import type { EnvironmentId, PackManifest, ProjectId, TenantId } from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

interface QuickViewScope {
  readonly environmentId: EnvironmentId;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
  readonly projectId: ProjectId | null;
}

/**
 * A failure mode, reduced to what is worth reading at a glance.
 *
 * The field is `symptom` — what you would actually see — not a summary. A
 * first version read `summary`, which does not exist, so every entry rendered
 * as an empty line and React saw four children with the same key. Dropping
 * anything without a symptom keeps a malformed pack from doing that again.
 */
function failureModesOf(manifest: PackManifest): ReadonlyArray<{
  readonly id: string;
  readonly symptom: string;
  readonly severity: string;
  readonly silent: boolean;
}> {
  const knowledge = manifest.knowledge as { failureModes?: ReadonlyArray<unknown> } | undefined;
  return (knowledge?.failureModes ?? [])
    .map((mode, index) => {
      const entry = mode as {
        id?: string;
        symptom?: string;
        severity?: string;
        silent?: boolean;
      };
      return {
        id: entry.id ?? `failure-${index}`,
        symptom: entry.symptom ?? "",
        severity: entry.severity ?? "unknown",
        silent: entry.silent === true,
      };
    })
    .filter((mode) => mode.symptom.length > 0)
    .slice(0, 4);
}

export function PackQuickView({
  packId,
  packName,
  scope,
  onClose,
}: {
  readonly packId: string;
  readonly packName: string;
  readonly scope: QuickViewScope;
  readonly onClose: () => void;
}) {
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [enabling, setEnabling] = useState(false);
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const api = readEnvironmentApi(scope.environmentId);
    if (!api) {
      setFailed("This environment is not connected.");
      return;
    }
    let cancelled = false;
    api.packs
      .get({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        packId: packId as never,
      })
      .then((result) => {
        if (!cancelled) setManifest(result.manifest);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setFailed(error instanceof Error ? error.message : "Could not read this pack.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [packId, scope.environmentId, scope.tenantId, scope.workspaceId]);

  async function enable() {
    const api = readEnvironmentApi(scope.environmentId);
    if (!api || !scope.projectId) {
      return;
    }
    setEnabling(true);
    try {
      await api.packs.enable({
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        packId: packId as never,
      });
      setEnabled(true);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not turn on ${packName}`,
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setEnabling(false);
    }
  }

  const failureModes = manifest ? failureModesOf(manifest) : [];

  return (
    <div
      className="mb-1.5 rounded-md border border-border bg-background p-3 text-xs"
      data-testid="pack-quick-view"
      data-pack={packName}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="font-medium text-foreground">{packName}</div>
          {manifest ? (
            <div className="mt-0.5 text-muted-foreground">{manifest.capability.does}</div>
          ) : null}
        </div>
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={onClose}>
          <XIcon className="size-3" />
        </Button>
      </div>

      {failed ? (
        <div className="mt-2 text-destructive" data-testid="pack-quick-view-error">
          {failed}
        </div>
      ) : manifest === null ? (
        <div className="mt-2 flex items-center gap-1 text-muted-foreground">
          <LoaderIcon className="size-3 animate-spin" />
          Reading the pack…
        </div>
      ) : (
        <>
          {failureModes.length > 0 ? (
            <div className="mt-2">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                What has gone wrong before
              </div>
              <ul className="grid gap-1">
                {failureModes.map((mode) => (
                  <li key={mode.id} className="flex items-start gap-1.5">
                    <AlertTriangleIcon className="mt-0.5 size-3 shrink-0 text-amber-600" />
                    <span className="text-muted-foreground">
                      {mode.symptom}
                      {mode.silent ? (
                        // Worth calling out: a silent failure is the one whose
                        // absence of symptoms is the symptom.
                        <span className="ml-1 text-[10px] text-amber-700">(silent)</span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {scope.projectId ? (
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="xs"
                variant={enabled ? "outline" : "default"}
                disabled={enabling || enabled}
                data-testid="pack-quick-view-enable"
                onClick={() => void enable()}
              >
                {enabled ? <CheckIcon className="size-3" /> : null}
                {enabled ? "On for this project" : enabling ? "Turning on…" : "Turn on"}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {enabled
                  ? "The agent will be told this pack applies here."
                  : "Turning it on records that this project uses the pack."}
              </span>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
