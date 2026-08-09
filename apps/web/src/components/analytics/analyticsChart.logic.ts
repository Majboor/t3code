import type { AnalyticsProperty, AnalyticsQueryBucket, AnalyticsStream } from "@t3tools/contracts";

/**
 * Which questions this stream can actually answer. Derived from the
 * declaration rather than offered blindly, because the server checks the same
 * thing and a control that offers an impossible query is a control that only
 * produces errors.
 */
export function answerableQuestions(stream: AnalyticsStream): {
  readonly numeric: ReadonlyArray<AnalyticsProperty>;
  readonly groupable: ReadonlyArray<AnalyticsProperty>;
  readonly aggregates: ReadonlyArray<"count" | "sum" | "avg" | "min" | "max">;
} {
  const numeric = stream.properties.filter((property) => property.type === "number");
  return {
    numeric,
    // Grouping by a float produces a bucket per distinct value, which is a list
    // rather than a chart, so only text and booleans are offered.
    groupable: stream.properties.filter((property) => property.type !== "number"),
    aggregates: numeric.length === 0 ? ["count"] : ["count", "sum", "avg", "min", "max"],
  };
}

/**
 * Bar widths as percentages of the largest bucket. Scaled to the maximum rather
 * than the total: the question is usually which bar is biggest, and shares of a
 * total go misleading the moment a query is filtered by time.
 */
export function toBars(
  buckets: ReadonlyArray<AnalyticsQueryBucket>,
): ReadonlyArray<{ label: string; value: number; events: number; percent: number }> {
  const largest = buckets.reduce((maximum, bucket) => Math.max(maximum, bucket.value), 0);
  return buckets.map((bucket) => ({
    label: bucket.group ?? "everything",
    value: bucket.value,
    events: bucket.events,
    // A zero-valued set would divide by zero; every bar being empty is honest.
    percent: largest === 0 ? 0 : Math.round((bucket.value / largest) * 100),
  }));
}

/** Rounds only for display, so a chart never claims more precision than it has. */
export function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}
