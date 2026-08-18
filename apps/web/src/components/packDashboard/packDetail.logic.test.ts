import type {
  PackFailureMode,
  PackIntegration,
  PackKnowledge,
  PackRelease,
  PackRequirements,
  PackRuntime,
  PackScarRecord,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  countKnowledgeIntroducedIn,
  describeConditions,
  describeFailureStanding,
  describePublication,
  describeReleaseLearning,
  describeReleaseSignals,
  describeRequirements,
  describeScarRecord,
  describeScarRecordBrief,
  buildDeployPrompt,
  describeStaleness,
  describeVisibilityChange,
  formatObservedMonth,
  listIntegrationTargets,
  orderFailureModes,
  parsePackRouteSearch,
  resolveIntegrationPrompt,
  summariseRunningCost,
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

  it("names the moment the release became visible, which the copy is about", () => {
    const description = describeVisibilityChange("workspace", "public", PROVEN_RECORD, {
      version: "1.2.0",
      cutAt: "2026-07-29T16:20:00.000Z",
      publications: [{ scope: "workspace", at: "2026-07-30T09:00:00.000Z" }],
    });

    expect(description.sinceLine).toContain("1.2.0: Visible in this workspace since 30 July 2026.");
    expect(description.sinceLine).toContain("Confirming dates it from this moment");
  });

  it("says nothing about a date it does not have", () => {
    expect(describeVisibilityChange("workspace", "public", PROVEN_RECORD).sinceLine).toBeNull();
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
  it("counts what has to be supplied without pricing it in the same breath", () => {
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
      "You supply 1 value, 1 third-party account and 1 service.",
    );
  });

  it("treats an empty requirements block as the affirmative claim it is", () => {
    expect(describeRequirements({})).toContain("needs nothing supplied");
  });
});

describe("summariseRunningCost", () => {
  it("counts the services, not only the accounts, so the total is not an undercount", () => {
    const summary = summariseRunningCost({
      accounts: [
        {
          service: "stripe",
          displayName: "Stripe",
          purpose: "Payments.",
          costsMoney: true,
          cost: { model: "metered", billedOn: "A percentage of every payment." },
        },
      ],
      services: [
        { kind: "postgres", name: "orders", purpose: "Orders.", cost: { model: "free-tier" } },
        { kind: "object-storage", name: "receipts", purpose: "Receipts.", cost: { model: "free" } },
      ],
    });

    expect(summary.paying).toEqual(["Stripe", "orders"]);
    expect(summary.free).toEqual(["receipts"]);
    expect(summary.line).toContain("Stripe and orders cost money to run.");
  });

  it("treats silence about cost as unknown rather than as free", () => {
    const summary = summariseRunningCost({
      services: [{ kind: "postgres", name: "orders", purpose: "Orders." }],
    });

    expect(summary.paying).toEqual([]);
    expect(summary.undeclared).toEqual(["orders"]);
    expect(summary.line).toContain("nothing is not free");
  });

  it("says plainly when a pack bills nothing at all", () => {
    expect(summariseRunningCost({}).line).toContain("Nothing here bills");
  });
});

describe("describeStaleness", () => {
  const now = new Date("2026-08-08T00:00:00.000Z");

  it("ages a console path and a protocol invariant differently at the same age", () => {
    const consolePath = describeStaleness(
      {
        observedAt: "2026-05-01T00:00:00.000Z",
        rot: { basis: "assumed", surface: "console-navigation" },
      },
      now,
    );
    const invariant = describeStaleness(
      {
        observedAt: "2026-05-01T00:00:00.000Z",
        rot: { basis: "assumed", surface: "protocol-invariant" },
      },
      now,
    );

    expect(consolePath.state).toBe("stale");
    expect(consolePath.line).toContain("Assume it has moved");
    expect(invariant.state).toBe("durable");
    expect(invariant.line).toContain("does not go stale with time");
  });

  it("says whether the half-life was measured or assumed", () => {
    const measured = describeStaleness(
      {
        observedAt: "2026-07-30T00:00:00.000Z",
        rot: {
          basis: "observed",
          surface: "console-navigation",
          halfLifeDays: 63,
          fromInstalls: 27,
          measuredAt: "2026-08-07T18:00:00.000Z",
        },
      },
      now,
    );

    expect(measured.state).toBe("fresh");
    expect(measured.line).toContain("measured across 27 installs");
  });

  it("admits when nothing says how fast the entry rots", () => {
    const unrated = describeStaleness({ observedAt: "2026-05-01T00:00:00.000Z" }, now);

    expect(unrated.state).toBe("unrated");
    expect(unrated.line).toContain("nothing says how fast");
  });
});

