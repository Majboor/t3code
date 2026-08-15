import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_USAGE_PANEL_SETTINGS,
  USAGE_PANEL_SETTINGS_STORAGE_KEY,
  UsagePanelSettingsSchema,
} from "./usagePanel.logic";

describe("usage panel settings", () => {
  it("is on until someone switches it off", () => {
    expect(DEFAULT_USAGE_PANEL_SETTINGS.enabled).toBe(true);
  });

  it("keeps a versioned key so a later shape change cannot mis-read this one", () => {
    expect(USAGE_PANEL_SETTINGS_STORAGE_KEY).toBe("t3code:usage-panel:v1");
  });

  it("round-trips through the stored encoding", () => {
    const encoded = Schema.encodeSync(Schema.fromJsonString(UsagePanelSettingsSchema))({
      enabled: false,
    });
    expect(Schema.decodeSync(Schema.fromJsonString(UsagePanelSettingsSchema))(encoded)).toEqual({
      enabled: false,
    });
  });

  it("rejects a stored value of the wrong shape rather than trusting it", () => {
    expect(() =>
      Schema.decodeSync(Schema.fromJsonString(UsagePanelSettingsSchema))('{"enabled":"yes"}'),
    ).toThrow();
  });
});
