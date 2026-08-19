import { expect, it } from "@effect/vitest";
import { describe } from "vitest";

import {
  DeployRunId,
  DeployTargetId,
  ProjectId,
  type DeployRun,
  type DeployTarget,
} from "@t3tools/contracts";

import {
  analyticsPageUrl,
  deployRunJson,
  formatDeployRunFailure,
  formatDeployRuns,
  formatDeployRunSuccess,
  formatDeployTarget,
  formatDeployTargetList,
  formatElapsed,
  formatInstant,
  formatTargetAdded,
  formatUnknownTarget,
  infrastructurePageUrl,
  packPageUrl,
  renderTable,
  type WorkspaceOrigin,
} from "./cliOutput.ts";

const running: WorkspaceOrigin = { origin: "http://127.0.0.1:3773", observed: true };
const guessed: WorkspaceOrigin = { origin: "http://127.0.0.1:3773", observed: false };

const projectId = ProjectId.make("project-1");

const target: DeployTarget = {
  id: DeployTargetId.make("deploy-target:abc"),
  projectId,
  tenantId: null,
  name: "web-3000",
  kind: "command",
  command: "./start.sh",
  ssh: null,
  createdAt: "2026-08-19T10:00:00.000Z",
  updatedAt: "2026-08-19T10:00:00.000Z",
  archivedAt: null,
};

const sshTarget: DeployTarget = {
  ...target,
  id: DeployTargetId.make("deploy-target:ssh"),
  name: "prod",
  kind: "ssh",
  ssh: { host: "example.test", user: "deployer", remotePath: "/srv/app" },
};

const run: DeployRun = {
  id: DeployRunId.make("deploy-run:1"),
  targetId: target.id,
  projectId,
  status: "succeeded",
  exitCode: 0,
  output: "started on 3000",
  triggeredBy: "cli",
  startedAt: "2026-08-19T10:01:00.000Z",
  completedAt: "2026-08-19T10:01:04.200Z",
};

describe("page links", () => {
  it("points at the pages that show each kind of result", () => {
    expect(infrastructurePageUrl(running, projectId)).toBe("http://127.0.0.1:3773/infra/project-1");
    expect(analyticsPageUrl(running, projectId)).toBe("http://127.0.0.1:3773/analytics/project-1");
    expect(packPageUrl(running, "pack_1")).toBe("http://127.0.0.1:3773/pack/pack_1");
  });
});

describe("formatElapsed and formatInstant", () => {
  it("reads times as UTC so the output is the same everywhere", () => {
    expect(formatInstant("2026-08-19T10:01:04.200Z")).toBe("2026-08-19 10:01:04Z");
  });

  it("says nothing rather than a wrong duration for a run still going", () => {
    expect(formatElapsed(run.startedAt, null)).toBe("-");
  });

  it("switches to minutes once seconds stop being readable", () => {
    expect(formatElapsed("2026-08-19T10:00:00.000Z", "2026-08-19T10:00:04.200Z")).toBe("4.2s");
    expect(formatElapsed("2026-08-19T10:00:00.000Z", "2026-08-19T10:02:03.000Z")).toBe("2m 3s");
  });
});

describe("renderTable", () => {
  it("aligns columns and leaves the last one unpadded", () => {
    expect(renderTable(["A", "BB"], [["long-value", "x"]])).toBe("A           BB\nlong-value  x");
  });
});

describe("formatDeployTarget", () => {
  it("keeps the host, user and remote path the ssh-deploy pack promises are here", () => {
    const line = formatDeployTarget(sshTarget);
    expect(line).toContain("deploy-target:ssh");
    expect(line).toContain("ssh deployer@example.test:/srv/app");
    expect(line).toContain("./start.sh");
  });

  it("names the next command rather than only listing rows", () => {
    const output = formatDeployTargetList({ targets: [target], workspace: running });
    expect(output).toContain("t3 deploy run <targetId>");
    expect(output).toContain("http://127.0.0.1:3773/infra/project-1");
  });

  it("tells an empty workspace how to get its first target", () => {
    const output = formatDeployTargetList({ targets: [], workspace: running, projectId });
    expect(output).toContain("t3 deploy add --project project-1");
  });
});

describe("formatTargetAdded", () => {
  it("says the target is not live, because that is the mistake it is here to prevent", () => {
    const output = formatTargetAdded({ target, reused: false, workspace: running });
    expect(output).toContain("Nothing is live yet");
    expect(output).toContain("t3 deploy run deploy-target:abc");
  });

  it("distinguishes re-registering a name from adding a second target", () => {
    expect(formatTargetAdded({ target, reused: true, workspace: running })).toContain(
      "Updated deploy target",
    );
  });
});

describe("formatUnknownTarget", () => {
  it("lists what does exist instead of only saying the id is wrong", () => {
    const output = formatUnknownTarget({ requested: "typo", targets: [target, sshTarget] });
    expect(output).toContain("No deploy target 'typo'");
    expect(output).toContain("deploy-target:abc");
    expect(output).toContain("deploy-target:ssh");
  });

  it("says a workspace has none at all rather than showing an empty list", () => {
    const output = formatUnknownTarget({ requested: "typo", targets: [] });
    expect(output).toContain("this workspace has none at all");
    expect(output).toContain("t3 deploy add");
  });

  it("refuses a name that two targets answer to", () => {
    const twin = { ...sshTarget, name: target.name };
    const output = formatUnknownTarget({
      requested: "web-3000",
      targets: [target, twin],
      ambiguous: [target, twin],
    });
    expect(output).toContain("names 2 deploy targets");
  });
});

