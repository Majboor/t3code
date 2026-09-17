import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { findPacksDir } from "./PackSource.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "promptbar-packsource-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("findPacksDir", () => {
  it("finds a packs/ directory that actually holds pack content", () => {
    const root = makeTempDir();
    fs.mkdirSync(path.join(root, "packs", "ssh-deploy"), { recursive: true });
    fs.writeFileSync(path.join(root, "packs", "ssh-deploy", "pack.json"), "{}");

    const start = path.join(root, "apps", "server", "src", "promptbar", "Layers");
    fs.mkdirSync(start, { recursive: true });

    expect(findPacksDir(start)).toBe(path.join(root, "packs"));
  });

  it(
    "skips an unrelated packs/ directory that has no pack content, matching the real repo shape " +
      "(apps/server/src/packs is this server's own pack-registry module, not pack data)",
    () => {
      const root = makeTempDir();

      // The decoy: a `packs/` directory closer to `startDir` than the real one,
      // containing only source files - exactly apps/server/src/packs/*.ts.
      const decoy = path.join(root, "apps", "server", "src", "packs");
      fs.mkdirSync(path.join(decoy, "Layers"), { recursive: true });
      fs.writeFileSync(path.join(decoy, "Manifest.ts"), "export {};");

      // The real one, further up, holding actual pack directories.
      fs.mkdirSync(path.join(root, "packs", "ssh-deploy"), { recursive: true });
      fs.writeFileSync(path.join(root, "packs", "ssh-deploy", "pack.json"), "{}");

      const start = path.join(root, "apps", "server", "src", "promptbar", "Layers");
      fs.mkdirSync(start, { recursive: true });

      expect(findPacksDir(start)).toBe(path.join(root, "packs"));
    },
  );

  it("returns null when no packs/ directory with real content exists within maxLevels", () => {
    const root = makeTempDir();
    const start = path.join(root, "a", "b", "c");
    fs.mkdirSync(start, { recursive: true });

    expect(findPacksDir(start)).toBeNull();
  });
});
