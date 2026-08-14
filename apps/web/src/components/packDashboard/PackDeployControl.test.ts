import { describe, expect, it } from "vitest";

import { listDeployInputs } from "./PackDeployControl";

// The `t3 deploy add` template this file used to build is gone: it carried
// <projectId> and <target name> for a reader to fill in, which is not something
// an agent can run. What the deploy surface offers now is a prompt, built and
// tested in packDetail.logic.

describe("listDeployInputs", () => {
  it("keeps only what the pack says is required, and remembers which are secret", () => {
    const { required } = listDeployInputs({
      environment: [
        { name: "HOST", purpose: "where", secret: false, required: true },
        { name: "TOKEN", purpose: "auth", secret: true, required: true },
        { name: "DEBUG", purpose: "noise", secret: false, required: false },
      ],
    } as never);

    expect(required.map((entry) => entry.name)).toEqual(["HOST", "TOKEN"]);
    expect(required.find((entry) => entry.name === "TOKEN")?.secret).toBe(true);
  });

  it("copes with a pack that asks for no environment at all", () => {
    expect(listDeployInputs({} as never).required).toEqual([]);
  });
});