describe("formatDeployRunSuccess", () => {
  it("says what was wired to what, and where it is now visible", () => {
    const output = formatDeployRunSuccess({
      run,
      target,
      deploymentName: "web-3000",
      url: "http://127.0.0.1:3000",
      analytics: {
        stream: "page.view",
        action: "declared",
        keyVariable: "T3_ANALYTICS_INGEST_KEY",
        deploymentName: "web-3000",
        url: "http://127.0.0.1:3000",
      },
      workspace: running,
    });

    expect(output).toContain("page.view — stream declared");
    expect(output).toContain("T3_ANALYTICS_INGEST_KEY");
    expect(output).toContain("live at http://127.0.0.1:3000");
    expect(output).toContain("http://127.0.0.1:3773/infra/project-1");
    expect(output).toContain("http://127.0.0.1:3773/analytics/project-1");
    expect(output).toContain("started on 3000");
  });

  it("says analytics can only be wired here when the run did not wire it", () => {
    const output = formatDeployRunSuccess({
      run,
      target,
      deploymentName: "web-3000",
      workspace: running,
    });
    expect(output).toContain("--analytics-stream");
    expect(output).toContain("never stored");
    // No analytics means no analytics page to send anybody to yet.
    expect(output).not.toContain("/analytics/project-1");
  });

  it("marks an unchecked origin as the default rather than a fact", () => {
    const output = formatDeployRunSuccess({
      run,
      target,
      deploymentName: "web-3000",
      workspace: guessed,
    });
    expect(output).toContain("T3 is not running");
  });
});

describe("formatDeployRunFailure", () => {
  const failed: DeployRun = { ...run, status: "failed", exitCode: 3, output: "boom" };

  it("says nothing was registered, and where to look", () => {
    const output = formatDeployRunFailure({
      run: failed,
      target,
      deploymentName: "web-3000",
      workspace: running,
    });
    expect(output).toContain("failed (exit 3)");
    expect(output).toContain("Nothing was registered");
    expect(output).toContain("t3 deploy runs --target deploy-target:abc");
    expect(output).toContain("boom");
  });

  it("warns that a reissued key is already spent, since the old one has stopped working", () => {
    const output = formatDeployRunFailure({
      run: failed,
      target,
      deploymentName: "web-3000",
      analytics: {
        stream: "page.view",
        action: "reissued",
        keyVariable: "T3_ANALYTICS_INGEST_KEY",
        deploymentName: "web-3000",
      },
      workspace: running,
    });
    expect(output).toContain("can no longer write");
  });

  it("does not claim an existing reporter was cut off when the stream was new", () => {
    const output = formatDeployRunFailure({
      run: failed,
      target,
      deploymentName: "web-3000",
      analytics: {
        stream: "page.view",
        action: "declared",
        keyVariable: "T3_ANALYTICS_INGEST_KEY",
        deploymentName: "web-3000",
      },
      workspace: running,
    });
    expect(output).not.toContain("can no longer write");
    expect(output).toContain("until a deploy succeeds");
  });
});

describe("deployRunJson", () => {
  it("carries the wiring and the links, and never anything key-shaped", () => {
    const json = deployRunJson({
      run,
      target,
      deploymentName: "web-3000",
      url: "http://127.0.0.1:3000",
      analytics: {
        stream: "page.view",
        action: "declared",
        keyVariable: "T3_ANALYTICS_INGEST_KEY",
        deploymentName: "web-3000",
      },
      workspace: running,
    });

    expect(json).toMatchObject({
      projectId: "project-1",
      analytics: { stream: "page.view", action: "declared" },
      deployment: { name: "web-3000", url: "http://127.0.0.1:3000", status: "live" },
      links: {
        infrastructure: "http://127.0.0.1:3773/infra/project-1",
        analytics: "http://127.0.0.1:3773/analytics/project-1",
      },
    });
    // The ingest key exists in one process's environment and is never written
    // down. A JSON mode is exactly where it must not start appearing.
    expect(JSON.stringify(json)).not.toContain("ingestKey");
  });

  it("records no deployment for a run that failed", () => {
    const json = deployRunJson({
      run: { ...run, status: "failed", exitCode: 1 },
      target,
      deploymentName: "web-3000",
      workspace: running,
    });
    expect(json.deployment).toBeNull();
  });
});

describe("formatDeployRuns", () => {
  it("shows when, how long, what came of it, and against which target", () => {
    const output = formatDeployRuns({
      runs: [run, { ...run, id: DeployRunId.make("deploy-run:2"), status: "failed", exitCode: 3 }],
      targetNames: new Map([[target.id as string, target.name as string]]),
      workspace: running,
    });

    expect(output).toContain("Started");
    expect(output).toContain("2026-08-19 10:01:00Z");
    expect(output).toContain("4.2s");
    expect(output).toContain("web-3000");
    expect(output).toContain("failed");
    expect(output).toContain("http://127.0.0.1:3773/infra/project-1");
  });

  it("explains an empty history rather than leaving it a fact about nothing", () => {
    const output = formatDeployRuns({
      runs: [],
      targetNames: new Map(),
      workspace: running,
    });
    expect(output).toContain("Only `t3 deploy run` records one");
  });
});
