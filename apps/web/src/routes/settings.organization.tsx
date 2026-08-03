import { createFileRoute } from "@tanstack/react-router";

import { OrganizationAdminPanel } from "../components/settings/OrganizationAdminPanel";

export const Route = createFileRoute("/settings/organization")({
  component: OrganizationAdminPanel,
});
