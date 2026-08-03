import { createFileRoute } from "@tanstack/react-router";

import { WorkspaceDashboard } from "../components/WorkspaceDashboard";

function ChatIndexRouteView() {
  return <WorkspaceDashboard />;
}

export const Route = createFileRoute("/_chat/")({
  component: ChatIndexRouteView,
});
