import { ArrowLeftIcon, ChartNoAxesColumnIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { AnalyticsAggregate, ProjectId } from "@t3tools/contracts";

import { answerableQuestions, formatValue, toBars } from "./analyticsChart.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
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
 * What a project's deployments are reporting. The controls are built from each
 * stream's declaration rather than offered blindly, because the server checks
 * the same rules — offering to sum a string would only ever produce an error.
 */
export function AnalyticsPage({ projectId }: { projectId: ProjectId }) {
  // The environment is whichever one this window is connected to. Asking the
  // caller to name it only invites a link that points at an id nothing serves.
  const environmentId = usePrimaryEnvironmentId();
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

  const selected =
    streams.data?.streams.find((stream) => stream.name === streamName) ??
    streams.data?.streams[0] ??
    null;
  const questions = selected ? answerableQuestions(selected) : null;

  const result = useQuery({
    enabled: selected !== null && environmentId !== null,
    queryKey: [
      "analytics", "query", environmentId, projectId,
      selected?.name, aggregate, valueProperty, groupBy,
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
    return (
      <Shell>
        <div className="rounded-lg border border-border p-4" data-testid="analytics-empty">
          <div className="text-sm font-medium text-foreground">Nothing is reporting yet</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            A deployment reports to a stream it was told about. Declare one with{" "}
            <code>t3 analytics declare</code>, put the ingest key in the deployment, and its events
            will show up here.
          </p>
        </div>
      </Shell>
    );
  }

  const bars = toBars(result.data?.buckets ?? []);

  return (
    <Shell>
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
                  <div className="h-full rounded-full bg-primary" style={{ width: `${bar.percent}%` }} />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
