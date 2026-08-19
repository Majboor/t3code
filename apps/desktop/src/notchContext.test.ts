import { describe, expect, it } from "vitest";

import {
  areNotchContextsEqual,
  defaultNotchContext,
  NOTCH_CONTEXT_PANELS,
  NOTCH_SLOT_COUNT,
  type NotchContextKind,
  readRouteSegments,
  resolveNotchContext,
  resolveNotchFeed,
} from "./notchContext.ts";

/** The app is served from the local backend in production, Vite in development. */
const PACKAGED = "http://127.0.0.1:3773/";
const DEV = "http://localhost:5173/";

describe("readRouteSegments", () => {
  it("has no route to read before one exists", () => {
    expect(readRouteSegments(null)).toBeNull();
    expect(readRouteSegments("")).toBeNull();
    expect(readRouteSegments("about:blank")).toBeNull();
  });

  it("reads the route out of the fragment, where hash history keeps it", () => {
    expect(readRouteSegments(`${PACKAGED}#/infra/proj_1`)).toEqual(["infra", "proj_1"]);
    expect(readRouteSegments(`${DEV}#/analytics/proj_1`)).toEqual(["analytics", "proj_1"]);
  });

  it("ignores the router's own search string", () => {
    expect(readRouteSegments(`${PACKAGED}#/infra/proj_1?tab=runs`)).toEqual(["infra", "proj_1"]);
  });

  it("treats the root route as a route, not as an absent one", () => {
    expect(readRouteSegments(`${PACKAGED}#/`)).toEqual([]);
  });

  it("decodes an escaped segment", () => {
    expect(readRouteSegments(`${PACKAGED}#/infra/proj%2F1`)).toEqual(["infra", "proj/1"]);
  });

  it("keeps a malformed escape rather than failing the whole read", () => {
    expect(readRouteSegments(`${PACKAGED}#/infra/%E0%A4%A`)).toEqual(["infra", "%E0%A4%A"]);
  });
});

describe("resolveNotchContext", () => {
  it("falls back to the account-wide panel when there is no window", () => {
    expect(resolveNotchContext(null)).toEqual(defaultNotchContext);
  });

  it("reads the deployment page as one project's deployments", () => {
    expect(resolveNotchContext(`${PACKAGED}#/infra/proj_1`)).toEqual({
      kind: "deployment",
      projectId: "proj_1",
      thread: null,
    });
  });

  it("reads the analytics page as one project's streams", () => {
    expect(resolveNotchContext(`${PACKAGED}#/analytics/proj_1`)).toEqual({
      kind: "analytics",
      projectId: "proj_1",
      thread: null,
    });
  });

  it("tells a started thread from a draft", () => {
    expect(resolveNotchContext(`${PACKAGED}#/env_1/thread_1`)).toMatchObject({
      kind: "prompting",
      thread: "started",
    });
    expect(resolveNotchContext(`${PACKAGED}#/draft/draft_1`)).toMatchObject({
      kind: "prompting",
      thread: "draft",
    });
  });

  /*
   * The whole reason `STATIC_FIRST_SEGMENTS` exists: `/settings/general` and
   * `/$environmentId/$threadId` are both two segments, and only the list of
   * static branches separates them.
   */
  it.each([
    "/",
    "/pair",
    "/invite",
    "/settings",
    "/settings/general",
    "/settings/account",
    "/settings/organization",
    "/settings/connections",
    "/settings/archived",
    "/pack/pack_1",
    "/project/env_1/proj_1",
  ])("leaves %s on the panel it already had", (route) => {
    expect(resolveNotchContext(`${PACKAGED}#${route}`)).toEqual(defaultNotchContext);
  });

  it("never invents a project for an id-less project route", () => {
    expect(resolveNotchContext(`${PACKAGED}#/infra`)).toEqual(defaultNotchContext);
    expect(resolveNotchContext(`${PACKAGED}#/analytics/`)).toEqual(defaultNotchContext);
    expect(resolveNotchContext(`${PACKAGED}#/draft`)).toEqual(defaultNotchContext);
  });

  it("degrades an unmapped route to the default panel rather than an empty one", () => {
    expect(resolveNotchContext(`${PACKAGED}#/something/we/have/not/seen`)).toEqual(
      defaultNotchContext,
    );
  });
});

describe("NOTCH_CONTEXT_PANELS", () => {
  const kinds = Object.keys(NOTCH_CONTEXT_PANELS) as NotchContextKind[];

  /*
   * The window is sized once, for the expanded panel, and never resized. A
   * context that drew a fourth row would overflow it and one that drew two
   * would leave a hole, so the count is the contract.
   */
  it("gives every context exactly as many rows as the panel has room for", () => {
    for (const kind of kinds) {
      expect(NOTCH_CONTEXT_PANELS[kind].slots).toHaveLength(NOTCH_SLOT_COUNT);
    }
  });

  it("names every row and every panel", () => {
    for (const kind of kinds) {
      expect(NOTCH_CONTEXT_PANELS[kind].title.length).toBeGreaterThan(0);
      for (const slot of NOTCH_CONTEXT_PANELS[kind].slots) {
        expect(slot.label.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not draw the same figure twice in one panel", () => {
    for (const kind of kinds) {
      const figures = NOTCH_CONTEXT_PANELS[kind].slots.map((slot) => slot.figure);
      expect(new Set(figures).size).toBe(figures.length);
    }
  });
});

describe("resolveNotchFeed", () => {
  it("asks about one project only where the route named one", () => {
    expect(resolveNotchFeed(resolveNotchContext(`${PACKAGED}#/infra/proj_1`))).toEqual({
      kind: "project",
      projectId: "proj_1",
    });
    expect(resolveNotchFeed(resolveNotchContext(`${PACKAGED}#/analytics/proj_1`))).toEqual({
      kind: "project",
      projectId: "proj_1",
    });
  });

  it("rides on the account read everywhere else, so one context is one request", () => {
    for (const route of ["/", "/env_1/thread_1", "/draft/draft_1", "/project/env_1/proj_1"]) {
      expect(resolveNotchFeed(resolveNotchContext(`${PACKAGED}#${route}`))).toEqual({
        kind: "account",
      });
    }
  });
});

describe("areNotchContextsEqual", () => {
  it("separates two projects on the same page", () => {
    expect(
      areNotchContextsEqual(
        resolveNotchContext(`${PACKAGED}#/infra/proj_1`),
        resolveNotchContext(`${PACKAGED}#/infra/proj_2`),
      ),
    ).toBe(false);
  });

  it("separates two pages about the same project", () => {
    expect(
      areNotchContextsEqual(
        resolveNotchContext(`${PACKAGED}#/infra/proj_1`),
        resolveNotchContext(`${PACKAGED}#/analytics/proj_1`),
      ),
    ).toBe(false);
  });

  it("holds still across a route that resolves the same way", () => {
    expect(
      areNotchContextsEqual(
        resolveNotchContext(`${PACKAGED}#/settings/general`),
        resolveNotchContext(`${PACKAGED}#/pack/pack_1`),
      ),
    ).toBe(true);
  });
});
