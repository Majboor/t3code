import { createFileRoute } from "@tanstack/react-router";

import { AccountSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/settings/account")({
  component: AccountSettingsPanel,
});
