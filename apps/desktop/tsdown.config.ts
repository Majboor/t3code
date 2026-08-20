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
  // Same reasoning as the notch's preload, and one more: this one loads in a
  // window shown before the person has an account. Sharing a chunk with the app
  // window's bridge would put settings, secrets and the environment registry
  // behind a pre-auth surface.
  {
    ...shared,
    entry: ["src/deviceEnrollmentPreload.ts"],
  },
]);
