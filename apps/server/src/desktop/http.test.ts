import { describe, expect, it } from "vitest";

import { DESKTOP_ACTIVITY_PATH, extendWindow, sumBucketEvents } from "./http.ts";

describe("extendWindow", () => {
  const earlier = "2026-07-17T00:00:00.000Z";
  const later = "2026-08-16T00:00:00.000Z";

  it("takes whichever side exists when only one workspace reported", () => {
    expect(extendWindow(null, later, "latest")).toBe(later);
    expect(extendWindow(earlier, null, "earliest")).toBe(earlier);
    expect(extendWindow(null, null, "latest")).toBeNull();
  });

  it("widens rather than replaces, in both directions", () => {
    expect(extendWindow(later, earlier, "earliest")).toBe(earlier);
    expect(extendWindow(earlier, later, "earliest")).toBe(earlier);
    expect(extendWindow(earlier, later, "latest")).toBe(later);
    expect(extendWindow(later, earlier, "latest")).toBe(later);
  });

  it("is stable when the two agree", () => {
    expect(extendWindow(later, later, "latest")).toBe(later);
    expect(extendWindow(later, later, "earliest")).toBe(later);
  });
});

describe("sumBucketEvents", () => {
  it("adds every group up, because a grouped query answers with one row each", () => {
    expect(sumBucketEvents([{ events: 3 }, { events: 4 }, { events: 5 }])).toBe(12);
  });

  it("is zero for a stream that answered with nothing", () => {
    expect(sumBucketEvents([])).toBe(0);
  });
});

describe("DESKTOP_ACTIVITY_PATH", () => {
  it("sits under the authenticated api prefix, not beside the public share routes", () => {
    expect(DESKTOP_ACTIVITY_PATH.startsWith("/api/")).toBe(true);
  });
});
