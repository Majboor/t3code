import { createFileRoute } from "@tanstack/react-router";

import { UsageActivitySettings } from "../components/settings/UsageActivitySettings";

export const Route = createFileRoute("/settings/usage-activity")({
  component: UsageActivitySettings,
});
