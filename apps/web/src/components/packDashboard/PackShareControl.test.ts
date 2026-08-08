import { describe, expect, it } from "vitest";

import { buildPackShareUrl } from "./PackShareControl";

describe("buildPackShareUrl", () => {
  it("points at the pack route on the origin the sharer is using", () => {
    expect(buildPackShareUrl("https://t3.example.com", "pack_abc" as never)).toBe(
      "https://t3.example.com/pack/pack_abc",
    );
  });

  it("does not double the separator when the origin ends in a slash", () => {
    // window.location.origin never has one, but a configured base URL can.
    expect(buildPackShareUrl("http://localhost:5733/", "pack_abc" as never)).toBe(
      "http://localhost:5733/pack/pack_abc",
    );
  });
});
