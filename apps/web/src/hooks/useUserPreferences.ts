import type { UpdateUserPreferencesInput, UserPreferences } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { fetchUserPreferences, updateUserPreferences } from "../environments/primary";

/**
 * The three settings onboarding sets an initial default for — each stays
 * independently toggleable here regardless of what (if anything) onboarding
 * answered. `null` means "not loaded yet"; callers should treat that as "use
 * the same defaults a skip would produce" rather than blocking rendering.
 */
export function useUserPreferences(): {
  readonly preferences: UserPreferences | null;
  readonly set: (input: UpdateUserPreferencesInput) => Promise<void>;
} {
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchUserPreferences()
      .then((result) => {
        if (!cancelled) setPreferences(result);
      })
      .catch(() => {
        // Leave as null - callers fall back to defaults rather than blocking.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const set = async (input: UpdateUserPreferencesInput) => {
    const result = await updateUserPreferences(input);
    setPreferences(result);
  };

  return { preferences, set };
}
