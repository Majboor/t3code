import { describe, expect, it } from "vitest";

import {
  isProcessAlive,
  normalizeAddress,
  parseLsofListeners,
  parseNetstatListeners,
  parseSsListeners,
  splitAddressPort,
} from "./listenerProbe.ts";

describe("normalizeAddress", () => {
  it.each([
    ["*", "0.0.0.0"],
    ["[::]", "0.0.0.0"],
    ["::", "0.0.0.0"],
    ["0.0.0.0", "0.0.0.0"],
    ["[::1]", "::1"],
    ["127.0.0.1", "127.0.0.1"],
    ["  10.0.0.4 ", "10.0.0.4"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizeAddress(raw)).toBe(expected);
  });
});

describe("splitAddressPort", () => {
  it.each([
    ["127.0.0.1:3000", { address: "127.0.0.1", port: 3000 }],
    ["*:3000", { address: "0.0.0.0", port: 3000 }],
    ["[::1]:8080", { address: "::1", port: 8080 }],
    ["[::]:443", { address: "0.0.0.0", port: 443 }],
    // macOS netstat separates the port with a dot.
    ["127.0.0.1.3000", { address: "127.0.0.1", port: 3000 }],
    ["*.5432", { address: "0.0.0.0", port: 5432 }],
  ])("%s", (raw, expected) => {
    expect(splitAddressPort(raw)).toEqual(expected);
  });

  it.each([
    ["*.*"],
    [""],
    ["   "],
    ["127.0.0.1:"],
    [":3000"],
    ["127.0.0.1:0"],
    ["127.0.0.1:70000"],
    ["nonsense"],
  ])("refuses %s rather than inventing a port", (raw) => {
    expect(splitAddressPort(raw)).toBeNull();
  });
});

describe("parseLsofListeners", () => {
  it("carries the process down its sockets", () => {
    const stdout = ["p4821", "cbun", "f12", "n*:3000", "f13", "n127.0.0.1:3001", ""].join("\n");
    expect(parseLsofListeners(stdout)).toEqual([
      { port: 3000, address: "0.0.0.0", protocol: "tcp", pid: 4821, processName: "bun" },
      { port: 3001, address: "127.0.0.1", protocol: "tcp", pid: 4821, processName: "bun" },
    ]);
  });

  it("starts a new process at the next p line", () => {
    const stdout = ["p4821", "cbun", "n*:3000", "p812", "cpostgres", "n127.0.0.1:5432"].join("\n");
    expect(parseLsofListeners(stdout).map((entry) => [entry.pid, entry.processName])).toEqual([
      [4821, "bun"],
      [812, "postgres"],
    ]);
  });

  it("keeps a command name containing spaces intact", () => {
    const stdout = ["p91", "cGoogle Chrome Helper", "n127.0.0.1:9222"].join("\n");
    expect(parseLsofListeners(stdout)[0]?.processName).toBe("Google Chrome Helper");
  });

  it("drops established connections that slipped past the filter", () => {
    const stdout = ["p4821", "cbun", "n127.0.0.1:3000->10.0.0.2:51234", "n*:3000"].join("\n");
    expect(parseLsofListeners(stdout)).toHaveLength(1);
  });

  it("reports a socket with an unparseable pid as nameless rather than guessing", () => {
    const stdout = ["p", "cbun", "n*:3000"].join("\n");
    expect(parseLsofListeners(stdout)[0]).toMatchObject({ pid: null, processName: "bun" });
  });

  it("returns nothing for empty output", () => {
    expect(parseLsofListeners("")).toEqual([]);
  });
});

describe("parseSsListeners", () => {
  it("reads the address and the process", () => {
    const stdout =
      'LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=812,fd=6))';
    expect(parseSsListeners(stdout)).toEqual([
      { port: 80, address: "0.0.0.0", protocol: "tcp", pid: 812, processName: "nginx" },
    ]);
  });

  it("reads an IPv6 row", () => {
    const stdout =
      'LISTEN 0      511             [::]:80           [::]:*    users:(("nginx",pid=812,fd=7))';
    expect(parseSsListeners(stdout)[0]).toMatchObject({ port: 80, address: "0.0.0.0", pid: 812 });
  });

  it("reports a null pid when ss ran without the privilege to name processes", () => {
    const stdout = "LISTEN 0      4096       127.0.0.1:5432      0.0.0.0:*";
    expect(parseSsListeners(stdout)[0]).toMatchObject({
      port: 5432,
      pid: null,
      processName: null,
    });
  });

  it("marks a UDP row as udp", () => {
    const stdout =
      'UNCONN 0      0            0.0.0.0:68        0.0.0.0:*    users:(("dhclient",pid=5,fd=6))';
    expect(parseSsListeners(stdout)[0]?.protocol).toBe("udp");
  });

  it("skips a header an older build printed anyway", () => {
    const stdout = [
      "State  Recv-Q Send-Q Local Address:Port Peer Address:Port",
      'LISTEN 0      511          0.0.0.0:80        0.0.0.0:*    users:(("nginx",pid=812,fd=6))',
    ].join("\n");
    expect(parseSsListeners(stdout)).toHaveLength(1);
  });

  it("returns nothing for empty output", () => {
    expect(parseSsListeners("")).toEqual([]);
  });
});

describe("parseNetstatListeners", () => {
  it("reads macOS output and admits it knows no process", () => {
    const stdout = [
      "Active Internet connections (including servers)",
      "Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)",
      "tcp4       0      0  127.0.0.1.3000         *.*                    LISTEN",
      "tcp46      0      0  *.5432                 *.*                    LISTEN",
    ].join("\n");
    expect(parseNetstatListeners(stdout)).toEqual([
      { port: 3000, address: "127.0.0.1", protocol: "tcp", pid: null, processName: null },
      { port: 5432, address: "0.0.0.0", protocol: "tcp", pid: null, processName: null },
    ]);
  });

  it("reads Linux output", () => {
    const stdout = [
      "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
      "tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN",
      "tcp6       0      0 :::443                  :::*                    LISTEN",
    ].join("\n");
    expect(parseNetstatListeners(stdout).map((entry) => entry.port)).toEqual([80, 443]);
  });

  it("ignores everything that is not listening", () => {
    const stdout = [
      "tcp4       0      0  127.0.0.1.3000         10.0.0.2.51234         ESTABLISHED",
      "tcp4       0      0  127.0.0.1.3000         *.*                    LISTEN",
      "udp4       0      0  *.68                   *.*",
    ].join("\n");
    expect(parseNetstatListeners(stdout)).toHaveLength(1);
  });

  it("returns nothing for empty output", () => {
    expect(parseNetstatListeners("")).toEqual([]);
  });
});

describe("isProcessAlive", () => {
  it("finds the process asking the question", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("refuses a pid that is not a pid rather than throwing", () => {
    expect(isProcessAlive(0)).toBe(false);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(1.5)).toBe(false);
  });

  it("reports a pid nothing is using as gone", () => {
    // Above every platform's pid_max, so it cannot be in use.
    expect(isProcessAlive(4_294_967_294)).toBe(false);
  });
});
