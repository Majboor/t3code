import { useUserPreferences } from "../../hooks/useUserPreferences";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/**
 * The three settings the onboarding questionnaire only ever sets an
 * *initial* default for. Every one stays independently toggleable here
 * regardless of what (if anything) was answered at signup.
 */
export function PersonalizationSettingsSection() {
  const { preferences, set } = useUserPreferences();
  if (!preferences) return null;

  return (
    <SettingsSection title="Personalization">
      <SettingsRow
        title="Organization settings"
        description="Show organization/agency-level settings and controls."
        control={
          <Switch
            checked={preferences.orgSettingsVisible}
            onCheckedChange={(checked) => void set({ orgSettingsVisible: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Vibe mode"
        description="Skip picking a model - always use the best one automatically. Usage limits and rate-limit reasons are still always shown."
        control={
          <Switch
            checked={preferences.vibeModeEnabled}
            onCheckedChange={(checked) => void set({ vibeModeEnabled: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="API usage tab"
        description="Show the API usage tab in Settings."
        control={
          <Switch
            checked={preferences.apiUsageTabVisible}
            onCheckedChange={(checked) => void set({ apiUsageTabVisible: Boolean(checked) })}
          />
        }
      />
    </SettingsSection>
  );
}
