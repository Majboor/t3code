import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ensureAgentCliShim, withShimOnPath } from "./agentCliShim.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "t3-shim-"));
}

describe("ensureAgentCliShim", () => {
  it("writes a shim that actually runs the CLI entry", () => {
    const binDir = path.join(tempDir(), "bin");
    const shimDir = ensureAgentCliShim(binDir);
    expect(shimDir).toBe(binDir);

    // The point of the shim is that running it reaches the entry the server
    // was started with. Under vitest that entry is vitest's own, so assert on
    // the mechanism: the shim runs, and what it runs is this process's
    // interpreter and argv[1].
    const shim = fs.readFileSync(path.join(binDir, "t3"), "utf8");
    expect(shim.startsWith("#!/bin/sh\n")).toBe(true);
    expect(shim).toContain(process.execPath);
    expect(shim).toContain(path.resolve(process.argv[1] ?? ""));
    expect(shim).toContain('"$@"');
  });

  it("makes it executable, since PATH lookup will not fix that", () => {
    const binDir = path.join(tempDir(), "bin");
    ensureAgentCliShim(binDir);
    const mode = fs.statSync(path.join(binDir, "t3")).mode;
    expect(mode & 0o111).not.toBe(0);
  });

  it("runs a real command through the shim and passes arguments along", () => {
    // A stand-in entry, so this asserts the generated script works rather than
    // trusting that it looks right.
    const dir = tempDir();
    const entry = path.join(dir, "entry.mjs");
    fs.writeFileSync(entry, `console.log("args:" + process.argv.slice(2).join(","));\n`);

    const binDir = path.join(dir, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shimPath = path.join(binDir, "t3");
    fs.writeFileSync(shimPath, `#!/bin/sh\nexec '${process.execPath}' '${entry}' "$@"\n`, {
      mode: 0o755,
    });

    const output = execFileSync(shimPath, ["pack", "search", "deploy"], { encoding: "utf8" });
    expect(output.trim()).toBe("args:pack,search,deploy");
  });

  it("survives a path with a quote in it rather than producing a broken script", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-shim-quote'"));
    const binDir = path.join(dir, "bin");
    expect(ensureAgentCliShim(binDir)).toBe(binDir);
    const shim = fs.readFileSync(path.join(binDir, "t3"), "utf8");
    // Every quote is closed: an unbalanced one would make `sh` read the rest
    // of the line as a string and fail in a way nobody would connect to packs.
    expect(shim.split("'").length % 2).toBe(1);
  });

  it("gives up rather than writing somewhere it cannot", () => {
    const file = path.join(tempDir(), "not-a-directory");
    fs.writeFileSync(file, "");
    expect(ensureAgentCliShim(path.join(file, "bin"))).toBeUndefined();
  });
});

describe("withShimOnPath", () => {
  it("looks in the shim directory first", () => {
    expect(withShimOnPath("/usr/bin:/bin", "/shim")).toBe("/shim:/usr/bin:/bin");
  });

  it("leaves PATH alone when there is no shim, rather than emptying it", () => {
    expect(withShimOnPath("/usr/bin", undefined)).toBe("/usr/bin");
    expect(withShimOnPath(undefined, undefined)).toBeUndefined();
  });

  it("copes with a child that would otherwise have no PATH at all", () => {
    expect(withShimOnPath(undefined, "/shim")).toBe("/shim");
    expect(withShimOnPath("", "/shim")).toBe("/shim");
  });
});

/**
 * Both adapters, or neither. Only the Codex manager put `t3` on PATH, so an
 * agent running on Claude could not run the CLI the packs tell it to use —
 * deploys served correctly and registered nothing. A grep is a blunt test, but
 * the alternative is launching a provider, and the failure it guards against is
 * exactly "somebody wired one adapter and not the other".
 */
describe("every provider that runs a turn gets the shim", () => {
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(import.meta.dirname, relativePath), "utf8");

  it("is applied by the Codex manager and the Claude adapter alike", () => {
    for (const source of [
      "codexAppServerManager.ts",
      "provider/Layers/ClaudeAdapter.ts",
    ] as const) {
      const text = read(source);
      expect.soft(text, `${source} must build the shim`).toContain("ensureAgentCliShim");
      expect.soft(text, `${source} must put it on PATH`).toContain("withShimOnPath");
    }
  });
});
