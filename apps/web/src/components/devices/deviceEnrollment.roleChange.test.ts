import { describe, expect, it } from "vitest";

import { describeMachineRoleChange, MACHINE_ROLE_CHOICES } from "./deviceEnrollment.logic";

/**
 * The guidance a connected-machine row shows when somebody disagrees with its
 * role.
 *
 * What is worth asserting here is not the prose but the two properties that
 * make it safe to print: it always points at the *other* role, and it never
 * describes the role as something that permits or forbids anything. The second
 * is the one that would be easy to break by accident — "a runner cannot run
 * turns" reads naturally and is false, and the whole design rests on the role
 * being a statement of purpose rather than a boundary.
 */
describe("describeMachineRoleChange", () => {
  it("points a workspace at what a runner is, and a runner at what a workspace is", () => {
    expect(describeMachineRoleChange("workspace-host").otherRole).toBe("runner");
    expect(describeMachineRoleChange("runner").otherRole).toBe("workspace-host");
  });

  it("quotes the approval screen rather than inventing a second description", () => {
    for (const choice of MACHINE_ROLE_CHOICES) {
      const other = choice.role === "runner" ? "workspace-host" : "runner";
      expect(describeMachineRoleChange(other).otherDetail).toBe(choice.detail);
    }
  });

  it("names reconnecting from the machine, because nothing else writes the role", () => {
    for (const role of ["workspace-host", "runner"] as const) {
      const guidance = describeMachineRoleChange(role);
      expect(guidance.steps).toMatch(/disconnect/i);
      expect(guidance.steps).toMatch(/connect it again from the machine/i);
    }
  });

  it("describes the cost of a wrong role as a prompt, never as a refusal", () => {
    // A runner is exempt from being *asked*. It is not cut off from anything,
    // and copy that said so would be the first step towards the role becoming a
    // permission boundary it must never be.
    const runner = describeMachineRoleChange("runner");
    expect(runner.consequence).toMatch(/never asked/i);
    expect(runner.consequence).not.toMatch(/cannot|not allowed|blocked|denied|refused/i);

    const workspace = describeMachineRoleChange("workspace-host");
    expect(workspace.consequence).toMatch(/asked for a Claude or Codex account/i);
    expect(workspace.consequence).not.toMatch(/cannot|not allowed|blocked|denied|refused/i);
  });

  it("still says a turn needs a real account, so the exemption is not read as a licence", () => {
    // The one sentence that keeps the runner copy honest: not being asked at
    // setup is not the same as being able to work without an account.
    expect(describeMachineRoleChange("runner").consequence).toMatch(
      /account of your own|runs on an account/i,
    );
  });
});
