import { describe, expect, it } from "vitest";

import {
  asExternalHttpUrl,
  decodeCollectedEnrollment,
  decodeCreatedEnrollment,
  decodeEnrollmentSnapshot,
} from "./types.ts";

describe("decodeCreatedEnrollment", () => {
  it("reads the response the create route promises", () => {
    expect(
      decodeCreatedEnrollment({
        code: "ABC123xyz",
        expiresAtMs: 1_700_000_600_000,
        approveUrl: "https://app.logicpacks.io/devices/ABC123xyz",
      }),
    ).toEqual({
      code: "ABC123xyz",
      expiresAtMs: 1_700_000_600_000,
      approveUrl: "https://app.logicpacks.io/devices/ABC123xyz",
    });
  });

  it("accepts a deadline encoded as a string, as a cautious JSON encoder might send it", () => {
    expect(
      decodeCreatedEnrollment({
        code: "ABC123xyz",
        expiresAtMs: "1700000600000",
        approveUrl: "https://app.logicpacks.io/x",
      })?.expiresAtMs,
    ).toBe(1_700_000_600_000);
  });

  /*
   * A deadline that is not a finite number compares false against a clock in
   * both directions, which would make an enrollment that can neither expire nor
   * be used — a spinner with no ending.
   */
  it.each([
    ["a missing code", { expiresAtMs: 1, approveUrl: "https://app.logicpacks.io/x" }],
    ["an empty code", { code: "  ", expiresAtMs: 1, approveUrl: "https://app.logicpacks.io/x" }],
    ["no deadline", { code: "ABC123xyz", approveUrl: "https://app.logicpacks.io/x" }],
    [
      "an unusable deadline",
      { code: "ABC123xyz", expiresAtMs: "soon", approveUrl: "https://app.logicpacks.io/x" },
    ],
    ["no approval url", { code: "ABC123xyz", expiresAtMs: 1 }],
    ["null", null],
    ["an array", []],
    ["a string", "created"],
  ])("returns null for %s", (_label, input) => {
    expect(decodeCreatedEnrollment(input)).toBeNull();
  });

  it("tolerates fields it does not know about, so the server can grow without this", () => {
    expect(
      decodeCreatedEnrollment({
        code: "ABC123xyz",
        expiresAtMs: 1,
        approveUrl: "https://app.logicpacks.io/x",
        somethingNew: true,
      }),
    ).not.toBeNull();
  });
});

describe("asExternalHttpUrl", () => {
  /*
   * This string is handed to `shell.openExternal`, which passes anything it is
   * given to the operating system. A wrong or hostile response must not become
   * an arbitrary local launch.
   */
  it.each([
    ["a file url", "file:///etc/passwd"],
    ["another app's scheme", "logicpacks://enroll?code=x"],
    ["a javascript url", "javascript:alert(1)"],
    ["nonsense", "not a url"],
    ["an empty string", ""],
  ])("refuses %s", (_label, input) => {
    expect(asExternalHttpUrl(input)).toBeNull();
  });

  it("accepts the two schemes a browser can actually be sent to", () => {
    expect(asExternalHttpUrl("https://app.logicpacks.io/x")).toBe("https://app.logicpacks.io/x");
    expect(asExternalHttpUrl("http://127.0.0.1:3000/x")).toBe("http://127.0.0.1:3000/x");
  });
});

describe("decodeEnrollmentSnapshot", () => {
  it("reads every status the server can report", () => {
    for (const status of ["pending", "approved", "collected", "denied", "expired"] as const) {
      expect(decodeEnrollmentSnapshot({ status })?.status).toBe(status);
    }
  });

  it("keeps the descriptive fields, and accepts their absence", () => {
    expect(
      decodeEnrollmentSnapshot({
        status: "pending",
        deviceLabel: "Waleeds-MacBook",
        devicePlatform: "macos",
        requestedIp: "203.0.113.4",
        expiresAtMs: 1_700_000_600_000,
      }),
    ).toEqual({
      status: "pending",
      deviceLabel: "Waleeds-MacBook",
      devicePlatform: "macos",
      requestedIp: "203.0.113.4",
      expiresAtMs: 1_700_000_600_000,
    });

    expect(decodeEnrollmentSnapshot({ status: "pending" })).toEqual({
      status: "pending",
      deviceLabel: null,
      devicePlatform: null,
      requestedIp: null,
      expiresAtMs: null,
    });
  });

  it("returns null for a status it does not recognise rather than guessing", () => {
    expect(decodeEnrollmentSnapshot({ status: "revoked" })).toBeNull();
    expect(decodeEnrollmentSnapshot({})).toBeNull();
    expect(decodeEnrollmentSnapshot(null)).toBeNull();
  });
});

describe("decodeCollectedEnrollment", () => {
  it("reads the field name the rest of this codebase uses for a bearer session", () => {
    expect(decodeCollectedEnrollment({ sessionToken: "secret-token" })?.sessionToken).toBe(
      "secret-token",
    );
  });

  /*
   * Written against a route that did not exist yet. Accepting the obvious
   * synonyms removes a "connected successfully, stored nothing" bug that would
   * only appear as a mysteriously signed-out app on the next launch.
   */
  it.each(["credential", "bearerToken", "token"])("accepts %s as the credential", (field) => {
    expect(decodeCollectedEnrollment({ [field]: "secret-token" })?.sessionToken).toBe(
      "secret-token",
    );
  });

  it("prefers sessionToken when a response carries more than one name", () => {
    expect(
      decodeCollectedEnrollment({ sessionToken: "correct", token: "wrong" })?.sessionToken,
    ).toBe("correct");
  });

  /*
   * A success with no credential has not connected anything, however
   * encouraging the status code was.
   */
  it.each([
    ["an empty credential", { sessionToken: "   " }],
    ["no credential at all", { environmentId: "env-1" }],
    ["null", null],
    ["a string", "secret-token"],
  ])("returns null for %s", (_label, input) => {
    expect(decodeCollectedEnrollment(input)).toBeNull();
  });

  it("carries the account details when the server names them", () => {
    expect(
      decodeCollectedEnrollment({
        sessionToken: "secret-token",
        environmentId: "env-1",
        label: "Atlas",
        httpBaseUrl: "https://app.logicpacks.io",
        wsBaseUrl: "wss://app.logicpacks.io",
      }),
    ).toEqual({
      sessionToken: "secret-token",
      environmentId: "env-1",
      label: "Atlas",
      httpBaseUrl: "https://app.logicpacks.io/",
      wsBaseUrl: "wss://app.logicpacks.io",
    });
  });

  it("drops a base url that is not somewhere a browser could be sent", () => {
    expect(
      decodeCollectedEnrollment({ sessionToken: "secret-token", httpBaseUrl: "file:///tmp" })
        ?.httpBaseUrl,
    ).toBeNull();
  });
});
