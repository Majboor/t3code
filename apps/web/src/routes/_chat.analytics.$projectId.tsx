import { createFileRoute } from "@tanstack/react-router";

import type { ProjectId } from "@t3tools/contracts";

import { AnalyticsPage } from "../components/analytics/AnalyticsPage";

function AnalyticsRouteView() {
  const { projectId } = Route.useParams();
  return <AnalyticsPage projectId={projectId as ProjectId} />;
}

export const Route = createFileRoute("/_chat/analytics/$projectId")({
  component: AnalyticsRouteView,
});
