import { describe, expect, it } from "vitest";

import { type GatewayPlanOffer } from "../../environments/primary";
import {
  formatPlanPrice,
  formatPlanTokens,
  isGatewayAbsent,
  resolvePlanCatalogue,
} from "./BillingSettings";

const offer = (code: string): GatewayPlanOffer => ({
  code,
  name: code,
  priceUsdMonthly: 0,
  includedTokens: null,
  description: null,
});

describe("formatPlanPrice", () => {
  it("shows a dash when the gateway quoted no price", () => {
    expect(formatPlanPrice(null)).toBe("—");
  });

  it("names zero rather than printing $0", () => {
    expect(formatPlanPrice(0)).toBe("Free");
  });

  it("keeps whole dollars whole and cents exact", () => {
    expect(formatPlanPrice(12)).toBe("$12/mo");
    expect(formatPlanPrice(4.5)).toBe("$4.50/mo");
  });
});

describe("formatPlanTokens", () => {
  it("returns null when there is nothing to say", () => {
    expect(formatPlanTokens(null)).toBeNull();
  });

  it("uses the same shorthand as the API usage page", () => {
    expect(formatPlanTokens("2000000")).toBe("2.0M tokens/mo");
    expect(formatPlanTokens("1000000000")).toBe("1.0B tokens/mo");
  });

  it("passes through anything that is not a number", () => {
    expect(formatPlanTokens("unmetered")).toBe("unmetered");
  });
});

describe("resolvePlanCatalogue", () => {
  const instance = { configured: true, planCatalogue: [offer("from-status")] };

  it("prefers the catalogue that came with usage", () => {
    const usage = { planCatalogue: [offer("from-usage")] } as never;
    expect(resolvePlanCatalogue(usage, instance)[0]?.code).toBe("from-usage");
  });

  it("falls back to the instance catalogue", () => {
    expect(resolvePlanCatalogue(null, instance)[0]?.code).toBe("from-status");
  });

  // An older server sends neither, and the page has to stay drawable.
  it("is empty when neither source said anything", () => {
    expect(resolvePlanCatalogue(null, null)).toEqual([]);
  });
});

describe("isGatewayAbsent", () => {
  it("only reports absence when a server positively said so", () => {
    expect(isGatewayAbsent(null, null)).toBe(false);
    expect(isGatewayAbsent(null, { configured: true, planCatalogue: [] })).toBe(false);
    expect(isGatewayAbsent(null, { configured: false, planCatalogue: [] })).toBe(true);
    expect(isGatewayAbsent({ configured: false } as never, null)).toBe(true);
  });
});
