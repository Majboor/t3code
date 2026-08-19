import { defineConfig } from "tsdown";

const shared = {
  format: "cjs" as const,
  outDir: "dist-electron",
  sourcemap: true,
  outExtensions: () => ({ js: ".cjs" }),
};

export default defineConfig([
  {
    ...shared,
    entry: ["src/main.ts"],
    clean: true,
    noExternal: (id) => id.startsWith("@t3tools/"),
  },
  {
    ...shared,
    entry: ["src/preload.ts"],
  },
  // The notch panel's preload is its own bundle rather than a second entry
  // beside `preload.ts`, so the two cannot end up sharing a chunk: an overlay
  // that needs one channel must not ship the app window's whole bridge.
  {
    ...shared,
    entry: ["src/notchPreload.ts"],
  },
]);
