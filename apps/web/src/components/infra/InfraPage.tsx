import { ArrowLeftIcon, CircleCheckIcon, CircleDashedIcon, PowerIcon } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { ProjectId } from "@t3tools/contracts";

import { describeReadiness, orderForAttention } from "./infra.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { Spinner } from "../ui/spinner";
import { toastManager } from "../ui/toast";

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
          <span className="text-sm font-medium text-foreground">Infrastructure</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
          <div className="mx-auto grid max-w-3xl gap-4">{children}</div>
        </div>
      </div>
    </SidebarInset>
  );
}

/**
 * What this project has turned on, and what each of those still needs.
 *
 * The readiness line is the point of the page. Enabling a pack supplies
 * nothing, so a list of enabled packs without the gap beside each one would
 * read as a list of working things and be wrong about every one of them.
 */
export function InfraPage({ projectId }: { projectId: ProjectId }) {
  const environmentId = usePrimaryEnvironmentId();
  const queryClient = useQueryClient();

  const scope = useQuery({
    enabled: environmentId !== null,
    queryKey: ["infra", "scope", environmentId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      const snapshot = await api.organizations.list();
      const workspace = (snapshot.workspaces ?? [])[0];
      if (!workspace) throw new Error("This session can see no workspace.");
      return { tenantId: workspace.tenantId, workspaceId: workspace.id };
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

  if (environmentId === null || scope.isPending || enablements.isPending) {
    return (
      <Shell>
        <Spinner />
      </Shell>
    );
  }

  const failure = scope.error ?? enablements.error;
  if (failure) {
    return (
      <Shell>
        <div className="rounded-lg border border-border p-4 text-sm" data-testid="infra-error">
          {failure instanceof Error ? failure.message : "Could not read this project's packs."}
        </div>
      </Shell>
    );
  }

  const ordered = orderForAttention(enablements.data?.enablements ?? []);

  return (
    <Shell>
      {ordered.length === 0 ? (
        <div className="rounded-lg border border-border p-4" data-testid="infra-empty">
          <div className="text-sm font-medium text-foreground">No packs turned on</div>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Turning a pack on records that this project uses it and shows what it needs. It does
            not install anything or set anything up — that part is still yours.
          </p>
        </div>
      ) : (
        <section className="grid gap-2" data-testid="infra-enablements">
          {ordered.map((enablement) => {
            const readiness = describeReadiness(enablement);
            return (
              <div
                key={enablement.id}
                className="rounded-lg border border-border p-4"
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
                        <code className="text-foreground">{name}</code> — not set yet
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </section>
      )}
    </Shell>
  );
}
