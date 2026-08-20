import { describe, expect, it } from "vitest";

import {
  describeEnvironmentInstallCaveats,
  describeEnvironmentInstallLine,
  ENVIRONMENT_INSTALL_SCRIPT_PATH,
} from "./environmentInstall.logic";

describe("describeEnvironmentInstallLine", () => {
  it("builds the line from the address this browser is already using", () => {
    const line = describeEnvironmentInstallLine("https://t3.example.com/install.sh");
    expect(line).not.toBeNull();
    expect(line?.origin).toBe("https://t3.example.com");
    expect(line?.command).toBe("curl -fsSL https://t3.example.com/install.sh | sh");
    expect(line?.localOnly).toBe(false);
  });

  it("keeps a non-default port, because it is part of the address", () => {
    const line = describeEnvironmentInstallLine("http://box.lan:3773/install.sh");
    expect(line?.command).toBe("curl -fsSL http://box.lan:3773/install.sh | sh");
  });

  it("names the path the server actually serves", () => {
    expect(ENVIRONMENT_INSTALL_SCRIPT_PATH).toBe("/install.sh");
    const line = describeEnvironmentInstallLine(
      `https://t3.example.com${ENVIRONMENT_INSTALL_SCRIPT_PATH}`,
    );
    expect(line?.command).toContain(ENVIRONMENT_INSTALL_SCRIPT_PATH);
  });

  it("recognises the addresses that only mean anything locally", () => {
    for (const url of [
      "http://localhost:5173/install.sh",
      "http://127.0.0.1:3773/install.sh",
      "http://127.1.2.3/install.sh",
      "http://[::1]:3773/install.sh",
      "http://t3.localhost/install.sh",
      "http://0.0.0.0:3773/install.sh",
    ]) {
      expect(describeEnvironmentInstallLine(url)?.localOnly, url).toBe(true);
    }
  });

  it("does not call a real host local just because it looks like one", () => {
    // `127.example.com` and `localhost.evil.com` are ordinary names.
    expect(describeEnvironmentInstallLine("https://127.example.com/install.sh")?.localOnly).toBe(
      false,
    );
    expect(
      describeEnvironmentInstallLine("https://localhost.example.com/install.sh")?.localOnly,
    ).toBe(false);
  });

  it("returns null rather than a half-formed line", () => {
    expect(describeEnvironmentInstallLine(null)).toBeNull();
    expect(describeEnvironmentInstallLine(undefined)).toBeNull();
    expect(describeEnvironmentInstallLine("")).toBeNull();
    expect(describeEnvironmentInstallLine("   ")).toBeNull();
    expect(describeEnvironmentInstallLine("not a url")).toBeNull();
    // A path this route does not serve.
    expect(describeEnvironmentInstallLine("https://t3.example.com/")).toBeNull();
    expect(describeEnvironmentInstallLine("https://t3.example.com/install.sh/extra")).toBeNull();
    // Anything a person should not be pasting into a root shell.
    expect(describeEnvironmentInstallLine("https://u:p@t3.example.com/install.sh")).toBeNull();
    expect(describeEnvironmentInstallLine("https://t3.example.com/install.sh?token=x")).toBeNull();
    expect(describeEnvironmentInstallLine("https://t3.example.com/install.sh#x")).toBeNull();
    expect(describeEnvironmentInstallLine("file:///install.sh")).toBeNull();
    expect(describeEnvironmentInstallLine("javascript:alert(1)")).toBeNull();
  });
});

describe("describeEnvironmentInstallCaveats", () => {
  it("always says the tarball is still unpublished, because it still is", () => {
    const caveats = describeEnvironmentInstallCaveats(
      describeEnvironmentInstallLine("https://t3.example.com/install.sh"),
    );
    expect(caveats).toHaveLength(1);
    expect(caveats[0]?.detail).toContain("--base-url");
  });

  it("warns about a loopback address before somebody pastes it elsewhere", () => {
    const caveats = describeEnvironmentInstallCaveats(
      describeEnvironmentInstallLine("http://localhost:5173/install.sh"),
    );
    expect(caveats).toHaveLength(2);
    expect(caveats[0]?.detail).toContain("http://localhost:5173");
  });

  it("still warns about the tarball when there is no line at all", () => {
    expect(describeEnvironmentInstallCaveats(null)).toHaveLength(1);
  });
});
