import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/bin.ts"],
  format: ["esm", "cjs"],
  checks: {
    legacyCjs: false,
  },
  outDir: "dist",
  sourcemap: true,
  clean: true,
  noExternal: (id) => id.startsWith("@t3tools/"),
  inlineOnly: false,
  banner: {
    js: "#!/usr/bin/env node\n",
  },
  /**
   * The environment installer, carried into the bundle.
   *
   * `GET /install.sh` serves `infra/install/t3-environment.sh` off disk, and a
   * bundler that only follows `import` graphs never sees it: nothing in the
   * server's TypeScript references the file, because the route reads it as
   * bytes rather than importing it. From a source checkout the route walks up
   * to the repository root and finds it anyway; from an installed tarball there
   * is no repository above `dist`, so the route answered 503 and the one-liner
   * it exists to publish did not work on precisely the machines it is for.
   *
   * `dist/install/` is the first place `resolveInstallScriptPath` looks, and
   * `package.json` already ships all of `dist`, so this one line is the whole
   * of what the tarball was missing. It is a copy rather than an import so the
   * bytes served are the bytes the shell tests ran against — no transform, no
   * bundler between the tested file and the file people pipe into `sh`.
   */
  copy: [{ from: "../../infra/install/t3-environment.sh", to: "dist/install" }],
});
