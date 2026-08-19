/**
 * What the deploy commands print.
 *
 * Kept out of `cli.ts` because the wording is the feature. A deploy that
 * succeeds and leaves the Infrastructure and Analytics pages empty is the most
 * confusing thing this product does, and the CLI is the only witness to why:
 * it is the process that mints the ingest key, registers the deployment, and
 * knows which project's page the result will appear on. None of that is
 * recoverable afterwards, so it has to be said at the moment it happens.
 *
 * Pure string functions on purpose — every line below is asserted in
 * `cliOutput.test.ts` without a database, a server, or a deploy.
 *
 * @module deploy/cliOutput
 */
import type { DeployRun, DeployTarget } from "@t3tools/contracts";

/**
 * Where the workspace's own pages are, and whether we actually know.
 *
 * `observed` is false when no server was running to ask, so the origin is the
 * default port rather than a fact. Printing a guessed URL as if it were
 * checked is how a person ends up believing the page is broken when nothing is
 * listening at all, so the two cases read differently.
 */
export interface WorkspaceOrigin {
  readonly origin: string;
  readonly observed: boolean;
}

const page = (workspace: WorkspaceOrigin, path: string): string =>
  `${workspace.origin.replace(/\/+$/, "")}${path}`;

export const infrastructurePageUrl = (workspace: WorkspaceOrigin, projectId: string): string =>
  page(workspace, `/infra/${encodeURIComponent(projectId)}`);

export const analyticsPageUrl = (workspace: WorkspaceOrigin, projectId: string): string =>
  page(workspace, `/analytics/${encodeURIComponent(projectId)}`);

export const packPageUrl = (workspace: WorkspaceOrigin, packId: string): string =>
  page(workspace, `/pack/${encodeURIComponent(packId)}`);

export const workspaceOriginNote = (workspace: WorkspaceOrigin): string | null =>
  workspace.observed
    ? null
    : "T3 is not running, so that address is the default rather than one this command checked. Start it with `t3 start`.";

// ── small shared shaping ────────────────────────────────────────────────────

/** ISO instants shown as UTC. Local time reads better and is not reproducible. */
export function formatInstant(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 19).replace("T", " ")}Z`;
}

export function formatElapsed(fromIso: string, toIso: string | null): string {
  if (toIso === null) return "-";
  const from = new Date(fromIso).getTime();
  const to = new Date(toIso).getTime();
  if (Number.isNaN(from) || Number.isNaN(to) || to < from) return "-";
  const seconds = (to - from) / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function renderTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: ReadonlyArray<string>) =>
    cells
      .map((cell, column) =>
        column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? cell.length),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
}

/** Two-column detail block; the shape every command's summary is printed in. */
export function renderDetails(entries: ReadonlyArray<readonly [string, string]>): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`).join("\n");
}

// ── targets ─────────────────────────────────────────────────────────────────

export function describeTargetLocation(target: DeployTarget): string {
  if (target.kind !== "ssh" || !target.ssh) return "local";
  const remotePath = target.ssh.remotePath ? `:${target.ssh.remotePath}` : "";
  return `ssh ${target.ssh.user}@${target.ssh.host}${remotePath}`;
}

/**
 * One line per target, unchanged in shape.
 *
 * The ssh-deploy pack tells the agent this listing "names every target this
 * project has, each with the start command it runs and, for an ssh target, its
 * host, user and remote path". That sentence is a promise about this line.
 */
export function formatDeployTarget(target: DeployTarget): string {
  return `${target.id}  ${target.name}  [${describeTargetLocation(target)}]  ${target.command}`;
}

export function formatDeployTargetList(input: {
  readonly targets: ReadonlyArray<DeployTarget>;
  readonly workspace: WorkspaceOrigin;
  readonly projectId?: string | undefined;
}): string {
  if (input.targets.length === 0) {
    return [
      "No deploy targets configured.",
      "",
      "Add one, then run it:",
      `  t3 deploy add --project ${input.projectId ?? "<projectId>"} --name <name> --command '<start command>'`,
      "  t3 deploy run <targetId> --url <where it will be reachable>",
    ].join("\n");
  }

  const projectIds = [...new Set(input.targets.map((target) => target.projectId as string))];
  return [
    input.targets.map(formatDeployTarget).join("\n"),
    "",
    "Run one with:  t3 deploy run <targetId> --url <where it will be reachable>",
    ...projectIds.map(
      (projectId) => `Infrastructure: ${infrastructurePageUrl(input.workspace, projectId)}`,
    ),
  ].join("\n");
}

