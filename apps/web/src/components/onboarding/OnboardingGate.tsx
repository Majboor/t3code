"use client";

import { useEffect, useState } from "react";

import { fetchUserPreferences } from "../../environments/primary";
import { OnboardingModal } from "./OnboardingModal";

/**
 * Mounted once inside the authenticated app shell. Checks once whether this
 * account has completed (or skipped) the product-personalization
 * questionnaire, and shows it if not — covers every way a user can become
 * authenticated (signup, quick-login, invite), not just one specific form.
 */
export function OnboardingGate() {
  const [shouldShow, setShouldShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchUserPreferences()
      .then((preferences) => {
        if (!cancelled && !preferences.onboardingCompleted) setShouldShow(true);
      })
      .catch(() => {
        // If preferences can't be loaded, don't block the app on it.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!shouldShow) return null;
  return <OnboardingModal onDone={() => setShouldShow(false)} />;
}