describe("describeFailureStanding", () => {
  it("reads a recurrence as a fix that is not holding, not as a confirmation", () => {
    const recurring = describeFailureStanding({
      state: "recurring",
      heldInDeployments: 0,
      recurredInDeployments: 4,
    });

    expect(recurring).toContain("Still recurring");
    expect(recurring).toContain("4 deployments");
  });

  it("says a resolution is holding in the deployments that took it", () => {
    expect(
      describeFailureStanding({
        state: "holding",
        heldInDeployments: 26,
        recurredInDeployments: 0,
        lastCheckedAt: "2026-08-07T06:00:00.000Z",
      }),
    ).toBe("Holding in 26 deployments since, with 0 recurrences. Last checked 7 August 2026.");
  });
});

describe("describePublication", () => {
  const published: PackRelease = {
    version: "1.1.0",
    cutAt: "2026-05-02T18:00:00.000Z",
    publications: [
      { scope: "workspace", at: "2026-05-03T08:00:00.000Z" },
      { scope: "tenant", at: "2026-05-20T11:00:00.000Z" },
      { scope: "workspace", at: "2026-06-21T09:00:00.000Z" },
    ],
  };

  it("dates a release from when it became visible, not from when it was cut", () => {
    const description = describePublication(published);

    expect(description.scope).toBe("workspace");
    expect(description.since).toBe("2026-06-21T09:00:00.000Z");
    expect(description.line).toBe("Visible in this workspace since 21 June 2026.");
  });

  it("keeps a window it was once wider, which one timestamp cannot hold", () => {
    expect(describePublication(published).narrowed).toBe(
      "It was visible across this tenant from 20 May 2026 until 21 June 2026. Installs made in that window are still out there.",
    );
  });

  it("tells a release nobody published apart from one published the day it was cut", () => {
    const description = describePublication({
      version: "0.1.0",
      cutAt: "2026-08-08T08:40:00.000Z",
      publications: [],
    });

    expect(description.scope).toBeNull();
    expect(description.line).toContain("never published");
  });
});

describe("describeReleaseLearning", () => {
  const knowledge: PackKnowledge = {
    failureModes: [
      makeFailureMode("double-charge", {
        introducedIn: "1.1.0",
        resolution: { kind: "fixed", inVersion: "1.1.0", change: "Wrote the event id." },
      }),
    ],
    integration: [],
  };

  it("reads a release by what it closed and what it taught, with no note to write", () => {
    expect(describeReleaseLearning(knowledge, "1.1.0")).toBe(
      "Fixed: Something goes wrong. Brought 1 piece of knowledge with it.",
    );
  });

  it("says nothing rather than inventing a line for a release that learned nothing", () => {
    expect(describeReleaseLearning(knowledge, "1.2.0")).toBeNull();
  });
});

describe("describeReleaseSignals", () => {
  it("keeps a release's own behaviour separate from the line's", () => {
    expect(
      describeReleaseSignals({
        measuredAt: "2026-08-08T00:00:00.000Z",
        scope: "release",
        installsAttempted: 13,
        installsSucceeded: 11,
        deploymentsAttempted: 11,
        deploymentsSurviving: 8,
        cumulativeServiceDays: 96,
        breakagesCaught: 1,
        breakagesFixed: 0,
      }),
    ).toBe("8 of 11 deployments on this release still running · 96 deployment-days");
  });

  it("says a fresh release has run nowhere instead of borrowing the line's record", () => {
    expect(
      describeReleaseSignals({
        measuredAt: "2026-08-08T00:00:00.000Z",
        scope: "release",
        installsAttempted: 0,
        installsSucceeded: 0,
        deploymentsAttempted: 0,
        deploymentsSurviving: 0,
        cumulativeServiceDays: 0,
        breakagesCaught: 0,
        breakagesFixed: 0,
      }),
    ).toBe("Nothing has run this release yet.");
  });
});

describe("parsePackRouteSearch", () => {
  it("keeps a version and drops anything else", () => {
    expect(parsePackRouteSearch({ version: " 1.1.0 ", other: "x" })).toEqual({ version: "1.1.0" });
    expect(parsePackRouteSearch({ version: "  " })).toEqual({});
    expect(parsePackRouteSearch({ version: 3 })).toEqual({});
  });
});

