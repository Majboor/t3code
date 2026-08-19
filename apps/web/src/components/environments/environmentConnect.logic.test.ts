import type { AuthSessionState } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  canBrowserSatisfyAuthGate,
  classifyEnvironmentFailure,
  classifyEnvironmentInput,
  describeListedEnvironment,
  resolveAddEnvironmentNextStep,
  type AddEnvironmentDraft,
} from "./environmentConnect.logic";

function draft(overrides: Partial<AddEnvironmentDraft>): AddEnvironmentDraft {
  return {
    mode: "pairing-url",
    label: "",
    pairingUrl: "",
    host: "",
    pairingCode: "",
    ...overrides,
  };
}

class HttpishError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

describe("classifyEnvironmentInput", () => {
  it("recognises a pairing URL by the token it carries", () => {
    expect(classifyEnvironmentInput("https://desk.example.com/pair#token=abc123")).toBe(
      "pairing-url",
    );
    expect(classifyEnvironmentInput("https://desk.example.com/pair?token=abc123")).toBe(
      "pairing-url",
    );
  });

  it("treats a bare address as a host that still needs a code", () => {
    expect(classifyEnvironmentInput("desk.example.com:3210")).toBe("host");
    expect(classifyEnvironmentInput("http://192.168.1.20:3210")).toBe("host");
    expect(classifyEnvironmentInput("https://desk.example.com/pair")).toBe("host");
  });

  it("reports nothing typed as nothing typed", () => {
    expect(classifyEnvironmentInput("")).toBe("empty");
    expect(classifyEnvironmentInput("   ")).toBe("empty");
  });

  it("does not throw on input that is not a URL at all", () => {
    expect(classifyEnvironmentInput("my laptop")).toBe("host");
  });
});

describe("resolveAddEnvironmentNextStep", () => {
  it("asks for the pairing link before anything else", () => {
    expect(resolveAddEnvironmentNextStep(draft({})).kind).toBe("needs-pairing-url");
  });

  it("hands the pairing URL through untouched once one is present", () => {
    const step = resolveAddEnvironmentNextStep(
      draft({ label: "  Studio Mac  ", pairingUrl: " https://desk.example.com/pair#token=abc " }),
    );
    expect(step).toMatchObject({
      kind: "ready",
      submit: { label: "Studio Mac", pairingUrl: "https://desk.example.com/pair#token=abc" },
    });
  });

  it("catches a tokenless address pasted into the pairing-link field", () => {
    const step = resolveAddEnvironmentNextStep(
      draft({ pairingUrl: "https://desk.example.com/pair" }),
    );
    expect(step.kind).toBe("needs-pairing-code");
    expect(step.hint).toContain("no pairing token");
  });

  it("walks host mode from host to code to ready", () => {
    expect(resolveAddEnvironmentNextStep(draft({ mode: "host-code" })).kind).toBe("needs-host");
    expect(
      resolveAddEnvironmentNextStep(draft({ mode: "host-code", host: "desk.local:3210" })).kind,
    ).toBe("needs-pairing-code");
    expect(
      resolveAddEnvironmentNextStep(
        draft({ mode: "host-code", host: " desk.local:3210 ", pairingCode: " 4821 " }),
      ),
    ).toMatchObject({
      kind: "ready",
      submit: { host: "desk.local:3210", pairingCode: "4821" },
    });
  });

  it("keeps an empty label empty rather than inventing one", () => {
    const step = resolveAddEnvironmentNextStep(
      draft({ pairingUrl: "https://desk.example.com/pair#token=abc" }),
    );
    expect(step.kind === "ready" && step.submit.label).toBe("");
  });
});

