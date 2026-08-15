import * as Schema from "effect/Schema";

import { useLocalStorage } from "~/hooks/useLocalStorage";

/**
 * Whether the usage panel is offered in the app chrome at all.
 *
 * Kept in local storage rather than on the server because it is a preference
 * about this person's own chrome, not about the workspace: switching the panel
 * off must not look like opting out of being counted, which is a separate and
 * far more consequential choice made in the consent settings.
 */
export const USAGE_PANEL_SETTINGS_STORAGE_KEY = "t3code:usage-panel:v1";

export const UsagePanelSettingsSchema = Schema.Struct({
  enabled: Schema.Boolean,
});
export type UsagePanelSettings = typeof UsagePanelSettingsSchema.Type;

/**
 * On by default. What a workspace is spending is the kind of thing people only
 * go looking for once it has already surprised them, so it is offered up front
 * and switched off by anyone who does not want it.
 */
export const DEFAULT_USAGE_PANEL_SETTINGS: UsagePanelSettings = {
  enabled: true,
};

export function useUsagePanelSettings(): [
  UsagePanelSettings,
  (update: (previous: UsagePanelSettings) => UsagePanelSettings) => void,
] {
  return useLocalStorage(
    USAGE_PANEL_SETTINGS_STORAGE_KEY,
    DEFAULT_USAGE_PANEL_SETTINGS,
    UsagePanelSettingsSchema,
  );
}
