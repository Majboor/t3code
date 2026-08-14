/**
 * Whether the prompt bar offers packs, and how it looks when it does.
 *
 * Kept in the browser rather than on the server: it is a preference about
 * this person's own composer, and making it a workspace setting would mean
 * one person turning it off for everybody.
 *
 * Reading a stored value that is not one of the shapes we know about falls
 * back to the default rather than throwing — a bad key in localStorage should
 * not be able to stop the composer rendering.
 */
import { useCallback, useEffect, useState } from "react";

export type PackSuggestionLayout = "inline" | "stacked";

export interface PackSuggestionSettings {
  readonly enabled: boolean;
  readonly layout: PackSuggestionLayout;
}

export const DEFAULT_PACK_SUGGESTION_SETTINGS: PackSuggestionSettings = {
  // On by default: the packs exist to stop a known failure, and somebody who
  // has never seen one cannot decide whether they want them.
  enabled: true,
  layout: "inline",
};

const STORAGE_KEY = "t3.packSuggestions";

/** Exported so a test can assert the fallback without touching a browser. */
export function parseSettings(raw: string | null): PackSuggestionSettings {
  if (raw === null) {
    return DEFAULT_PACK_SUGGESTION_SETTINGS;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PackSuggestionSettings>;
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : true,
      layout: parsed.layout === "stacked" ? "stacked" : "inline",
    };
  } catch {
    return DEFAULT_PACK_SUGGESTION_SETTINGS;
  }
}

function canStore(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

export function usePackSuggestionSettings(): {
  readonly settings: PackSuggestionSettings;
  readonly update: (next: Partial<PackSuggestionSettings>) => void;
} {
  const [settings, setSettings] = useState<PackSuggestionSettings>(
    DEFAULT_PACK_SUGGESTION_SETTINGS,
  );

  // Read after mount rather than in the initial state, so the first render is
  // the same on the server and in the browser.
  useEffect(() => {
    if (canStore()) {
      setSettings(parseSettings(localStorage.getItem(STORAGE_KEY)));
    }
  }, []);

  const update = useCallback((next: Partial<PackSuggestionSettings>) => {
    setSettings((current) => {
      const merged = { ...current, ...next };
      if (canStore()) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          // A full or blocked store is not worth failing a click over; the
          // preference simply will not outlive the session.
        }
      }
      return merged;
    });
  }, []);

  return { settings, update };
}