export function deployTargetJson(target: DeployTarget): Record<string, unknown> {
  return {
    id: target.id,
    projectId: target.projectId,
    name: target.name,
    kind: target.kind,
    command: target.command,
    location: describeTargetLocation(target),
    ssh: target.ssh,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

export function formatTargetAdded(input: {
  readonly target: DeployTarget;
  readonly reused: boolean;
  readonly workspace: WorkspaceOrigin;
}): string {
  const verb = input.reused ? "Updated deploy target" : "Added deploy target";
  return [
    `${verb} ${input.target.id} (${input.target.name}).`,
    renderDetails([
      ["Project", input.target.projectId],
      ["Runs", `${describeTargetLocation(input.target)}: ${input.target.command}`],
    ]),
    "",
    // A target on its own puts nothing live and shows nothing on any page.
    // Saying so here is the difference between "added" and "done".
    "Nothing is live yet — a target is a recipe. Put it live with:",
    `  t3 deploy run ${input.target.id} --url <where it will be reachable>`,
    `Infrastructure: ${infrastructurePageUrl(input.workspace, input.target.projectId)}`,
  ].join("\n");
}

/**
 * The error for a target id that does not resolve.
 *
 * Loud, and specifically loud about what does exist: an agent picks the id out
 * of an earlier turn and gets it wrong, and "not found" alone leaves it
 * guessing between a typo, a deleted target, and the wrong project.
 */
export function formatUnknownTarget(input: {
  readonly requested: string;
  readonly targets: ReadonlyArray<DeployTarget>;
  readonly ambiguous?: ReadonlyArray<DeployTarget> | undefined;
}): string {
  if (input.ambiguous && input.ambiguous.length > 1) {
    return [
      `'${input.requested}' names ${input.ambiguous.length} deploy targets, so it is not enough to run one.`,
      "",
      "Pass the id of the one you mean:",
      ...input.ambiguous.map((target) => `  ${formatDeployTarget(target)}`),
    ].join("\n");
  }

  if (input.targets.length === 0) {
    return [
      `No deploy target '${input.requested}' — this workspace has none at all, so nothing was run.`,
      "",
      "Register the start command first, then run it:",
      "  t3 deploy add --project <projectId> --name <name> --command '<start command>'",
      "  t3 deploy run <targetId> --url <where it will be reachable>",
    ].join("\n");
  }

  return [
    `No deploy target '${input.requested}', so nothing was run.`,
    "",
    "This workspace has these:",
    ...input.targets.map((target) => `  ${formatDeployTarget(target)}`),
    "",
    "Pass one of those ids (or its exact name), or add a new target with `t3 deploy add`.",
  ].join("\n");
}

// ── a run ───────────────────────────────────────────────────────────────────

/** What the run did about analytics, decided before the deploy process started. */
export interface DeployAnalyticsOutcome {
  readonly stream: string;
  readonly action: "declared" | "reissued";
  readonly keyVariable: string;
  readonly deploymentName: string;
  readonly url?: string | undefined;
}

export interface DeployRunReport {
  readonly run: DeployRun;
  readonly target: DeployTarget;
  readonly analytics?: DeployAnalyticsOutcome | undefined;
  readonly deploymentName: string;
  readonly url?: string | undefined;
  readonly workspace: WorkspaceOrigin;
}

const analyticsSummary = (outcome: DeployAnalyticsOutcome): string =>
  outcome.action === "declared"
    ? `${outcome.stream} — stream declared, ingest key injected as ${outcome.keyVariable}`
    : `${outcome.stream} — existing stream, ingest key reissued and injected as ${outcome.keyVariable}`;

export function formatDeployRunSuccess(report: DeployRunReport): string {
  const projectId = report.target.projectId as string;
  const details: Array<readonly [string, string]> = [
    ["Target", `${report.target.name} (${report.target.id})`],
    ["Project", projectId],
    [
      "Deployment",
      `${report.deploymentName} — live${report.url === undefined ? "" : ` at ${report.url}`}`,
    ],
    ["Took", formatElapsed(report.run.startedAt, report.run.completedAt)],
    [
      "Analytics",
      report.analytics === undefined
        ? "not wired. Add --analytics-stream <name> here to wire it; the ingest key is minted by this command and never stored, so no other route can."
        : analyticsSummary(report.analytics),
    ],
  ];

  const note = workspaceOriginNote(report.workspace);
  return [
    `Deploy ${report.run.id} succeeded.`,
    renderDetails(details),
    "",
    "Now visible on:",
    `  Infrastructure  ${infrastructurePageUrl(report.workspace, projectId)}`,
    ...(report.analytics === undefined
      ? []
      : [`  Analytics       ${analyticsPageUrl(report.workspace, projectId)}`]),
    ...(note === null ? [] : [note]),
    ...(report.run.output.length === 0 ? [] : ["", report.run.output]),
  ]
    .join("\n")
    .trimEnd();
}

export function formatDeployRunFailure(report: DeployRunReport): string {
  const details: Array<readonly [string, string]> = [
    ["Target", `${report.target.name} (${report.target.id})`],
    ["Project", report.target.projectId],
    ["Ran", `${describeTargetLocation(report.target)}: ${report.target.command}`],
  ];

  return [
    `Deploy ${report.run.id} failed (exit ${report.run.exitCode ?? "unknown"}).`,
    renderDetails(details),
    "",
    "Nothing was registered: a failed run leaves the previous deployment recorded as it was.",
    // The key is minted before the process starts, because it has to be in
    // that process's environment. A failed run has therefore already spent it,
    // and for a stream that already existed that means the old key is gone and
    // whatever held it has quietly stopped being able to write.
    ...(report.analytics === undefined
      ? []
      : report.analytics.action === "reissued"
        ? [
            `The ${report.analytics.stream} ingest key was replaced before the command ran, so whatever was reporting to that stream can no longer write. Re-run this deploy to hand out a working one.`,
          ]
        : [
            `${report.analytics.stream} was declared, but its key went to a command that failed, so nothing can report to it until a deploy succeeds.`,
          ]),
    `Earlier runs: t3 deploy runs --target ${report.target.id}`,
    ...(report.run.output.length === 0 ? [] : ["", report.run.output]),
  ]
    .join("\n")
    .trimEnd();
}

/**
 * The machine-readable form of a run.
 *
 * No ingest key, here or anywhere else this file can reach. It is minted into
 * one process's environment and never written down; a JSON mode exists to be
 * piped into other programs and logs, which is the last place it should land.
 */
export function deployRunJson(report: DeployRunReport): Record<string, unknown> {
  const projectId = report.target.projectId as string;
  return {
    run: {
      id: report.run.id,
      status: report.run.status,
      exitCode: report.run.exitCode,
      startedAt: report.run.startedAt,
      completedAt: report.run.completedAt,
      triggeredBy: report.run.triggeredBy,
      output: report.run.output,
    },
    target: {
      id: report.target.id,
      name: report.target.name,
      kind: report.target.kind,
      command: report.target.command,
    },
    projectId,
    deployment:
      report.run.status === "succeeded"
        ? { name: report.deploymentName, url: report.url ?? null, status: "live" }
        : null,
    analytics:
      report.analytics === undefined
        ? null
        : {
            stream: report.analytics.stream,
            action: report.analytics.action,
            keyVariable: report.analytics.keyVariable,
          },
    links: {
      infrastructure: infrastructurePageUrl(report.workspace, projectId),
      analytics: analyticsPageUrl(report.workspace, projectId),
    },
  };
}

// ── run history ─────────────────────────────────────────────────────────────

export function formatDeployRuns(input: {
  readonly runs: ReadonlyArray<DeployRun>;
  readonly targetNames: ReadonlyMap<string, string>;
  readonly workspace: WorkspaceOrigin;
}): string {
  if (input.runs.length === 0) {
    return [
      "No deploy runs recorded.",
      "",
      "Only `t3 deploy run` records one. A process started by hand serves perfectly and leaves nothing here, on the Infrastructure page, or on the Analytics page.",
    ].join("\n");
  }

  const rows = input.runs.map((run) => [
    formatInstant(run.startedAt),
    run.status,
    formatElapsed(run.startedAt, run.completedAt),
    run.exitCode === null ? "-" : String(run.exitCode),
    run.triggeredBy,
    `${input.targetNames.get(run.targetId as string) ?? "(deleted target)"}  ${run.targetId}`,
  ]);

  const projectIds = [...new Set(input.runs.map((run) => run.projectId as string))];
  return [
    renderTable(["Started", "Status", "Took", "Exit", "By", "Target"], rows),
    "",
    ...projectIds.map(
      (projectId) => `Infrastructure: ${infrastructurePageUrl(input.workspace, projectId)}`,
    ),
  ].join("\n");
}

export function deployRunJsonEntry(
  run: DeployRun,
  targetNames: ReadonlyMap<string, string>,
): Record<string, unknown> {
  return {
    id: run.id,
    status: run.status,
    exitCode: run.exitCode,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    elapsed: formatElapsed(run.startedAt, run.completedAt),
    triggeredBy: run.triggeredBy,
    targetId: run.targetId,
    targetName: targetNames.get(run.targetId as string) ?? null,
    projectId: run.projectId,
    output: run.output,
  };
}
