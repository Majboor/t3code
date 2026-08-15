import { describe, expect, it } from "vitest";

import {
  buildDayTrendView,
  buildHourOfDayView,
  buildLeaderboardRows,
  buildProviderSplit,
  describeHiddenMembers,
  describeUnpricedTokens,
  describeUsageError,
  formatEstimatedCost,
  formatTokenCount,
  formatUtcDayLabel,
  formatUtcOffset,
  formatWeekChange,
  formatWindowLabel,
  providerLabel,
  usageAvatarInitials,
  usageAvatarMember,
} from "./usageMetrics.logic";

const totals = (totalTokens: number) =>
  ({
    inputTokens: totalTokens,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens,
  }) as never;

const cost = (estimatedTotalCost: number, unpricedTokens = 0, unpricedModels: string[] = []) =>
  ({
    currency: "USD",
    estimatedInputCost: estimatedTotalCost,
    estimatedOutputCost: 0,
    estimatedTotalCost,
    unpricedTokens,
    unpricedModels,
  }) as never;

const hourBucket = (hour: number, tokens: number) => ({ hour, totals: totals(tokens) }) as never;

const dayBucket = (day: string, tokens: number, dayCost = 0) =>
  ({ day, totals: totals(tokens), estimatedCost: cost(dayCost) }) as never;

const providerRow = (provider: string | null, tokens: number, rowCost = 0) =>
  ({ provider, totals: totals(tokens), estimatedCost: cost(rowCost) }) as never;

const leaderboardEntry = (userId: string, displayName: string, tokens: number, isViewer = false) =>
  ({
    userId,
    displayName,
    totals: totals(tokens),
    estimatedCost: cost(0),
    isViewer,
  }) as never;

describe("formatTokenCount", () => {
  it("keeps every digit below ten thousand, where the difference is the point", () => {
    expect(formatTokenCount(842)).toBe("842");
    expect(formatTokenCount(1284)).toBe("1,284");
  });

  it("compacts larger counts", () => {
    expect(formatTokenCount(12_900)).toBe("12.9K");
    expect(formatTokenCount(4_200_000)).toBe("4.2M");
    expect(formatTokenCount(2_000_000_000)).toBe("2B");
  });

  it("drops a trailing zero rather than showing 12.0K", () => {
    expect(formatTokenCount(12_000)).toBe("12K");
  });
});

describe("formatEstimatedCost", () => {
  it("never rounds a real charge down to nothing", () => {
    // "$0.00" and "too small to show" are different claims about the money.
    expect(formatEstimatedCost(0.004)).toBe("<$0.01");
    expect(formatEstimatedCost(0)).toBe("$0.00");
  });

  it("shows cents", () => {
    expect(formatEstimatedCost(12.3)).toBe("$12.30");
    expect(formatEstimatedCost(1234.5)).toBe("$1,234.50");
  });
});

describe("describeUnpricedTokens", () => {
  it("says nothing when the whole window was priced", () => {
    expect(describeUnpricedTokens(cost(4, 0, []))).toBeNull();
  });

  it("names the models the estimate had to leave out", () => {
    const note = describeUnpricedTokens(cost(4, 12_000, ["mystery-1", "mystery-2"]));
    expect(note?.tokens).toBe(12_000);
    expect(note?.summary).toContain("12K tokens");
    expect(note?.summary).toContain("mystery-1, mystery-2");
    expect(note?.summary).toContain("not in this estimate");
  });

  it("caps the named models so the note stays readable", () => {
    const note = describeUnpricedTokens(cost(0, 5, ["a", "b", "c", "d", "e"]));
    expect(note?.summary).toContain("a, b, c and 2 more");
  });
});

describe("buildHourOfDayView", () => {
  it("shifts UTC hours into a whole-hour local zone", () => {
    const view = buildHourOfDayView([hourBucket(23, 500), hourBucket(0, 10)], 120);

    // 23:00 UTC is 01:00 at UTC+2.
    expect(view.zone).toBe("local");
    expect(view.zoneLabel).toBe("UTC+2");
    expect(view.buckets[1]?.tokens).toBe(500);
    expect(view.buckets[1]?.utcHour).toBe(23);
    expect(view.peakIndex).toBe(1);
  });

  it("stays in UTC for a half-hour zone rather than smear a bucket across two hours", () => {
    const view = buildHourOfDayView([hourBucket(9, 300)], 330);

    expect(view.zone).toBe("utc");
    expect(view.zoneLabel).toBe("UTC");
    expect(view.buckets[9]?.tokens).toBe(300);
  });

  it("always produces 24 slots so the shape does not move with the data", () => {
    expect(buildHourOfDayView([], 0).buckets).toHaveLength(24);
  });

  it("reports no peak when nothing was recorded", () => {
    const view = buildHourOfDayView([], 0);
    expect(view.peakIndex).toBeNull();
    expect(view.peakShare).toBe(0);
  });

  it("reports the peak hour's share of the window", () => {
    const view = buildHourOfDayView([hourBucket(3, 75), hourBucket(4, 25)], 0);
    expect(view.peakShare).toBeCloseTo(0.75);
  });
});

describe("formatUtcOffset", () => {
  it("signs the offset the way people expect", () => {
    expect(formatUtcOffset(0)).toBe("UTC");
    expect(formatUtcOffset(-480)).toBe("UTC−8");
    expect(formatUtcOffset(330)).toBe("UTC+5:30");
  });
});