describe("buildDeployPrompt", () => {
  const runtime = {
    target: "node",
    commands: {
      install: { command: "bun install" },
      build: { command: "bun run build" },
      start: { command: "bun run start", cwd: "./server" },
    },
  } as unknown as PackRuntime;

  const requirements = {
    environment: [
      { name: "DEPLOY_HOST", purpose: "where it goes", secret: false, required: true },
      { name: "DEPLOY_TOKEN", purpose: "auth", secret: true, required: true },
      { name: "DEBUG", purpose: "noise", secret: false, required: false },
    ],
  } as unknown as PackRequirements;

  it("describes how the pack starts and what it needs", () => {
    const prompt = buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements });
    expect(prompt).toContain("Set up a deploy target for the acme/checkout pack.");
    expect(prompt).toContain("It starts with `bun run start` from ./server.");
    expect(prompt).toContain("install with `bun install`, then build with `bun run build`");
    expect(prompt).toContain("DEPLOY_HOST, DEPLOY_TOKEN (secret)");
  });

  it("asks for the host and credentials rather than inventing them", () => {
    const prompt = buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements });
    expect(prompt).toContain("Ask me for the host and credentials before running anything.");
  });

  it("leaves out optional variables, which are not what blocks a deploy", () => {
    const prompt = buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements });
    expect(prompt).not.toContain("DEBUG");
  });

  it("carries no placeholder for the reader to fill in", () => {
    const prompt = buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements });
    expect(prompt).not.toContain("<");
  });

  it("says so when the pack never declares what starts it", () => {
    const prompt = buildDeployPrompt({
      qualifiedName: "acme/checkout",
      runtime: { target: "node", commands: { build: { command: "bun run build" } } } as never,
      requirements: {} as never,
    });
    expect(prompt).toContain("declares no start command");
  });

  it("is null for a library, which has nothing to start", () => {
    expect(
      buildDeployPrompt({
        qualifiedName: "acme/parser",
        runtime: { target: "node", commands: {} } as never,
        requirements: {} as never,
      }),
    ).toBeNull();
  });

  it("names the stream the pack itself declared, with its properties", () => {
    const prompt = buildDeployPrompt({
      qualifiedName: "acme/checkout",
      runtime,
      requirements,
      analytics: {
        events: [
          {
            name: "checkout.completed",
            source: "backend",
            description: "A completed checkout.",
            properties: [
              { name: "amount", type: "number", pii: false },
              { name: "email", type: "string", pii: true },
            ],
          },
        ],
      } as never,
    });

    expect(prompt).toContain("`checkout.completed` stream");
    expect(prompt).toContain("amount (number)");
    // Marked as personal data in the manifest, so it does not get declared into
    // a stream that has nowhere to record that.
    expect(prompt).not.toContain("email");
  });

  it("asks for the key during the deploy, because there is no later", () => {
    const prompt = buildDeployPrompt({
      qualifiedName: "acme/checkout",
      runtime,
      requirements,
      analytics: {
        events: [
          { name: "checkout.completed", source: "backend", description: "A completed checkout." },
        ],
      } as never,
    });

    expect(prompt).toContain("cannot be retrieved later");
  });

  it("falls back to an inferred stream when the pack declared no analytics", () => {
    const prompt = buildDeployPrompt({
      qualifiedName: "acme/checkout",
      runtime: {
        target: "node",
        commands: { start: { command: "bun run start" } },
      } as never,
      requirements: {} as never,
    });

    expect(prompt).toContain("`run.completed` stream");
  });
});

describe("buildDeployPrompt targets", () => {
  const runtime = {
    target: "node",
    commands: { start: { command: "bun run start" } },
  } as unknown as PackRuntime;
  const requirements = {} as unknown as PackRequirements;

  const promptFor = (target: "cloud" | "local-tunnel" | "local-only") =>
    buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements, target }) ?? "";

  it("sends a cloud deploy over SSH and keeps the password off the command line", () => {
    const prompt = promptFor("cloud");
    expect(prompt).toContain("`cloud` target");
    expect(prompt).toContain("server secret store");
    expect(prompt).toContain("never on the command line");
  });

  it("opens a tunnel for a local deploy that should be reachable", () => {
    const prompt = promptFor("local-tunnel");
    expect(prompt).toContain("`local` target");
    expect(prompt).toContain("cloudflared tunnel --url");
    expect(prompt).toContain("changes every time the tunnel restarts");
  });

  it("keeps a localhost-only deploy off the internet, and says so", () => {
    const prompt = promptFor("local-only");
    expect(prompt).toContain("Do not open a tunnel");
    expect(prompt).not.toContain("cloudflared tunnel --url");
  });

  it("does not ask for a host when nothing is being deployed to one", () => {
    // Asking for credentials before a loopback deploy asks for something that
    // does not exist.
    expect(promptFor("local-only")).not.toContain("Ask me for");
    expect(promptFor("local-tunnel")).not.toContain("Ask me for");
    expect(promptFor("cloud")).toContain("Ask me for");
  });

  it("keeps the old wording when no target is chosen", () => {
    const prompt = buildDeployPrompt({ qualifiedName: "acme/checkout", runtime, requirements });
    expect(prompt).toContain("t3 deploy add");
  });
});
