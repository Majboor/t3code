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
import {
  AlertTriangleIcon,
  ChartNoAxesColumnIcon,
  CheckIcon,
  LoaderIcon,
  RocketIcon,
  XIcon,
} from "lucide-react";
import type {
  Deployment,
  EnvironmentId,
  PackManifest,
  ProjectId,
  TenantId,
} from "@t3tools/contracts";
import type { WorkspaceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { readEnvironmentApi } from "../../environmentApi";
import {
  analyticsStreamsForPack,
  proposeStreamForDeployment,
} from "@t3tools/shared/analyticsStreamTemplates";

import { mostRecentLiveDeployment } from "../analytics/deploymentLinks.logic";
import { buildEnableAnalyticsPrompt } from "../analytics/enableAnalytics.logic";
import { buildDeployPrompt, type DeployPromptTarget } from "../packDashboard/packDetail.logic";
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
  onUsePrompt,
}: {
  readonly packId: string;
  readonly packName: string;
  readonly scope: QuickViewScope;
  readonly onClose: () => void;
  /** Writes into the composer this quick view is sitting in. */
  readonly onUsePrompt: (prompt: string) => void;
}) {
  const [manifest, setManifest] = useState<PackManifest | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // null until we know, so the button cannot claim "off" while still asking.
  const [enabled, setEnabled] = useState<boolean | null>(null);
  // What this project has live, if anything — null also covers "not asked yet".
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  // "Deploy locally" is a question, not an action: loopback and a public tunnel
  // are different enough that picking one for somebody is the wrong default.
  const [askingLocal, setAskingLocal] = useState(false);

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
    if (scope.projectId) {
      api.packs
        .listEnablements({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          projectId: scope.projectId,
        })
        .then((result) => {
          if (cancelled) return;
          setEnabled(result.enablements.some((entry) => entry.packId === packId));
        })
        .catch(() => {
          // Not knowing is not the same as being off; leave it unknown rather
          // than offering to turn on something that already is.
          if (!cancelled) setEnabled(null);
        });

      // Offering to make something report only means anything once it is live.
      api.deploys
        .listDeployments({ projectId: scope.projectId })
        .then((result) => {
          if (cancelled) return;
          setDeployment(mostRecentLiveDeployment(result.deployments));
        })
        .catch(() => {
          if (!cancelled) setDeployment(null);
        });
    }

    return () => {
      cancelled = true;
    };
  }, [packId, scope.environmentId, scope.projectId, scope.tenantId, scope.workspaceId]);

  async function toggle(next: boolean) {
    const api = readEnvironmentApi(scope.environmentId);
    if (!api || !scope.projectId) {
      return;
    }
    setBusy(true);
    try {
      const scoped = {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        packId: packId as never,
      };
      await (next ? api.packs.enable(scoped) : api.packs.disable(scoped));
      setEnabled(next);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Could not turn ${next ? "on" : "off"} ${packName}`,
        description: error instanceof Error ? error.message : "The request failed.",
      });
    } finally {
      setBusy(false);
    }
  }

  const failureModes = manifest ? failureModesOf(manifest) : [];
  // Null for a library, and for a pack still loading — either way there is
  // nothing honest to put in the prompt yet.
  const deployPrompt = manifest
    ? buildDeployPrompt({
        qualifiedName: `${manifest.identity.publisher.handle}/${manifest.identity.name}`,
        runtime: manifest.runtime,
        requirements: manifest.requirements,
        ...(manifest.analytics !== undefined ? { analytics: manifest.analytics } : {}),
      })
    : null;

  // Only once something is live: reporting is a property of a running thing, and
  // offering it before there is one describes work nobody can do yet.
  //
  // The pack's own declaration wins when it has one; otherwise the stream comes
  // from the shape of what was deployed, so a pack that never described its
  // telemetry still gets an offer worth taking.
  const analyticsStream =
    manifest === null
      ? null
      : (analyticsStreamsForPack({
          runtime: manifest.runtime,
          ...(manifest.analytics !== undefined ? { analytics: manifest.analytics } : {}),
        })[0] ??
        (deployment === null
          ? null
          : proposeStreamForDeployment({ name: deployment.name, url: deployment.url })));

  const usePromptForTarget = (target: DeployPromptTarget) => {
    if (manifest === null) return;
    const prompt = buildDeployPrompt({
      qualifiedName: `${manifest.identity.publisher.handle}/${manifest.identity.name}`,
      runtime: manifest.runtime,
      requirements: manifest.requirements,
      ...(manifest.analytics !== undefined ? { analytics: manifest.analytics } : {}),
      target,
    });
    if (prompt === null) return;
    onUsePrompt(prompt);
    onClose();
  };

  const analyticsPrompt = manifest
    ? buildEnableAnalyticsPrompt({
        subject: `${manifest.identity.publisher.handle}/${manifest.identity.name}`,
        stream: analyticsStream,
        deployment:
          deployment === null
            ? null
            : {
                name: deployment.name,
                url: deployment.url,
                reportsToCount: deployment.analyticsStreamIds.length,
              },
      })
    : null;

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
                variant={enabled === true ? "outline" : "default"}
                disabled={busy || enabled === null}
                data-testid={
                  enabled === true ? "pack-quick-view-disable" : "pack-quick-view-enable"
                }
                onClick={() => void toggle(enabled !== true)}
              >
                {enabled === true ? <CheckIcon className="size-3" /> : null}
                {enabled === null
                  ? "Checking…"
                  : busy
                    ? enabled
                      ? "Turning off…"
                      : "Turning on…"
                    : enabled
                      ? "On for this project"
                      : "Turn on"}
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {enabled === true
                  ? "The agent will be told this pack applies here. Click to turn it off."
                  : "Turning it on records that this project uses the pack."}
              </span>
            </div>
          ) : null}

          {deployPrompt === null ? null : (
            <div className="mt-2 grid gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="pack-quick-view-deploy-cloud"
                  onClick={() => {
                    usePromptForTarget("cloud");
                  }}
                >
                  <RocketIcon className="size-3" />
                  Deploy to cloud
                </Button>
                <Button
                  size="xs"
                  variant={askingLocal ? "default" : "outline"}
                  data-testid="pack-quick-view-deploy-local"
                  onClick={() => {
                    setAskingLocal((asking) => !asking);
                  }}
                >
                  <RocketIcon className="size-3" />
                  Deploy locally
                </Button>
                {askingLocal ? null : (
                  <span className="text-[10px] text-muted-foreground">
                    Writes what this takes to run into the prompt, for you to read before sending.
                  </span>
                )}
              </div>

              {/* Local can mean two quite different things, and the difference is
                  whether the internet can reach it — worth one deliberate click
                  rather than a default somebody discovers later. */}
              {askingLocal ? (
                <div className="flex flex-wrap items-center gap-2 pl-1">
                  <span className="text-[10px] text-muted-foreground">Reachable from</span>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="pack-quick-view-deploy-local-tunnel"
                    onClick={() => {
                      usePromptForTarget("local-tunnel");
                    }}
                  >
                    Anywhere, via a tunnel
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    data-testid="pack-quick-view-deploy-local-only"
                    onClick={() => {
                      usePromptForTarget("local-only");
                    }}
                  >
                    This machine only
                  </Button>
                </div>
              ) : null}
            </div>
          )}

          {analyticsPrompt === null ? null : (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                data-testid="pack-quick-view-enable-analytics"
                onClick={() => {
                  onUsePrompt(analyticsPrompt);
                  onClose();
                }}
              >
                <ChartNoAxesColumnIcon className="size-3" />
                Enable analytics
              </Button>
              <span className="text-[10px] text-muted-foreground">
                {deployment === null
                  ? null
                  : `Writes what it would take for ${deployment.name} to report into the prompt.`}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
