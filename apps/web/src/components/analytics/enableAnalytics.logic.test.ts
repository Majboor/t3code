import { describe, expect, it } from "vitest";

import { buildEnableAnalyticsPrompt } from "./enableAnalytics.logic";

const stream = {
  name: "checkout.completed",
  purpose: "A completed checkout.",
  why: "The pack declares it emits checkout.completed from its backend.",
  properties: [{ name: "amount", type: "number" as const, required: false }],
};

describe("buildEnableAnalyticsPrompt", () => {
  it("is null before anything is live, because there is nothing to wire up yet", () => {
    expect(
      buildEnableAnalyticsPrompt({ subject: "acme/checkout", stream, deployment: null }),
    ).toBeNull();
  });

  it("is null when there is no stream worth opening", () => {
    expect(
      buildEnableAnalyticsPrompt({
        subject: "acme/checkout",
        stream: null,
        deployment: { name: "staging", url: null, reportsToCount: 0 },
      }),
    ).toBeNull();
  });

  it("names what is live, where, and the stream it should report", () => {
    const prompt = buildEnableAnalyticsPrompt({
      subject: "acme/checkout",
      stream,
      deployment: { name: "staging", url: "https://staging.example.test", reportsToCount: 0 },
    });

    expect(prompt).toContain("staging deployment of acme/checkout");
    expect(prompt).toContain("https://staging.example.test");
    expect(prompt).toContain("`checkout.completed` stream");
    expect(prompt).toContain("amount (number)");
  });

  it("does not say a deployment is 'of' itself when there is no pack behind it", () => {
    // The subject is the deployment for anything that is not a published pack —
    // "the staging deployment of staging" reads like a mistake because it is.
    const prompt = buildEnableAnalyticsPrompt({
      subject: "staging",
      stream,
      deployment: { name: "staging", url: null, reportsToCount: 0 },
    });

    expect(prompt).toContain("Make the staging deployment report");
    expect(prompt).not.toContain("deployment of staging");
  });

  it("asks for the code first and the redeploy second, because the key has no later", () => {
    const prompt = buildEnableAnalyticsPrompt({
      subject: "acme/checkout",
      stream,
      deployment: { name: "staging", url: null, reportsToCount: 0 },
    });

    const codeStep = prompt?.indexOf("Add the reporting to the code") ?? -1;
    const deployStep = prompt?.indexOf("Redeploy asking for") ?? -1;
    expect(codeStep).toBeGreaterThan(-1);
    expect(deployStep).toBeGreaterThan(codeStep);
    expect(prompt).toContain("cannot be fetched afterwards");
  });

  it("says the declaration should follow the code, so it can be corrected", () => {
    const prompt = buildEnableAnalyticsPrompt({
      subject: "acme/checkout",
      stream,
      deployment: { name: "staging", url: null, reportsToCount: 0 },
    });

    expect(prompt).toContain("the declaration should follow the events");
  });

  it("reads as a change when it already reports to something", () => {
    const prompt = buildEnableAnalyticsPrompt({
      subject: "acme/checkout",
      stream,
      deployment: { name: "staging", url: null, reportsToCount: 2 },
    });

    expect(prompt).toContain("Change what the staging deployment");
    expect(prompt).toContain("already reports to 2 streams");
  });

  it("tells the agent to work it out when the stream has no properties proposed", () => {
    const prompt = buildEnableAnalyticsPrompt({
      subject: "staging",
      stream: { ...stream, properties: [] },
      deployment: { name: "staging", url: null, reportsToCount: 0 },
    });

    expect(prompt).toContain("work out what is worth recording");
  });
});
