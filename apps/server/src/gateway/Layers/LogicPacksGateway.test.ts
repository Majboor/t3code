import { describe, expect, it } from "vitest";

import { parseGatewayPlanCatalogue } from "./LogicPacksGateway.ts";

describe("parseGatewayPlanCatalogue", () => {
  it("reads a bare array and a { plans } envelope the same way", () => {
    const rows = [{ code: "free", name: "Free", price_usd_monthly: 0, included_tokens: "2000000" }];
    expect(parseGatewayPlanCatalogue(rows)).toEqual(parseGatewayPlanCatalogue({ plans: rows }));
  });

  it("keeps the gateway's own prices, including free", () => {
    expect(
      parseGatewayPlanCatalogue([
        { code: "free", name: "Free", price_usd_monthly: 0, included_tokens: "2000000" },
        { code: "pro", name: "Pro", price_usd: "12", included_tokens: "180000000" },
      ]),
    ).toEqual([
      {
        code: "free",
        name: "Free",
        priceUsdMonthly: 0,
        includedTokens: "2000000",
        description: null,
      },
      {
        code: "pro",
        name: "Pro",
        priceUsdMonthly: 12,
        includedTokens: "180000000",
        description: null,
      },
    ]);
  });

  // A price we cannot read must stay unreadable all the way to the UI, which
  // shows a dash. Substituting anything here is how a stale number gets shipped.
  it("leaves a missing or unusable price null rather than inventing one", () => {
    const [offer] = parseGatewayPlanCatalogue([
      { code: "max", name: "Max", price_usd_monthly: "n/a" },
    ]);
    expect(offer?.priceUsdMonthly).toBeNull();
    expect(offer?.includedTokens).toBeNull();
  });

  it("falls back to the code when the gateway sends no display name", () => {
    expect(parseGatewayPlanCatalogue([{ code: "starter" }])[0]?.name).toBe("starter");
  });

  it("drops rows with no code and collapses anything unrecognisable to an empty list", () => {
    expect(parseGatewayPlanCatalogue([{ name: "Nameless" }, null, "free"])).toEqual([]);
    expect(parseGatewayPlanCatalogue(undefined)).toEqual([]);
    expect(parseGatewayPlanCatalogue({ error: "not found" })).toEqual([]);
  });
});
