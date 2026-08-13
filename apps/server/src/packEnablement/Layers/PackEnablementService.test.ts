import { assert, describe, it } from "@effect/vitest";

import { settingsFor } from "./PackEnablementService.ts";

const manifest = (environment: ReadonlyArray<Record<string, unknown>>) =>
  ({ requirements: { environment } }) as never;

describe("settingsFor", () => {
  it("lists what the pack said it must have, and nothing it merely likes", () => {
    const settings = settingsFor(
      manifest([
        { name: "HOST", purpose: "where", secret: false, required: true },
        { name: "TOKEN", purpose: "auth", secret: true, required: true },
        { name: "DEBUG", purpose: "noise", secret: false, required: false },
      ]),
    );
    assert.deepStrictEqual(
      settings.map((setting) => setting.name),
      ["HOST", "TOKEN"],
    );
  });

  it("starts everything unprovided, because enabling supplies nothing", () => {
    // The whole point: turning a pack on is a record of intent. A setting that
    // claimed to be provided would describe a project as ready and be wrong.
    const settings = settingsFor(
      manifest([{ name: "HOST", purpose: "where", secret: false, required: true }]),
    );
    assert.strictEqual(settings[0]?.provided, false);
  });

  it("names where a secret will live, and never carries one", () => {
    const settings = settingsFor(
      manifest([{ name: "TOKEN", purpose: "auth", secret: true, required: true }]),
    );
    assert.strictEqual(settings[0]?.secretName, "TOKEN");
    assert.notProperty(settings[0], "value");
  });

  it("leaves a non-secret without a secret name to look up", () => {
    const settings = settingsFor(
      manifest([{ name: "HOST", purpose: "where", secret: false, required: true }]),
    );
    assert.strictEqual(settings[0]?.secretName, undefined);
  });

  it("copes with a pack that asks for nothing", () => {
    assert.deepStrictEqual(settingsFor({ requirements: {} } as never), []);
  });
});
