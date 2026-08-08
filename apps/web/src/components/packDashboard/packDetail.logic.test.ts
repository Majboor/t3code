import type {
  PackFailureMode,
  PackIntegration,
  PackKnowledge,
  PackRequirements,
  PackScarRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  countKnowledgeIntroducedIn,
  describeConditions,
  describeRequirements,
  describeScarRecord,
  describeScarRecordBrief,
  describeVisibilityChange,
  formatObservedMonth,
  listIntegrationTargets,
  orderFailureModes,
  parsePackRouteSearch,
  resolveIntegrationPrompt,
} from "./packDetail.logic";

const EMPTY_RECORD: PackScarRecord = {
  measuredAt: "2026-08-08T00:00:00.000Z",
  installsAttempted: 0,
  installsSucceeded: 0,
  deploymentsAttempted: 0,
  deploymentsSurviving: 0,
  cumulativeServiceDays: 0,
  breakagesCaught: 0,
  breakagesFixed: 0,
};

const PROVEN_RECORD: PackScarRecord = {
  measuredAt: "2026-08-08T00:00:00.000Z",
  installsAttempted: 41,
  installsSucceeded: 37,
  deploymentsAttempted: 37,
  deploymentsSurviving: 29,
  cumulativeServiceDays: 2940,
  breakagesCaught: 2,
  breakagesFixed: 1,
};

function makeFailureMode(
  id: string,
  overrides: {
    readonly resolution?: PackFailureMode["resolution"];
    readonly severity?: PackFailureMode["severity"];
    readonly deploymentsAffected?: number;
    readonly introducedIn?: string;
  } = {},
): PackFailureMode {
  return {
    id,
    symptom: "Something goes wrong.",
    trigger: "Under a retry.",
    attributedTo: { kind: "pack" },
    severity: overrides.severity ?? "medium",
    resolution: overrides.resolution ?? { kind: "fixed", inVersion: "1.1.0", change: "Fixed it." },
    firstSeenAt: "2026-05-02T04:19:00.000Z",
    deploymentsAffected: overrides.deploymentsAffected ?? 1,
    conditions: { observedAt: "2026-05-02T04:19:00.000Z" },
    origin: {
      introducedIn: overrides.introducedIn ?? "1.1.0",
      source: { kind: "maintenance-agent", provider: "claudeAgent" },
      recordedAt: "2026-05-02T05:00:00.000Z",
    },
  };
}

describe("formatObservedMonth", () => {
  it("reads the month in UTC, so the caveat does not slip a month for a western reader", () => {
    expect(formatObservedMonth("2026-06-01T00:30:00.000Z")).toBe("June 2026");
    expect(formatObservedMonth("2026-01-31T23:30:00.000Z")).toBe("January 2026");
  });

  it("gives back an unparseable value untouched", () => {
    expect(formatObservedMonth("whenever")).toBe("whenever");
  });
});

describe("describeConditions", () => {
  it("names the axes a claim was narrowed to and the ones nobody varied", () => {
    const description = describeConditions({
      observedAt: "2026-06-18T22:40:00.000Z",
      accountTier: "standard",
      regions: ["us", "eu-west-1"],
      consoleVersion: "2026.07",
      observedAcrossDeployments: 26,
      untestedAxes: ["account-tier", "region"],
    });

    expect(description.observed).toBe(
      "Observed in June 2026, on standard-tier, in us and eu-west-1, against console 2026.07, across 26 deployments.",
    );
    expect(description.untested).toBe(
      "Account tier and region were never varied — yours may differ.",
    );
  });

  it("says one sighting is an anecdote rather than letting it read as a fact", () => {
    const description = describeConditions({
      observedAt: "2026-06-18T22:40:00.000Z",
      observedAcrossDeployments: 1,
    });

    expect(description.observed).toContain("in one deployment — an anecdote so far.");
  });

  it("distinguishes an unrecorded context from a recorded but unvaried one", () => {
    const nothingRecorded = describeConditions({ observedAt: "2026-06-18T22:40:00.000Z" });
    expect(nothingRecorded.untested).toContain("nothing to compare yours against");

    const narrowed = describeConditions({
      observedAt: "2026-06-18T22:40:00.000Z",
      accountTier: "standard",
    });
    expect(narrowed.untested).toContain("Any axis not named here is unknown");
  });
});

describe("describeScarRecord", () => {
  it("says plainly that nothing has run behind a zeroed record", () => {
    const description = describeScarRecord(EMPTY_RECORD);
    expect(description.hasProduction).toBe(false);
    expect(description.headline).toContain("Nothing has run behind this yet");
    expect(describeScarRecordBrief(EMPTY_RECORD)).toBe("Nothing has run behind this yet");
  });

  it("keeps the denominator beside every count and never states a rate", () => {
    const description = describeScarRecord(PROVEN_RECORD);
    expect(description.hasProduction).toBe(true);
    expect(description.headline).toBe(
      "29 of 37 deployments still running · 2940 deployment-days · 2 breakages caught, 1 fixed",
    );
    expect(description.headline).not.toContain("%");
  });
});

