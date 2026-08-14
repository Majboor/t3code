import { describe, expect, it } from "vitest";

import { buildDeployTargetCommand, listDeployInputs } from "./PackDeployControl";

const runtime = (commands: Record<string, unknown>) => ({ target: "python", commands }) as never;

describe("buildDeployTargetCommand", () => {
  it("is null when the pack declares nothing to start", () => {
    expect(buildDeployTargetCommand(runtime({}))).toBeNull();
  });

  it("quotes the start command so a shell cannot split it", () => {
    const command = buildDeployTargetCommand(
      runtime({ start: { command: 'gunicorn -b 127.0.0.1:8000 "app:app"' } }),
    );
    expect(command).toContain('--command "gunicorn -b 127.0.0.1:8000 \\"app:app\\""');
  });

  it("carries the declared working directory into the command", () => {
    const command = buildDeployTargetCommand(
      runtime({ start: { command: "npm start", cwd: "server" } }),
    );
    expect(command).toContain('"cd server && npm start"');
  });

  it("leaves a cwd of . out, since that is where the command already runs", () => {
    const command = buildDeployTargetCommand(
      runtime({ start: { command: "npm start", cwd: "." } }),
    );
    expect(command).toContain('"npm start"');
    expect(command).not.toContain("cd .");
  });
});

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
