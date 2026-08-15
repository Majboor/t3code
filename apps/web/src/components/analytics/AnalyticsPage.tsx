import { ArrowLeftIcon, ChartNoAxesColumnIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { scopeProjectRef } from "@t3tools/client-runtime";
import type {
  AnalyticsAggregate,
  Deployment,
  ProjectId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { proposeStreamForDeployment } from "@t3tools/shared/analyticsStreamTemplates";

import { answerableQuestions, formatValue, toBars } from "./analyticsChart.logic";
import { resolveAnalyticsPromptTarget } from "./analyticsPromptTarget.logic";
import {
  deploymentsReportingTo,
  describeAddress,
  linkDeployments,
  mostRecentLiveDeployment,
} from "./deploymentLinks.logic";
import { buildEnableAnalyticsPrompt } from "./enableAnalytics.logic";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { toastManager } from "../ui/toast";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { selectThreadIdsByProjectRef, useStore } from "../../store";
import { buildDraftThreadRouteParams, buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2 sm:px-5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Back"
            onClick={() => window.history.back()}
          >
            <ArrowLeftIcon className="size-4" />
          </Button>
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <span className="text-sm font-medium text-foreground">Analytics</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto grid max-w-3xl gap-4">{children}</div>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * What to ask for about one deployment. Shared by the list and the empty state
 * so the offer is the same prompt wherever it is taken up.
 */
function buildPromptForDeployment(deployment: Deployment | null): string | null {
  if (deployment === null) {
    return null;
  }

  return buildEnableAnalyticsPrompt({
    subject: deployment.name,
    stream: proposeStreamForDeployment({ name: deployment.name, url: deployment.url }),
    deployment: {
      name: deployment.name,
      url: deployment.url,
      reportsToCount: deployment.analyticsStreamIds.length,
    },
  });
}

/**
 * What the project has live, and which streams each one writes to. This is the
 * only place the two directories meet: without it a deployment's URL and its
 * numbers are two lists nobody can connect.
 */
function LiveDeployments({
  links,
  onUsePrompt,
}: {
  links: ReturnType<typeof linkDeployments>;
  onUsePrompt: (prompt: string, deploymentName: string) => void;
}) {
  if (links.length === 0) {
    return null;
  }

  return (
    <section className="rounded-lg border border-border p-4" data-testid="analytics-deployments">
      <div className="text-xs font-medium text-foreground">Live</div>
      <div className="mt-2 grid gap-2">
        {links.map(({ deployment, streamNames, dangling }) => (
          <div
            key={deployment.id}
            className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs"
            data-testid="analytics-deployment"
            data-deployment-name={deployment.name}
            data-deployment-status={deployment.status}
          >
            <span className="font-medium text-foreground">{deployment.name}</span>
            <span className="text-muted-foreground">{deployment.status}</span>
            {deployment.url ? (
              <a
                href={deployment.url}
                target="_blank"
                rel="noreferrer"
                className="min-w-0 truncate text-primary underline-offset-2 hover:underline"
              >
                {deployment.url}
              </a>
            ) : (
              <span className="text-muted-foreground">{describeAddress(deployment)}</span>
            )}
            <span className="text-muted-foreground">
              {streamNames.length === 0
                ? "reports nothing"
                : `reports ${streamNames.join(", ")}`}
              {dangling === 0
                ? ""
                : ` — ${dangling} stream${dangling === 1 ? "" : "s"} no longer declared`}
            </span>
            {/* Offered for anything live, pack or not — a TUI, a PDF job and a
                front end all report the same way. */}
            <Button
              size="xs"
              variant="outline"
              data-testid="analytics-enable-deployment"
              onClick={() => {
                const prompt = buildPromptForDeployment(deployment);
                if (prompt !== null) onUsePrompt(prompt, deployment.name);
              }}
            >
              {streamNames.length === 0 ? "Enable analytics" : "Change what it reports"}
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * What a project's deployments are reporting. The controls are built from each
 * stream's declaration rather than offered blindly, because the server checks
 * the same rules — offering to sum a string would only ever produce an error.
 */
export function AnalyticsPage({ projectId }: { projectId: ProjectId }) {
  // The environment is whichever one this window is connected to. Asking the
  // caller to name it only invites a link that points at an id nothing serves.
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const { handleNewThread } = useHandleNewThread();
  const projectRef = environmentId === null ? null : scopeProjectRef(environmentId, projectId);
  const threadIds = useStore((state) => selectThreadIdsByProjectRef(state, projectRef));
  const [streamName, setStreamName] = useState<string | null>(null);
  const [aggregate, setAggregate] = useState<AnalyticsAggregate>("count");
  const [valueProperty, setValueProperty] = useState<string | null>(null);
  const [groupBy, setGroupBy] = useState<string | null>(null);

  const streams = useQuery({
    enabled: environmentId !== null,
    queryKey: ["analytics", "streams", environmentId, projectId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This environment is not connected.");
      return api.analytics.listStreams({ projectId });
    },
  });

  // What the project has live. Kept beside the streams because the two only
  // mean anything together: a stream nothing reports to is a declaration, and a
  // deployment reporting to nothing is a blind spot.
  const deployments = useQuery({
    enabled: environmentId !== null,
    queryKey: ["deploy", "deployments", environmentId, projectId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This environment is not connected.");
      return api.deploys.listDeployments({ projectId });
    },
  });

  const selected =
    streams.data?.streams.find((stream) => stream.name === streamName) ??
    streams.data?.streams[0] ??
    null;
  const questions = selected ? answerableQuestions(selected) : null;

  const live = deployments.data?.deployments ?? [];
  const links = linkDeployments(live, streams.data?.streams ?? []);

  // The prompt is written into the project's composer rather than the clipboard.
  // A prompt somebody has to paste is a prompt most people drop, and this page
  // knows which thread the project is being worked in.
  const writePromptToComposer = async (prompt: string, deploymentName: string) => {
    if (projectRef === null) {
      return;
    }
    const store = useComposerDraftStore.getState();

    // Appended, like a pack mention, so it never eats what somebody had already
    // started typing.
    const append = (target: ScopedThreadRef | DraftId) => {
      const trimmed = (store.getComposerDraft(target)?.prompt ?? "").trimEnd();
      store.setPrompt(target, trimmed.length === 0 ? prompt : `${trimmed}\n\n${prompt}`);
    };

    const target = resolveAnalyticsPromptTarget({
      draftSession: store.getDraftSessionByProjectRef(projectRef),
      threadIds,
      environmentId,
    });

    if (target.kind === "none") {
      // Nothing to write into yet, so mint the draft the same way the sidebar
      // does and let its own navigation stand.
      await handleNewThread(projectRef);
      const minted = store.getDraftSessionByProjectRef(projectRef);
      if (minted === null) {
        return;
      }
      append(minted.draftId);
    } else if (target.kind === "draft") {
      append(target.draftId);
      await navigate({
        to: "/draft/$draftId",
        params: buildDraftThreadRouteParams(target.draftId),
      });
    } else {
      append(target.threadRef);
      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target.threadRef),
      });
    }

    toastManager.add({
      type: "success",
      title: `Prompt for ${deploymentName} is in the composer`,
      description: "Read it over and send it when you are ready.",
    });
  };

  const result = useQuery({
    enabled: selected !== null && environmentId !== null,
    queryKey: [
      "analytics",
      "query",
      environmentId,
      projectId,
      selected?.name,
      aggregate,
      valueProperty,
      groupBy,
    ],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || !selected) throw new Error("This environment is not connected.");
      return api.analytics.query({
        projectId,
        stream: selected.name,
        aggregate,
        ...(aggregate === "count" || valueProperty === null
          ? {}
          : { valueProperty: valueProperty as never }),
        ...(groupBy === null ? {} : { groupBy: groupBy as never }),
      });
    },
  });

  if (environmentId === null || streams.isPending) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  if (streams.isError) {
    return (
      <Shell>
        <div className="rounded-lg border border-border p-4 text-sm" data-testid="analytics-error">
          {streams.error instanceof Error ? streams.error.message : "Could not read analytics."}
        </div>
      </Shell>
    );
  }

  if (!selected) {
    // The offer has to live on the empty card too: with nothing live the list
    // above renders nothing, and this is the state somebody arrives in.
    const subject = mostRecentLiveDeployment(live);
    const emptyPrompt = buildPromptForDeployment(subject);

    return (
      <Shell>
        <LiveDeployments links={links} onUsePrompt={writePromptToComposer} />
        <div className="rounded-lg border border-border p-4" data-testid="analytics-empty">
          <div className="text-sm font-medium text-foreground">Nothing is reporting yet</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {live.length === 0
              ? "A deployment reports to a stream it was told about. Declare one with "
              : `${live.length === 1 ? "A deployment is" : `${live.length} deployments are`} registered but no stream is declared for them to report to. Declare one with `}
            <code>t3 analytics declare</code>, put the ingest key in the deployment, and its events
            will show up here.
          </p>
          {/* Nothing to point at means no button: asking an agent to make a
              deployment report before one exists is a dead end. */}
          {emptyPrompt === null || subject === null ? null : (
            <Button
              size="xs"
              variant="outline"
              className="mt-3"
              data-testid="analytics-empty-enable"
              onClick={() => void writePromptToComposer(emptyPrompt, subject.name)}
            >
              Enable analytics
            </Button>
          )}
        </div>
      </Shell>
    );
  }

  const bars = toBars(result.data?.buckets ?? []);

  const reporters = deploymentsReportingTo(selected.id, live);

  return (
    <Shell>
      <LiveDeployments links={links} onUsePrompt={writePromptToComposer} />

      <section className="rounded-lg border border-border p-4" data-testid="analytics-streams">
        <div className="flex flex-wrap items-center gap-1.5">
          {streams.data.streams.map((stream) => (
            <Button
              key={stream.id}
              size="xs"
              variant={stream.name === selected.name ? "default" : "outline"}
              data-testid="analytics-stream-choice"
              onClick={() => {
                setStreamName(stream.name);
                setAggregate("count");
                setValueProperty(null);
                setGroupBy(null);
              }}
            >
              {stream.name}
            </Button>
          ))}
        </div>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">{selected.purpose}</p>
        <p
          className="mt-1 text-[11px] leading-5 text-muted-foreground"
          data-testid="analytics-stream-reporters"
        >
          {reporters.length === 0
            ? "No registered deployment reports to this stream."
            : `Reported by ${reporters.map((entry) => entry.name).join(", ")}.`}
        </p>
      </section>

      <section className="rounded-lg border border-border p-4" data-testid="analytics-question">
        <div className="text-xs font-medium text-foreground">Ask</div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {questions?.aggregates.map((option) => (
            <Button
              key={option}
              size="xs"
              variant={option === aggregate ? "default" : "outline"}
              data-testid="analytics-aggregate"
              onClick={() => {
                setAggregate(option);
                if (option !== "count" && valueProperty === null) {
                  setValueProperty(questions.numeric[0]?.name ?? null);
                }
              }}
            >
              {option}
            </Button>
          ))}

          {aggregate === "count" || questions === null ? null : (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">of</span>
              {questions.numeric.map((property) => (
                <Button
                  key={property.name}
                  size="xs"
                  variant={property.name === valueProperty ? "default" : "outline"}
                  data-testid="analytics-value"
                  onClick={() => setValueProperty(property.name)}
                >
                  {property.name}
                </Button>
              ))}
            </span>
          )}

          {questions === null || questions.groupable.length === 0 ? null : (
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">by</span>
              <Button
                size="xs"
                variant={groupBy === null ? "default" : "outline"}
                data-testid="analytics-group"
                onClick={() => setGroupBy(null)}
              >
                everything
              </Button>
              {questions.groupable.map((property) => (
                <Button
                  key={property.name}
                  size="xs"
                  variant={property.name === groupBy ? "default" : "outline"}
                  data-testid="analytics-group"
                  onClick={() => setGroupBy(property.name)}
                >
                  {property.name}
                </Button>
              ))}
            </span>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border p-4" data-testid="analytics-chart">
        {result.isPending ? (
          <Spinner />
        ) : result.isError ? (
          <div className="text-sm text-destructive" data-testid="analytics-chart-error">
            {result.error instanceof Error ? result.error.message : "That question failed."}
          </div>
        ) : bars.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <ChartNoAxesColumnIcon className="size-4" />
            No events in this stream yet.
          </div>
        ) : (
          <div className="grid gap-2">
            {bars.map((bar) => (
              <div key={bar.label} data-testid="analytics-bar" data-label={bar.label}>
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="min-w-0 truncate text-foreground">{bar.label}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {formatValue(bar.value)}
                    <span className="ml-1 text-[10px]">({bar.events} events)</span>
                  </span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${bar.percent}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
