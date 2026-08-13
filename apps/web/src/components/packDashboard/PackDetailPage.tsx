import { ArrowLeftIcon, OctagonAlertIcon } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";

import type { PackVisibilityScope } from "@t3tools/contracts";

import { packDetailSource } from "./packDetailSource";
import {
  countKnowledgeEntries,
  describePublication,
  describeScarRecordBrief,
  formatObservedDate,
  pluralize,
} from "./packDetail.logic";
import { PackDeployControl } from "./PackDeployControl";
import { PackIntegrateControl } from "./PackIntegrateControl";
import { PackKnowledgeSection } from "./PackKnowledgeSection";
import { PackPublishControl } from "./PackPublishControl";
import { PackReleaseHistory } from "./PackReleaseHistory";
import { PackRequirementsSection } from "./PackRequirementsSection";
import { PackShareControl } from "./PackShareControl";
import { PackSignatureBadge } from "./PackSignatureBadge";
import { PackScarRecordSection } from "./PackScarRecordSection";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";

function PackDetailShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Back"
            title="Back"
            onClick={() => {
              window.history.back();
            }}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <span className="text-sm font-medium text-foreground">Pack</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto grid max-w-3xl gap-3 p-3 sm:p-5">{children}</div>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * One pack, read in the order a consumer asks: what it is, who may see it,
 * what it does, what they must supply before any of it runs, what it knows
 * that they do not, what production has said about it, and only then the
 * prompt that wires it in.
 *
 * Requirements sit above the knowledge on purpose. The knowledge is the
 * product, but a key the reader cannot obtain or an account they will not pay
 * for rules the pack out before any of it is worth reading.
 */
