import { CircleCheckIcon, CircleDashedIcon, PowerIcon, ShieldQuestionMarkIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import { scopeProjectRef } from "@t3tools/client-runtime";
import type { EnvironmentId, EnvironmentService, ProjectId } from "@t3tools/contracts";

import { describeLoad, orderDeployments, summariseLoad, totalEvents } from "./deploymentLoad.logic";
import {
  describeExposure,
  describeOwnership,
  describeProbe,
  describeSince,
  describeState,
  groupServices,
  liveClaims,
} from "./environmentServices.logic";
import { describeReadiness, orderForAttention } from "./infra.logic";
import { resolveInfraScope } from "./infraScope.logic";
import { describeAddress } from "../analytics/deploymentLinks.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { selectProjectByRef, useStore } from "../../store";
import { Button } from "../ui/button";
import { Card, CardTitle } from "../ui/card";
import { WorkspaceSubPage } from "../WorkspaceSubPage";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

function Shell({ children }: { children: React.ReactNode }) {
  return <WorkspaceSubPage title="Infrastructure">{children}</WorkspaceSubPage>;
}

/**
 * The window load is counted over, floored to the hour.
 *
 * Rounded rather than exact so the value is stable across renders: it is part
 * of a query key, and a timestamp that moves every millisecond would refetch
 * every count on every paint.
 */
function loadWindowStart(): string {
  const start = new Date(Date.now() - 24 * 60 * 60 * 1000);
  start.setMinutes(0, 0, 0);
  return start.toISOString();
}

/**
 * What this project has turned on, and what each of those asks for.
 *
 * The line beside each pack is the point of the page. Enabling supplies
 * nothing, so a bare list of enabled packs would read as a list of working
 * things and be wrong about every one. It says what a pack needs rather than
 * what is missing, because nothing here can see whether an environment
 * variable is set on the machine that will run it.
 */
/**
 * Deploying and the infrastructure it produces are held back from production
 * while they are finished, so a build can ship the rest of the product without
 * offering a half-built one. Set VITE_T3_INFRA=off for that build; anything
 * else — including unset, which is every development build — leaves it on.
 */
const INFRA_ENABLED = import.meta.env.VITE_T3_INFRA !== "off";

function ComingSoon() {
  return (
    <Shell>
      <Card className="p-6 text-center" render={<section />}>
        <CardTitle className="text-base">Infrastructure is coming soon</CardTitle>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Deploying a project from here, and the record of what it put live, are still being built.
          Nothing here is wired up yet — when it is, this page will show what is running and the
          traffic it is serving.
        </p>
      </Card>
    </Shell>
  );
}

export function InfraPage({ projectId }: { projectId: ProjectId }) {
  if (!INFRA_ENABLED) {
    return <ComingSoon />;
  }
  return <InfraPageContent projectId={projectId} />;
}

function InfraPageContent({ projectId }: { projectId: ProjectId }) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();
  const ownership = useStore(
    (state) =>
      selectProjectByRef(
        state,
        environmentId === null ? null : scopeProjectRef(environmentId, projectId),
      )?.ownership,
  );

  const scope = useQuery({
    enabled: environmentId !== null,
    queryKey: ["infra", "scope", environmentId, projectId, ownership?.workspaceId ?? null],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      // Only the guess needs the network: a project that carries its ownership
      // has already named the workspace its packs live in.
      const workspaces = ownership ? [] : ((await api.organizations.list()).workspaces ?? []);
      const resolved = resolveInfraScope({ ownership, workspaces });
      if (!resolved) throw new Error("This session can see no workspace.");
      return resolved;
    },
  });

  const enablements = useQuery({
    enabled: scope.data !== undefined && environmentId !== null,
    queryKey: ["infra", "enablements", environmentId, projectId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || !scope.data) throw new Error("This window is not connected to an environment.");
      return api.packs.listEnablements({ ...scope.data, projectId });
    },
  });

  // What this project has live, and whether anything is reaching it. Kept
  // independent of the workspace scope above: a deployment belongs to the
  // project, so it can be listed even when the pack scope cannot be resolved.
  const deployments = useQuery({
    enabled: environmentId !== null,
    queryKey: ["infra", "deployments", environmentId, projectId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      const [live, declared] = await Promise.all([
        api.deploys.listDeployments({ projectId }),
        api.analytics.listStreams({ projectId }),
      ]);
      const streams = declared.streams ?? [];

      // One count per declared stream, over the window below. Queried by name
      // because that is the handle a query takes and echoes back.
      const counts = new Map<string, number>();
      await Promise.all(
        streams.map(async (stream) => {
          const result = await api.analytics.query({
            projectId,
            stream: stream.name,
            aggregate: "count",
            since: loadWindowStart(),
          });
          counts.set(stream.name, totalEvents(result));
        }),
      );

      return orderDeployments(summariseLoad(live.deployments ?? [], streams, counts));
    },
  });

  const disable = useMutation({
    mutationFn: async (packId: string) => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || !scope.data) throw new Error("This window is not connected to an environment.");
      await api.packs.disable({ ...scope.data, projectId, packId: packId as never });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["infra", "enablements"] });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not turn that off",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    },
  });

  // The failure is read before the wait, and the wait asks whether a request is
  // actually in flight rather than whether one has resolved. A query that never
  // ran because the one before it failed reports itself as pending forever, so
  // asking about pending first left the page spinning on the one state that has
  // something to say.
  const failure = scope.error ?? enablements.error;
  if (!failure && (environmentId === null || scope.isLoading || enablements.isLoading)) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  if (failure) {
    return (
      <Shell>
        <Card className="p-4 text-sm" data-testid="infra-error">
          {failure instanceof Error ? failure.message : "Could not read this project's packs."}
        </Card>
      </Shell>
    );
  }

  const ordered = orderForAttention(enablements.data?.enablements ?? []);

  const loads = deployments.data ?? [];

  return (
    <Shell>
      <EnvironmentServicesSection environmentId={environmentId} />

      <section className="grid gap-2" data-testid="infra-deployments">
        <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          Deployments
        </h2>
        {deployments.isLoading ? (
          <Spinner />
        ) : deployments.error ? (
          <Card className="p-4 text-sm" data-testid="infra-deployments-error">
            {deployments.error instanceof Error
              ? deployments.error.message
              : "Could not read this project's deployments."}
          </Card>
        ) : loads.length === 0 ? (
          <Card className="p-4" data-testid="infra-deployments-empty">
            <CardTitle className="text-sm">Nothing deployed yet</CardTitle>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              A deploy registers what it put live and where it answers. Once one reports to a
              declared stream, the traffic reaching it shows up here.
            </p>
          </Card>
        ) : (
          loads.map((load) => (
            <Card
              key={load.deployment.id}
              className="p-4"
              data-testid="infra-deployment"
              data-name={load.deployment.name}
              data-status={load.deployment.status}
              // Null and 0 are different states; an absent attribute is the
              // "could not be measured" one.
              {...(load.events === null ? {} : { "data-events": String(load.events) })}
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm font-medium text-foreground">
                    {load.deployment.name}
                  </span>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {describeAddress(load.deployment)}
                  </p>
                </div>
                <span
                  className="text-[11px] text-muted-foreground"
                  data-testid="infra-deployment-status"
                >
                  {load.deployment.status}
                </span>
              </div>

              <div className="mt-2 flex items-center gap-1.5 text-xs">
                {load.events !== null && load.events > 0 ? (
                  <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                ) : (
                  <CircleDashedIcon className="size-3.5 shrink-0 text-amber-500" />
                )}
                <span className="text-foreground" data-testid="infra-deployment-load">
                  {describeLoad(load)}
                </span>
              </div>

              {load.streamNames.length > 0 ? (
                <p className="mt-1.5 text-[11px] text-muted-foreground">
                  reporting to{" "}
                  <code className="text-foreground">{load.streamNames.join(", ")}</code>
                </p>
              ) : null}
            </Card>
          ))
        )}
      </section>

      <h2 className="mt-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        Packs
      </h2>
      {ordered.length === 0 ? (
        <Card className="p-4" data-testid="infra-empty">
          <CardTitle className="text-sm">No packs turned on</CardTitle>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Turning a pack on records that this project uses it and lists what it needs. It does not
            install anything, set anything up, or check whether you have — that part is still yours.
          </p>
        </Card>
      ) : (
        <section className="grid gap-2" data-testid="infra-enablements">
          {ordered.map((enablement) => {
            const readiness = describeReadiness(enablement);
            return (
              <Card
                key={enablement.id}
                className="p-4"
                data-testid="infra-enablement"
                data-pack={enablement.packName}
                data-ready={readiness.ready}
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link
                      to="/pack/$packId"
                      params={{ packId: enablement.packId }}
                      className="text-sm font-medium text-foreground hover:underline"
                      data-testid="infra-pack-link"
                    >
                      {enablement.packName}
                    </Link>
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      {enablement.version}
                    </span>
                    <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                      {enablement.packSummary}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={disable.isPending}
                    data-testid="infra-disable"
                    onClick={() => disable.mutate(enablement.packId)}
                  >
                    <PowerIcon />
                    Turn off
                  </Button>
                </div>

                <div className="mt-2 flex items-center gap-1.5 text-xs">
                  {readiness.ready ? (
                    <CircleCheckIcon className="size-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleDashedIcon className="size-3.5 shrink-0 text-amber-500" />
                  )}
                  <span
                    className={readiness.ready ? "text-muted-foreground" : "text-foreground"}
                    data-testid="infra-readiness"
                  >
                    {readiness.summary}
                  </span>
                </div>

                {readiness.missing.length > 0 ? (
                  <ul className="mt-1.5 grid gap-0.5" data-testid="infra-missing">
                    {readiness.missing.map((name) => (
                      <li key={name} className="text-[11px] text-muted-foreground">
                        <code className="text-foreground">{name}</code> — yours to supply
                      </li>
                    ))}
                  </ul>
                ) : null}
              </Card>
            );
          })}
        </section>
      )}
    </Shell>
  );
}

