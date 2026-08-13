import { PowerIcon } from "lucide-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import type { PackIdentity } from "@t3tools/contracts";

import { useShallow } from "zustand/react/shallow";

import { readEnvironmentApi } from "../../environmentApi";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

/**
 * Turns this pack on for one of the reader's projects.
 *
 * The copy is careful because the button is not: enabling records that the
 * project uses this pack and shows what it still needs. It installs nothing and
 * configures nothing, and a control that implied otherwise would be the most
 * misleading thing on the page.
 */
export function PackEnableControl({ identity }: { identity: PackIdentity }) {
  const environmentId = usePrimaryEnvironmentId();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState<string | null>(null);

  // The projects a person could turn this on for are already in the store; the
  // query is only for the workspace scope the registry needs.
  const projects = useStore(useShallow(selectProjectsAcrossEnvironments));

  const scope = useQuery({
    enabled: environmentId !== null,
    queryKey: ["pack-enable", "scope", environmentId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      const snapshot = await api.organizations.list();
      const workspace = (snapshot.workspaces ?? [])[0];
      if (!workspace) throw new Error("This session can see no workspace.");
      return { tenantId: workspace.tenantId, workspaceId: workspace.id };
    },
  });

  const enable = useMutation({
    mutationFn: async (projectId: string) => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || !scope.data) throw new Error("This window is not connected.");
      return api.packs.enable({
        ...scope.data,
        projectId: projectId as never,
        packId: identity.id,
        version: identity.version,
      });
    },
    onSuccess: (_result, projectId) => {
      toastManager.add({
        type: "success",
        title: `${identity.name} is on for this project`,
        description: "It records that the project uses this pack. Setting it up is still yours.",
      });
      void navigate({ to: "/infra/$projectId", params: { projectId } });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not turn that on",
        description: error instanceof Error ? error.message : "The request failed.",
      });
    },
  });

  const available = projects;

  return (
    <section className="rounded-lg border border-border p-4" data-testid="pack-detail-enable">
      <h2 className="text-sm font-medium text-foreground">Use it in a project</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        This records that a project uses this pack and shows what it still needs. It does not
        install anything or set anything up.
      </p>

      {available.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">No projects to turn it on for yet.</p>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          {available.slice(0, 6).map((project) => (
            <Button
              key={project.id}
              size="xs"
              variant={project.id === chosen ? "default" : "outline"}
              data-testid="pack-enable-project"
              onClick={() => setChosen(project.id)}
            >
              {project.name}
            </Button>
          ))}
          <Button
            size="xs"
            disabled={chosen === null || enable.isPending}
            data-testid="pack-enable-confirm"
            onClick={() => chosen !== null && enable.mutate(chosen)}
          >
            <PowerIcon />
            {enable.isPending ? "Turning on…" : "Turn on"}
          </Button>
        </div>
      )}
    </section>
  );
}
