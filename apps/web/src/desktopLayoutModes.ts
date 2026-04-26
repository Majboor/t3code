import type { DesktopLayoutMode, UnifiedSettings } from "@t3tools/contracts/settings";

export type DesktopLayoutKind = "vibe" | "dev";
export type DesktopLayoutPanel = "none" | "workspace" | "diff";

export interface DesktopLayoutModeDefinition {
  id: DesktopLayoutMode;
  label: string;
  description: string;
  layout: DesktopLayoutKind;
  defaultPanel: DesktopLayoutPanel;
  autoOpenPanel: DesktopLayoutPanel;
  showAutoOpenToast: boolean;
}

const DEFAULT_DESKTOP_LAYOUT_MODE_DEFINITIONS: readonly DesktopLayoutModeDefinition[] = [
  {
    id: "vibe",
    label: "Vibe",
    description: "Projects · Chat · Workspace",
    layout: "vibe",
    defaultPanel: "none",
    autoOpenPanel: "none",
    showAutoOpenToast: false,
  },
  {
    id: "dev",
    label: "Dev",
    description: "Workspace · Chat · Projects",
    layout: "dev",
    defaultPanel: "workspace",
    autoOpenPanel: "workspace",
    showAutoOpenToast: true,
  },
];

export const DESKTOP_LAYOUT_MODES_JSON_EXAMPLE = JSON.stringify(
  {
    modes: DEFAULT_DESKTOP_LAYOUT_MODE_DEFINITIONS,
  },
  null,
  2,
);

function normalizePanel(value: unknown, fallback: DesktopLayoutPanel): DesktopLayoutPanel {
  return value === "workspace" || value === "diff" || value === "none" ? value : fallback;
}

function normalizeLayoutKind(value: unknown, fallback: DesktopLayoutKind): DesktopLayoutKind {
  return value === "dev" || value === "vibe" ? value : fallback;
}

function normalizeModeDefinition(
  input: unknown,
  fallback?: DesktopLayoutModeDefinition,
): DesktopLayoutModeDefinition | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const record = input as Record<string, unknown>;
  const rawId = typeof record.id === "string" ? record.id.trim() : "";
  const id = rawId || fallback?.id || "";
  if (!id) {
    return null;
  }

  const label =
    typeof record.label === "string" && record.label.trim()
      ? record.label.trim()
      : (fallback?.label ?? id);
  const layout = normalizeLayoutKind(record.layout, fallback?.layout ?? "vibe");
  const defaultPanel = normalizePanel(record.defaultPanel, fallback?.defaultPanel ?? "none");
  const autoOpenPanel = normalizePanel(
    record.autoOpenPanel,
    fallback?.autoOpenPanel ?? defaultPanel,
  );
  const showAutoOpenToast =
    typeof record.showAutoOpenToast === "boolean"
      ? record.showAutoOpenToast
      : (fallback?.showAutoOpenToast ?? false);

  return {
    id,
    label,
    description:
      typeof record.description === "string" && record.description.trim()
        ? record.description.trim()
        : (fallback?.description ??
          (layout === "dev" ? "Workspace · Chat · Projects" : "Projects · Chat · Workspace")),
    layout,
    defaultPanel,
    autoOpenPanel,
    showAutoOpenToast,
  };
}

export function resolveDesktopLayoutModeDefinitions(
  settings: Pick<UnifiedSettings, "desktopLayoutModesJson">,
): readonly DesktopLayoutModeDefinition[] {
  const definitions = new Map(
    DEFAULT_DESKTOP_LAYOUT_MODE_DEFINITIONS.map((definition) => [definition.id, definition]),
  );
  const rawJson = settings.desktopLayoutModesJson.trim();
  if (!rawJson) {
    return Array.from(definitions.values());
  }

  try {
    const parsed = JSON.parse(rawJson) as unknown;
    const rawModes = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { modes?: unknown }).modes)
        ? (parsed as { modes: unknown[] }).modes
        : [];
    for (const rawMode of rawModes) {
      const rawId =
        rawMode &&
        typeof rawMode === "object" &&
        typeof (rawMode as { id?: unknown }).id === "string"
          ? (rawMode as { id: string }).id.trim()
          : "";
      const normalized = normalizeModeDefinition(rawMode, definitions.get(rawId));
      if (normalized) {
        definitions.set(normalized.id, normalized);
      }
    }
  } catch {
    return Array.from(definitions.values());
  }

  return Array.from(definitions.values());
}

export function resolveDesktopLayoutModeDefinition(
  settings: Pick<UnifiedSettings, "desktopLayoutMode" | "desktopLayoutModesJson">,
): DesktopLayoutModeDefinition {
  const definitions = resolveDesktopLayoutModeDefinitions(settings);
  return (
    definitions.find((definition) => definition.id === settings.desktopLayoutMode) ??
    definitions.find((definition) => definition.id === "vibe") ??
    DEFAULT_DESKTOP_LAYOUT_MODE_DEFINITIONS[0]!
  );
}