/**
 * What is running on the machine, and which of it T3 may touch.
 *
 * Two lists rather than one table sorted by port, because they are two different
 * kinds of fact and the page must not let them read as one. The first is what
 * this app started and can therefore account for. The second is everything else
 * the machine is doing — somebody's database, a production API, a colleague's
 * dev server — and its whole job is to be visible without inviting action.
 *
 * `ownershipReason` is printed rather than summarised. Anybody about to stop
 * something needs the evidence, and "unknown" with no reason beside it is an
 * invitation to guess, which is the failure this exists to prevent.
 */
function EnvironmentServicesSection({ environmentId }: { environmentId: EnvironmentId | null }) {
  const running = useQuery({
    enabled: environmentId !== null,
    queryKey: ["infra", "services", environmentId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      return api.environment.listServices({});
    },
    // What is listening changes without anybody navigating, and a stale answer
    // here is the one that gets a port taken twice.
    refetchInterval: 15_000,
  });

  if (running.isLoading) {
    return (
      <section className="grid gap-2" data-testid="infra-services">
        <SectionHeading>Running here</SectionHeading>
        <Spinner />
      </section>
    );
  }

  if (running.error || !running.data) {
    return (
      <section className="grid gap-2" data-testid="infra-services">
        <SectionHeading>Running here</SectionHeading>
        <Card className="p-4 text-sm" data-testid="infra-services-error">
          {running.error instanceof Error
            ? running.error.message
            : "Could not read what is running on this machine."}
        </Card>
      </section>
    );
  }

  // Re-applied at draw time rather than trusted from the response: a page left
  // open would otherwise keep showing a reservation that lapsed while it sat there.
  const nowMs = Date.now();
  const { ours, others } = groupServices(running.data.services);
  const claims = liveClaims(running.data.claims, nowMs);

  return (
    <section className="grid gap-2" data-testid="infra-services">
      <SectionHeading>Running here</SectionHeading>
      <p className="-mt-1 text-[11px] text-muted-foreground" data-testid="infra-services-probe">
        {describeProbe(running.data.probe)}
      </p>

      {ours.length === 0 && others.length === 0 ? (
        <Card className="p-4" data-testid="infra-services-empty">
          <CardTitle className="text-sm">Nothing observed on this machine</CardTitle>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Nothing is listening, or nothing here could see it. The line above says which.
          </p>
        </Card>
      ) : null}

      {ours.length > 0 ? (
        <div className="grid gap-2" data-testid="infra-services-ours">
          <p className="text-[11px] text-muted-foreground">Started by T3</p>
          {ours.map((service) => (
            <ServiceCard
              key={`${service.managedId ?? service.port}`}
              service={service}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : null}

      {others.length > 0 ? (
        <div className="grid gap-2" data-testid="infra-services-others">
          <p className="text-[11px] text-muted-foreground">
            Already on this machine — not T3&rsquo;s to stop
          </p>
          {others.map((service) => (
            <ServiceCard
              key={`${service.port}:${service.pid ?? "?"}`}
              service={service}
              nowMs={nowMs}
            />
          ))}
        </div>
      ) : null}

      {claims.length > 0 ? (
        <div className="grid gap-2" data-testid="infra-services-claims">
          <p className="text-[11px] text-muted-foreground">Reserved, nothing listening yet</p>
          {claims.map((claim) => (
            <Card
              key={claim.port}
              className="p-3 text-xs"
              data-testid="infra-service-claim"
              data-port={String(claim.port)}
            >
              <span className="font-medium text-foreground">{claim.port}</span>
              <span className="ml-1.5 text-muted-foreground">
                held by {claim.claimedBy} for {claim.purpose}
              </span>
            </Card>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h2>
  );
}

function ServiceCard({ service, nowMs }: { service: EnvironmentService; nowMs: number }) {
  const age = describeSince(service.since, nowMs);
  const exposure = describeExposure(service.address);

  return (
    <Card
      className="p-4"
      data-testid="infra-service"
      data-port={String(service.port)}
      data-ownership={service.ownership}
      data-state={service.state}
      data-can-manage={String(service.canManage)}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="text-sm font-medium text-foreground">
            {service.name ?? `port ${service.port}`}
          </span>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {describeState(service)}
            {exposure === null ? null : ` · ${exposure}`}
            {service.pid === null ? null : ` · pid ${service.pid}`}
            {age === null ? null : ` · ${age}`}
          </p>
        </div>
        <span className="text-[11px] text-muted-foreground" data-testid="infra-service-ownership">
          {describeOwnership(service)}
        </span>
      </div>

      <div className="mt-2 flex items-start gap-1.5 text-xs">
        {service.ownership === "ours" ? (
          <CircleCheckIcon className="mt-px size-3.5 shrink-0 text-emerald-500" />
        ) : (
          <ShieldQuestionMarkIcon className="mt-px size-3.5 shrink-0 text-muted-foreground" />
        )}
        {/* The evidence, verbatim. Anybody deciding whether to stop this needs
            to see why the verdict is what it is. */}
        <span className="text-muted-foreground" data-testid="infra-service-reason">
          {service.ownershipReason}
        </span>
      </div>

      {service.command === null ? null : (
        <p className="mt-1.5 truncate text-[11px] text-muted-foreground">
          <code className="text-foreground">{service.command}</code>
        </p>
      )}
    </Card>
  );
}
