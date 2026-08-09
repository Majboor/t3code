import { describe, expect, it } from "vitest";

import { answerableQuestions, formatValue, toBars } from "./analyticsChart.logic";

const stream = (properties: ReadonlyArray<{ name: string; type: string }>) =>
  ({
    properties: properties.map((property) => ({ ...property, purpose: "x", required: false })),
  }) as never;

describe("answerableQuestions", () => {
  it("offers only count when the stream declared nothing numeric", () => {
    const questions = answerableQuestions(stream([{ name: "path", type: "string" }]));
    expect(questions.aggregates).toEqual(["count"]);
    expect(questions.numeric).toEqual([]);
  });

  it("offers the numeric aggregates once there is something to add up", () => {
    const questions = answerableQuestions(
      stream([
        { name: "path", type: "string" },
        { name: "seconds", type: "number" },
      ]),
    );
    expect(questions.aggregates).toContain("sum");
    expect(questions.numeric.map((property) => property.name)).toEqual(["seconds"]);
  });

  it("does not offer to group by a number", () => {
    // One bucket per distinct float is a list, not a chart.
    const questions = answerableQuestions(
      stream([
        { name: "seconds", type: "number" },
        { name: "device", type: "string" },
        { name: "returning", type: "boolean" },
      ]),
    );
    expect(questions.groupable.map((property) => property.name)).toEqual(["device", "returning"]);
  });
});

describe("toBars", () => {
  it("scales to the largest bucket, so the biggest bar is full width", () => {
    const bars = toBars([
      { group: "/a", value: 30, events: 2 },
      { group: "/b", value: 15, events: 1 },
    ]);
    expect(bars[0]?.percent).toBe(100);
    expect(bars[1]?.percent).toBe(50);
  });

  it("names the ungrouped bucket rather than showing a blank label", () => {
    expect(toBars([{ group: null, value: 3, events: 3 }])[0]?.label).toBe("everything");
  });

  it("draws nothing rather than dividing by zero when every bucket is empty", () => {
    const bars = toBars([
      { group: "/a", value: 0, events: 0 },
      { group: "/b", value: 0, events: 0 },
    ]);
    expect(bars.every((bar) => bar.percent === 0)).toBe(true);
  });

  it("has no bars for no data", () => {
    expect(toBars([])).toEqual([]);
  });
});

describe("formatValue", () => {
  it("leaves whole numbers alone", () => {
    expect(formatValue(65)).toBe("65");
  });

  it("does not claim more precision than two places", () => {
    expect(formatValue(15.666666)).toBe("15.67");
  });
});