export function PackDetailPage({ packId, version }: { packId: string; version?: string }) {
  const queryClient = useQueryClient();
  const packQuery = useQuery({
    queryKey: ["packDetail", packId, version ?? "latest"],
    queryFn: () => packDetailSource.loadPack({ packId, ...(version ? { version } : {}) }),
  });

  const changeVisibility = useCallback(
    async (scope: PackVisibilityScope) => {
      await packDetailSource.setVisibility({ packId, scope });
      await queryClient.invalidateQueries({ queryKey: ["packDetail", packId] });
    },
    [packId, queryClient],
  );

  if (packQuery.isPending) {
    return (
      <PackDetailShell>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-4" />
          Loading pack…
        </div>
      </PackDetailShell>
    );
  }

  const detail = packQuery.data;
  if (!detail) {
    return (
      <PackDetailShell>
        <div className="text-sm text-muted-foreground" data-testid="pack-detail-missing">
          {version === undefined
            ? "No pack here. It may have been renamed, or it is private to a workspace you are not in."
            : `There is no ${version} of this pack.`}
        </div>
      </PackDetailShell>
    );
  }

  const { manifest, history } = detail;
  const { identity, capability, verification } = manifest;
  const advisories = verification.advisories ?? [];
  const knowledgeCount = countKnowledgeEntries(manifest.knowledge);
  const release = history.releases.find((entry) => entry.version === identity.version);
  const publication = describePublication(release);
  // Stated by the registry rather than inferred from the ordering: a manifest
  // cannot know about a release cut after it.
  const isOlderRelease = history.latestVersion !== identity.version;

  return (
    <PackDetailShell>
      {advisories.length > 0 ? (
        <div
          className="rounded-lg border border-destructive/40 bg-destructive/8 p-4"
          data-testid="pack-detail-advisories"
        >
          {advisories.map((advisory) => (
            <div key={advisory.id} className="flex gap-2">
              <OctagonAlertIcon className="mt-0.5 size-4 shrink-0 text-destructive-foreground" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-destructive-foreground">
                  {advisory.severity === "revoked"
                    ? "This pack has been withdrawn."
                    : `Advisory from ${advisory.issuedBy}`}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">
                  {advisory.reason}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      <section className="rounded-lg border border-border p-4" data-testid="pack-detail-identity">
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-base font-medium text-foreground">{identity.displayName}</h1>
          <span className="font-mono text-xs text-muted-foreground">
            {identity.publisher.handle}/{identity.name}@{identity.version}
          </span>
        </div>
        <p className="mt-1 text-sm leading-6 text-foreground">{identity.summary}</p>

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <Badge size="sm" variant="outline" data-testid="pack-detail-production-brief">
            {describeScarRecordBrief(verification.record)}
          </Badge>
          <Badge size="sm" variant="outline">
            {pluralize(knowledgeCount, "thing")} learned
          </Badge>
          <Badge size="sm" variant="outline">
            {identity.license}
          </Badge>
          {(identity.categories ?? []).map((category) => (
            <Badge key={category} size="sm" variant="secondary">
              {category}
            </Badge>
          ))}
        </div>

        <div className="mt-2 text-[11px] leading-4 text-muted-foreground">
          Cut from {manifest.provenance.workspace.title ?? "a workspace"} on{" "}
          {formatObservedDate(manifest.provenance.extractedAt)} by{" "}
          {manifest.provenance.extractedBy.type === "agent"
            ? `${manifest.provenance.extractedBy.provider}${
                manifest.provenance.extractedBy.model === undefined
                  ? ""
                  : ` (${manifest.provenance.extractedBy.model})`
              }`
            : manifest.provenance.extractedBy.displayName}
          . {manifest.provenance.handover.summary}
        </div>

        <div
          className="mt-1 text-[11px] leading-4 text-muted-foreground"
          data-testid="pack-detail-published"
        >
          {publication.line}
          {publication.narrowed === null ? "" : ` ${publication.narrowed}`}
        </div>

        {isOlderRelease ? (
          <div
            className="mt-2 rounded-md border border-border p-2 text-xs leading-5 text-muted-foreground"
            data-testid="pack-detail-older-release"
          >
            You are reading {identity.version}, not the newest release. Everything below is what
            this version knew and had survived at the time.
          </div>
        ) : null}
      </section>

      <PackPublishControl
        record={verification.record}
        release={release}
        visibility={manifest.visibility}
        onChangeVisibility={changeVisibility}
      />

      <PackSignatureBadge manifest={manifest} />

      <PackShareControl identity={identity} visibility={manifest.visibility} />

      <PackDeployControl runtime={manifest.runtime} requirements={manifest.requirements} />

      <section className="rounded-lg border border-border p-4" data-testid="pack-detail-capability">
        <h2 className="text-sm font-medium text-foreground">What it does</h2>
        <p className="mt-1 text-sm leading-6 text-foreground">{capability.does}</p>
        {identity.description === undefined ? null : (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{identity.description}</p>
        )}

        {capability.useCases !== undefined && capability.useCases.length > 0 ? (
          <div className="mt-2 text-xs leading-5 text-muted-foreground">
            Used for: {capability.useCases.join(", ")}
          </div>
        ) : null}

        {capability.nonGoals !== undefined && capability.nonGoals.length > 0 ? (
          <div className="mt-2" data-testid="pack-detail-non-goals">
            <div className="text-xs font-medium text-muted-foreground">
              What it deliberately does not do
            </div>
            <ul className="mt-0.5 grid gap-0.5">
              {capability.nonGoals.map((nonGoal) => (
                <li key={nonGoal} className="text-xs leading-5 text-muted-foreground">
                  — {nonGoal}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="mt-2 flex flex-wrap gap-1" data-testid="pack-detail-interfaces">
          {manifest.interfaces.map((entry) => (
            <Badge key={entry.id} size="sm" variant="outline">
              {entry.kind}: {entry.title}
            </Badge>
          ))}
        </div>
      </section>

      <PackRequirementsSection requirements={manifest.requirements} />

      <PackKnowledgeSection knowledge={manifest.knowledge} />

      <PackScarRecordSection release={release} verification={verification} />

      <PackIntegrateControl integration={manifest.integration} />

      <PackReleaseHistory
        currentVersion={identity.version}
        knowledge={manifest.knowledge}
        latestVersion={history.latestVersion}
        packId={packId}
        releases={history.releases}
      />
    </PackDetailShell>
  );
}
