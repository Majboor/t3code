import { defineConfig, mergeConfig } from "vitest/config";

import baseConfig from "../../vitest.config.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // The server suite exercises sqlite, git, temp worktrees, and orchestration
      // runtimes heavily. Running files in parallel introduces load-sensitive flakes.
      fileParallelism: false,
      // The server merges the machine's installed packs into search results,
      // which is right in a product and wrong in a test: an isolation test
      // would otherwise pass or fail depending on what the developer happens
      // to have installed. Covered on purpose by verifiedPacks.test.ts.
      env: { T3CODE_VERIFIED_PACKS: "none" },
      // Server integration tests exercise sqlite, git, and orchestration together.
      // Under package-wide parallel runs they regularly exceed the default 15s budget.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  }),
);
