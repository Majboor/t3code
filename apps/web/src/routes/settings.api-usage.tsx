import { createFileRoute } from "@tanstack/react-router";

import { ApiUsageSettings } from "../components/settings/ApiUsageSettings";

export const Route = createFileRoute("/settings/api-usage")({
  component: ApiUsageSettings,
});