describe("classifyEnvironmentFailure", () => {
  it("separates a request nothing answered from one that was turned down", () => {
    const unreachable = classifyEnvironmentFailure(
      new Error(
        "Failed to fetch remote auth endpoint https://desk.local/api/auth/bootstrap/bearer (Load failed).",
      ),
      { target: "desk.local" },
    );
    expect(unreachable.kind).toBe("unreachable");
    expect(unreachable.title).toBe("Could not reach that machine");
    expect(unreachable.message).toContain("Nothing answered at desk.local");

    const refused = classifyEnvironmentFailure(new HttpishError("Invalid credential.", 401), {
      target: "desk.local",
    });
    expect(refused.kind).toBe("refused");
    expect(refused.title).toBe("That machine refused the code");
    expect(refused.message).toContain("single-use");
  });

  it("does not call a 404 a refusal — that is the wrong port, not the wrong code", () => {
    const failure = classifyEnvironmentFailure(new HttpishError("Not Found", 404));
    expect(failure.kind).toBe("not-an-environment");
    expect(failure.message).toContain("Check the port");
  });

  it("names a server-side failure as the machine's problem, not the code's", () => {
    const failure = classifyEnvironmentFailure(new HttpishError("boom", 503), {
      target: "desk.local",
    });
    expect(failure.kind).toBe("refused");
    expect(failure.title).toBe("That machine answered with an error");
  });

  it("recognises a duplicate and points at the list", () => {
    const failure = classifyEnvironmentFailure(new Error("This environment is already connected."));
    expect(failure.kind).toBe("already-added");
    expect(failure.message).toContain("Select it below");
  });

  it("recognises a link with no token in it", () => {
    expect(classifyEnvironmentFailure(new Error("Pairing URL is missing its token.")).kind).toBe(
      "invalid-input",
    );
    expect(classifyEnvironmentFailure(new Error("Enter a pairing code.")).kind).toBe(
      "invalid-input",
    );
  });

  it("separates a browser that will not store the credential from a pairing failure", () => {
    const failure = classifyEnvironmentFailure(
      new Error("Unable to persist saved environment credentials."),
    );
    expect(failure.kind).toBe("storage");
    expect(failure.title).toBe("Connected, but could not remember it");
  });

  it("falls back to the raw message rather than swallowing an unknown error", () => {
    const failure = classifyEnvironmentFailure(new Error("kaboom"));
    expect(failure.kind).toBe("unknown");
    expect(failure.message).toBe("kaboom");
    expect(failure.detail).toBe("kaboom");
  });
});

describe("describeListedEnvironment", () => {
  const base = {
    connectionState: "disconnected",
    authState: "unknown",
    lastError: null,
    lastConnectedAt: null,
  } as const;

  it("reports a live connection", () => {
    expect(
      describeListedEnvironment({
        ...base,
        connectionState: "connected",
        authState: "authenticated",
      }),
    ).toMatchObject({ state: "connected", tone: "positive", canRetry: false });
  });

  it("reports an in-flight connection without offering a retry", () => {
    expect(describeListedEnvironment({ ...base, connectionState: "connecting" })).toMatchObject({
      state: "connecting",
      canRetry: false,
    });
    expect(describeListedEnvironment({ ...base, isRetrying: true })).toMatchObject({
      state: "connecting",
      statusText: "Reconnecting…",
    });
  });

  it("calls a rejected session refused, not unreachable", () => {
    expect(
      describeListedEnvironment({
        ...base,
        connectionState: "error",
        authState: "requires-auth",
      }),
    ).toMatchObject({ state: "refused", tone: "negative" });

    expect(
      describeListedEnvironment({
        ...base,
        connectionState: "error",
        lastError: "Remote auth request failed (401).",
      }),
    ).toMatchObject({ state: "refused" });
  });

  it("calls a transport failure unreachable", () => {
    const presentation = describeListedEnvironment({
      ...base,
      connectionState: "error",
      lastError: "WebSocket closed before it opened.",
    });
    expect(presentation.state).toBe("unreachable");
    expect(presentation.statusText).toBe("Cannot be reached at that address");
  });

  it("does not call a machine that is merely switched off broken", () => {
    const presentation = describeListedEnvironment({
      ...base,
      connectionState: "disconnected",
      lastConnectedAt: "2026-08-01T09:00:00.000Z",
    });
    expect(presentation.state).toBe("asleep");
    expect(presentation.tone).toBe("idle");
    expect(presentation.statusText).toContain("probably off");
    expect(presentation.canRetry).toBe(true);
  });

  it("distinguishes a saved environment that has never connected", () => {
    expect(describeListedEnvironment(base)).toMatchObject({
      state: "never-connected",
      retryLabel: "Connect",
    });
  });

  it("keeps a refusal visible after the socket has closed", () => {
    expect(
      describeListedEnvironment({
        ...base,
        connectionState: "disconnected",
        authState: "requires-auth",
        lastConnectedAt: "2026-08-01T09:00:00.000Z",
      }),
    ).toMatchObject({ state: "refused" });
  });
});

describe("canBrowserSatisfyAuthGate", () => {
  const auth = (overrides: Partial<AuthSessionState["auth"]>): AuthSessionState["auth"] =>
    ({
      policy: "desktop-managed-local",
      bootstrapMethods: ["desktop-bootstrap"],
      sessionMethods: ["browser-session-cookie"],
      sessionCookieName: "t3_session",
      ...overrides,
    }) as AuthSessionState["auth"];

  it("is false when the only way in is a desktop handoff a browser cannot perform", () => {
    expect(canBrowserSatisfyAuthGate(auth({}))).toBe(false);
  });

  it("is true when a one-time token is accepted", () => {
    expect(
      canBrowserSatisfyAuthGate(
        auth({ bootstrapMethods: ["desktop-bootstrap", "one-time-token"] }),
      ),
    ).toBe(true);
  });

  it("is true when the server offers a password sign-in", () => {
    expect(canBrowserSatisfyAuthGate(auth({ localPassword: { enabled: true } }))).toBe(true);
  });
});
