import { createFileRoute } from "@tanstack/react-router";

import { StorageSettings } from "../components/settings/StorageSettings";

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettings,
});
