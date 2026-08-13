import { createFileRoute } from "@tanstack/react-router";

import type { ProjectId } from "@t3tools/contracts";

import { InfraPage } from "../components/infra/InfraPage";

function InfraRouteView() {
  const { projectId } = Route.useParams();
  return <InfraPage projectId={projectId as ProjectId} />;
}

export const Route = createFileRoute("/_chat/infra/$projectId")({
  component: InfraRouteView,
});