describe("describeVisibilityChange", () => {
  it("warns that an unproven pack publishes as zeros before it is published", () => {
    const description = describeVisibilityChange("workspace", "public", EMPTY_RECORD);
    expect(description.widening).toBe(true);
    expect(description.confirmLabel).toBe("Publish");
    expect(description.warning).toContain("publishes with a record of zeros");
  });

  it("drops the warning once there is production behind the pack", () => {
    expect(describeVisibilityChange("workspace", "public", PROVEN_RECORD).warning).toBeNull();
  });

  it("describes withdrawal as narrowing, and says the running deployments stay", () => {
    const description = describeVisibilityChange("public", "workspace", PROVEN_RECORD);
    expect(description.widening).toBe(false);
    expect(description.consequence).toContain("keep running");
    expect(description.warning).toBeNull();
  });
});

describe("integration prompts", () => {
  const integration: PackIntegration = {
    prompt: "Generic instructions.",
    variants: [
      { target: "lovable", prompt: "Lovable instructions." },
      { target: "lovable", prompt: "A duplicate nobody should see twice." },
    ],
  };

  it("offers the generic target first and each declared target once", () => {
    expect(listIntegrationTargets(integration)).toEqual(["generic", "lovable"]);
  });

  it("offers no target the manifest does not carry a variant for", () => {
    expect(listIntegrationTargets({ prompt: "Generic instructions." })).toEqual(["generic"]);
  });

  it("falls back to the generic prompt rather than inventing a variant", () => {
    expect(resolveIntegrationPrompt(integration, "lovable")).toBe("Lovable instructions.");
    expect(resolveIntegrationPrompt(integration, "replit")).toBe("Generic instructions.");
  });
});

describe("orderFailureModes", () => {
  it("puts what is still open above what a release already fixed", () => {
    const ordered = orderFailureModes([
      makeFailureMode("fixed-critical", {
        severity: "critical",
        resolution: { kind: "fixed", inVersion: "1.1.0", change: "Fixed." },
      }),
      makeFailureMode("open-low", {
        severity: "low",
        resolution: { kind: "open", currentAdvice: "Watch for it." },
      }),
      makeFailureMode("mitigated-high", {
        severity: "high",
        resolution: { kind: "mitigated", workaround: "Retry it." },
      }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual([
      "open-low",
      "mitigated-high",
      "fixed-critical",
    ]);
  });

  it("breaks a tie on severity, then on how many deployments were hit", () => {
    const ordered = orderFailureModes([
      makeFailureMode("few", { severity: "critical", deploymentsAffected: 2 }),
      makeFailureMode("many", { severity: "critical", deploymentsAffected: 11 }),
      makeFailureMode("milder", { severity: "low", deploymentsAffected: 99 }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(["many", "few", "milder"]);
  });
});

describe("countKnowledgeIntroducedIn", () => {
  const knowledge: PackKnowledge = {
    failureModes: [
      makeFailureMode("a", { introducedIn: "1.1.0" }),
      makeFailureMode("b", { introducedIn: "1.2.0" }),
    ],
    integration: [
      {
        id: "c",
        title: "How to get the key",
        detail: { kind: "pattern", rule: "Do the thing.", rationale: "Because." },
        conditions: { observedAt: "2026-05-02T04:19:00.000Z" },
        origin: {
          introducedIn: "1.1.0",
          source: { kind: "human-report" },
          recordedAt: "2026-05-02T05:00:00.000Z",
        },
      },
    ],
  };

  it("counts both kinds of knowledge against the release that introduced them", () => {
    expect(countKnowledgeIntroducedIn(knowledge, "1.1.0")).toBe(2);
    expect(countKnowledgeIntroducedIn(knowledge, "1.2.0")).toBe(1);
  });

  it("counts nothing for a release this manifest had not reached", () => {
    expect(countKnowledgeIntroducedIn(knowledge, "1.3.0")).toBe(0);
  });
});

describe("describeRequirements", () => {
  it("names the account that costs money, because that is what rules a pack out", () => {
    const requirements: PackRequirements = {
      environment: [
        { name: "STRIPE_SECRET_KEY", purpose: "Calls.", secret: true, required: true },
        { name: "DEBUG_MODE", purpose: "Noise.", secret: false, required: false },
      ],
      accounts: [
        { service: "stripe", displayName: "Stripe", purpose: "Payments.", costsMoney: true },
      ],
      services: [{ kind: "postgres", name: "orders", purpose: "Orders." }],
    };

    expect(describeRequirements(requirements)).toBe(
      "You supply 1 value, 1 third-party account (Stripe costs money) and 1 service.",
    );
  });

  it("treats an empty requirements block as the affirmative claim it is", () => {
    expect(describeRequirements({})).toContain("needs nothing supplied");
  });
});

describe("parsePackRouteSearch", () => {
  it("keeps a version and drops anything else", () => {
    expect(parsePackRouteSearch({ version: " 1.1.0 ", other: "x" })).toEqual({ version: "1.1.0" });
    expect(parsePackRouteSearch({ version: "  " })).toEqual({});
    expect(parsePackRouteSearch({ version: 3 })).toEqual({});
  });
});
