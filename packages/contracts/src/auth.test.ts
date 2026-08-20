import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import {
  decideProviderSetupPrompt,
  MachineRole,
  resolveMachineRole,
  RUNNER_PROVIDER_SETUP_EXEMPTION,
  ServerAuthDescriptor,
  WORKSPACE_HOST_PROVIDER_SETUP_PROMPT,
} from "./auth.ts";

const decodeServerAuthDescriptor = Schema.decodeUnknownSync(ServerAuthDescriptor);

describe("auth contracts", () => {
  it("validates public Supabase auth descriptor config", () => {
    const descriptor = decodeServerAuthDescriptor({
      policy: "remote-reachable",
      bootstrapMethods: ["one-time-token"],
      sessionMethods: ["browser-session-cookie", "bearer-session-token"],
      sessionCookieName: "t3_session",
      supabase: {
        projectUrl: "https://project-ref.supabase.co/",
        anonKey: "anon-public-key",
        audience: "authenticated",
      },
    });

    expect(descriptor.supabase).toEqual({
      projectUrl: "https://project-ref.supabase.co/",
      anonKey: "anon-public-key",
      audience: "authenticated",
    });
  });
});

describe("resolveMachineRole", () => {
  it("reads the two roles a machine can hold", () => {
    expect(resolveMachineRole({ role: "workspace-host" })).toBe("workspace-host");
    expect(resolveMachineRole({ role: "runner" })).toBe("runner");
  });

  it("treats every machine connected before the column existed as a workspace host", () => {
    // A row from migration 060 has a null role, a wire payload from an older
    // server has no field at all, and a caller may hold neither yet. All three
    // describe a laptop somebody works on, which is all there was.
    expect(resolveMachineRole({ role: null })).toBe("workspace-host");
    expect(resolveMachineRole({})).toBe("workspace-host");
    expect(resolveMachineRole(undefined)).toBe("workspace-host");
    expect(resolveMachineRole(null)).toBe("workspace-host");
  });

  it("falls back to the role that asks, never the role that skips", () => {
    // The asymmetry that matters: a value this build cannot read must not be
    // able to talk the app out of asking for a provider account. Unknown is
    // resolved towards the prompt, not away from it.
    for (const unreadable of ["deploy-box", "RUNNER", "runner ", "", "workspace_host"]) {
      expect(resolveMachineRole({ role: unreadable })).toBe("workspace-host");
    }
  });

  it("answers with a role the schema accepts, whatever it was given", () => {
    const decode = Schema.decodeUnknownSync(MachineRole);
    for (const machine of [{ role: "runner" }, { role: "nonsense" }, {}]) {
      expect(decode(resolveMachineRole(machine))).toBe(resolveMachineRole(machine));
    }
  });
});

describe("decideProviderSetupPrompt", () => {
  it("asks a workspace host with no account to connect one", () => {
    expect(
      decideProviderSetupPrompt({
        machine: { role: "workspace-host" },
        providerAccountConnected: false,
      }),
    ).toEqual({
      ask: true,
      reason: "no-account-connected",
      message: WORKSPACE_HOST_PROVIDER_SETUP_PROMPT,
    });
  });

  it("leaves a workspace host alone once an account is connected", () => {
    expect(
      decideProviderSetupPrompt({
        machine: { role: "workspace-host" },
        providerAccountConnected: true,
      }),
    ).toEqual({ ask: false, reason: "already-connected", message: null });
  });

  it("never asks a runner, whether or not the person has an account", () => {
    // The point of the whole distinction: connecting a deploy box must not
    // become a provider login, and that cannot depend on what the person
    // happens to have connected already.
    for (const providerAccountConnected of [true, false]) {
      expect(
        decideProviderSetupPrompt({ machine: { role: "runner" }, providerAccountConnected }),
      ).toEqual({
        ask: false,
        reason: "runner",
        message: RUNNER_PROVIDER_SETUP_EXEMPTION,
      });
    }
  });

  it("keeps asking machines whose role it cannot read", () => {
    for (const machine of [{}, { role: null }, { role: "deploy-box" }, undefined]) {
      expect(decideProviderSetupPrompt({ machine, providerAccountConnected: false }).ask).toBe(
        true,
      );
    }
  });

  it("says why it is not asking, so a runner does not look like a broken page", () => {
    const decided = decideProviderSetupPrompt({
      machine: { role: "runner" },
      providerAccountConnected: false,
    });
    expect(decided.message).toMatch(/no turn executes here/i);
    expect(decided.message).not.toMatch(/connect/i);
  });

  it("points a workspace host at the one place that fixes it", () => {
    // The wording is the feature. A prompt that does not name Settings →
    // Connections leaves somebody knowing they are blocked and not where to go.
    expect(WORKSPACE_HOST_PROVIDER_SETUP_PROMPT).toMatch(/Settings → Connections/);
  });
});