describe("buildDayTrendView", () => {
  it("labels a UTC day without sliding it into local time", () => {
    // A local-time label would re-date every bucket by the viewer's offset.
    expect(formatUtcDayLabel("2026-08-15", "en-US")).toBe("Aug 15");
  });

  it("compares the last seven days against the seven before", () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      dayBucket(`2026-08-${String(index + 1).padStart(2, "0")}`, index < 7 ? 100 : 150),
    );
    const view = buildDayTrendView(days, "en-US");

    expect(view.previousWeekTokens).toBe(700);
    expect(view.thisWeekTokens).toBe(1050);
    expect(view.weekChange).toBeCloseTo(0.5);
    expect(formatWeekChange(view.weekChange)).toBe("+50% vs the week before");
  });

  it("refuses a ratio against a week that recorded nothing", () => {
    const days = Array.from({ length: 14 }, (_, index) =>
      dayBucket(`2026-08-${String(index + 1).padStart(2, "0")}`, index < 7 ? 0 : 150),
    );
    const view = buildDayTrendView(days, "en-US");

    expect(view.weekChange).toBeNull();
    expect(formatWeekChange(view.weekChange)).toBeNull();
  });

  it("finds the peak day to direct-label", () => {
    const view = buildDayTrendView(
      [dayBucket("2026-08-01", 10), dayBucket("2026-08-02", 90), dayBucket("2026-08-03", 20)],
      "en-US",
    );
    expect(view.maxTokens).toBe(90);
    expect(view.peakIndex).toBe(1);
  });

  it("has no peak on an empty window", () => {
    expect(buildDayTrendView([dayBucket("2026-08-01", 0)], "en-US").peakIndex).toBeNull();
  });
});

describe("buildProviderSplit", () => {
  it("labels the wire values for humans", () => {
    expect(providerLabel("codex")).toBe("Codex");
    expect(providerLabel("claudeAgent")).toBe("Claude");
    expect(providerLabel(null)).toBe("Not recorded");
  });

  it("keeps the unattributed bucket instead of dropping it", () => {
    const split = buildProviderSplit([
      providerRow(null, 900),
      providerRow("codex", 100),
      providerRow("claudeAgent", 0),
    ]);

    expect(split.totalTokens).toBe(1000);
    // Recorded runtimes come first; the residue sits last however large it is.
    expect(split.slices.map((slice) => slice.key)).toEqual(["codex", "unrecorded"]);
    expect(split.unrecordedShare).toBeCloseTo(0.9);
  });

  it("orders recorded runtimes by size", () => {
    const split = buildProviderSplit([providerRow("codex", 10), providerRow("claudeAgent", 40)]);
    expect(split.slices.map((slice) => slice.key)).toEqual(["claudeAgent", "codex"]);
  });
});

describe("buildLeaderboardRows", () => {
  it("scales every bar against the heaviest user", () => {
    const rows = buildLeaderboardRows([
      leaderboardEntry("u1", "Ada Lovelace", 1000, true),
      leaderboardEntry("u2", "Grace Hopper", 250),
    ]);

    expect(rows[0]?.share).toBe(1);
    expect(rows[1]?.share).toBeCloseTo(0.25);
    expect(rows[0]?.isViewer).toBe(true);
  });

  it("survives a window where nobody spent anything", () => {
    const rows = buildLeaderboardRows([leaderboardEntry("u1", "Ada Lovelace", 0)]);
    expect(rows[0]?.share).toBe(0);
  });
});

describe("usageAvatarMember", () => {
  it("derives the same initials the server would", () => {
    expect(usageAvatarInitials("Ada Lovelace")).toBe("AL");
    expect(usageAvatarInitials("ada")).toBe("AD");
    expect(usageAvatarInitials(" ")).toBe("U");
  });

  it("gives one person the same colour every time", () => {
    const first = usageAvatarMember({
      userId: "u1",
      displayName: "Ada Lovelace",
    });
    const second = usageAvatarMember({
      userId: "u1",
      displayName: "Ada Lovelace",
    });
    expect(first.color).toBe(second.color);
    expect(first.color).not.toBe("");
  });
});

describe("describeHiddenMembers", () => {
  it("says nothing when everyone is counted", () => {
    expect(describeHiddenMembers(0)).toBeNull();
  });

  it("reports hidden members as a consent choice, not missing data", () => {
    expect(describeHiddenMembers(1)).toContain("1 member keeps their usage private");
    expect(describeHiddenMembers(3)).toContain("3 members keep their usage private");
  });
});

describe("formatWindowLabel", () => {
  it("names the window in whole days and closes on the last visible day", () => {
    // `until` is exclusive, so Aug 16 as a bound means Aug 15 is the last day.
    expect(formatWindowLabel("2026-07-17T00:00:00Z", "2026-08-16T00:00:00Z", "en-US")).toBe(
      "30 days · Jul 17 – Aug 15 UTC",
    );
  });

  it("falls back rather than print an invalid date", () => {
    expect(formatWindowLabel("nonsense", "2026-08-16T00:00:00Z", "en-US")).toBe("Selected window");
  });
});

describe("describeUsageError", () => {
  it("says nothing when there is no error", () => {
    expect(describeUsageError(null)).toBeNull();
  });

  it("translates the permission refusal into what it actually means", () => {
    const described = describeUsageError(
      new Error("Forbidden: authenticated session does not have workspace.view."),
    );
    expect(described?.summary).toBe("This project belongs to a workspace you are not a member of.");
    expect(described?.detail).toContain("per workspace");
  });

  it("passes any other failure through unchanged", () => {
    const described = describeUsageError(new Error("Network request failed"));
    expect(described).toEqual({ summary: "Network request failed", detail: null });
  });
});
