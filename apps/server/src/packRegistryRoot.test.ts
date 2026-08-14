import os from "node:os";

import { describe, expect, it } from "vitest";

import { packRegistryRoot } from "./cli.ts";

const DEFAULT = `${os.homedir()}/.t3code/packs`;

/** Nothing on disk unless a test says so. */
const nothing = () => false;
const only =
  (...paths: ReadonlyArray<string>) =>
  (path: string) =>
    paths.includes(path);

describe("packRegistryRoot", () => {
  it("uses an explicit registry over everything else", () => {
    expect(packRegistryRoot("/explicit", { T3CODE_PACK_REGISTRY: "/env" }, nothing)).toBe(
      "/explicit",
    );
  });

  it("uses the configured registry when there is no explicit one", () => {
    expect(packRegistryRoot(undefined, { T3CODE_PACK_REGISTRY: "/env" }, nothing)).toBe("/env");
  });

  it("falls back to the default home when nothing is configured", () => {
    expect(packRegistryRoot(undefined, {}, nothing)).toBe(DEFAULT);
  });

  it("uses the home's own registry when that home actually has one", () => {
    expect(packRegistryRoot(undefined, { T3CODE_HOME: "/scratch" }, only("/scratch/packs"))).toBe(
      "/scratch/packs",
    );
  });

  it("looks where the packs are when the home has no registry of its own", () => {
    // The case that made an agent report "no pack matches" in a workspace with
    // five: a server run against a scratch home, packs installed under the
    // default one.
    expect(packRegistryRoot(undefined, { T3CODE_HOME: "/scratch" }, only(DEFAULT))).toBe(DEFAULT);
  });

  it("keeps naming the home's registry when neither exists, so the error names the right path", () => {
    expect(packRegistryRoot(undefined, { T3CODE_HOME: "/scratch" }, nothing)).toBe(
      "/scratch/packs",
    );
  });

  it("ignores an empty home rather than reading it as a path", () => {
    expect(packRegistryRoot(undefined, { T3CODE_HOME: "" }, nothing)).toBe(DEFAULT);
  });
});
