import type {
  EnvironmentApi,
  PackManifest,
  PackRegistryEntry,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "~/environmentApi";
import { useStore } from "~/store";

import type { Pack, PackRequirements, PackScope } from "./packMode.logic";
import { packMeetsRequirements } from "./packMode.logic";

export interface PackSearchRequest {
  /** What the person is about to ask the agent to build. */
  readonly query: string;
  readonly scope: PackScope;
  /**
   * Sent with the request rather than filtered afterwards: the directory holds
   * the signals, so it is the only side that can rank on them.
   */
  readonly requirements: PackRequirements;
}

export interface PackDirectory {
  searchPacks(request: PackSearchRequest): Promise<readonly Pack[]>;
}

/**
 * Candidates whose manifests are opened. The registry index carries a summary
 * and no signals, so the numbers a person filters on only exist inside the
 * manifest — and a suggestion box that reads twenty of them per keystroke is
 * not worth the answer.
 */
const SEARCH_CANDIDATE_LIMIT = 8;

const DAYS_PER_MONTH = 30;

interface PackViewerScope {
  readonly api: EnvironmentApi;
  readonly tenantId: TenantId;
  readonly workspaceId: WorkspaceId;
}

/**
 * The workspace the browser is signed into. The suggestion box is offered from
 * the prompt box rather than from a project, so there is no scope in hand and
 * the connected environment has to be asked for one.
 */
async function resolveViewerScope(): Promise<PackViewerScope | undefined> {
  const environmentId = useStore.getState().activeEnvironmentId;
  if (!environmentId) return undefined;
  const api = readEnvironmentApi(environmentId);
  if (!api) return undefined;

  const snapshot = await api.organizations.list();
  const tenantId = snapshot.tenants[0]?.id;
  if (!tenantId) return undefined;
  const workspaceId = (snapshot.workspaces ?? []).find(
    (workspace) => workspace.tenantId === tenantId && workspace.archivedAt === null,
  )?.id;
  if (!workspaceId) return undefined;

  return { api, tenantId, workspaceId };
}

/** Whole months between the first deployment and the moment the record was taken. */
function monthsInService(manifest: PackManifest): number {
  const { record } = manifest.verification;
  if (record.firstDeployedAt === undefined) {
    return Math.floor((record.longestServiceDays ?? 0) / DAYS_PER_MONTH);
  }
  const elapsedMs = Date.parse(record.measuredAt) - Date.parse(record.firstDeployedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  return Math.floor(elapsedMs / (DAYS_PER_MONTH * 24 * 60 * 60 * 1000));
}

/**
 * Somebody other than the publisher with it running. Counted from attestations
 * that name a production deployment, because that is the only claim in the
 * format made by a party the publisher does not control.
 */
function independentOperators(manifest: PackManifest): number {
  return (manifest.verification.attestations ?? []).filter((attestation) =>
    attestation.did.includes("deployed-to-production"),
  ).length;
}

function toPack(entry: PackRegistryEntry, manifest: PackManifest): Pack {
  const { record } = manifest.verification;
  const requiredEnvironment = (manifest.requirements.environment ?? [])
    .filter((variable) => variable.required)
    .map((variable) => variable.purpose);
  const requiredAccounts = (manifest.requirements.accounts ?? []).map(
    (account) => account.purpose,
  );

  return {
    id: entry.packId,
    name: entry.displayName,
    version: entry.latestVersion,
    // Everything a stranger can reach is the ecosystem; only a pack that never
    // left its own workspace is workspace-scoped.
    scope: entry.visibility.scope === "workspace" ? "workspace" : "ecosystem",
    summary: entry.summary,
    handles: (manifest.knowledge.failureModes ?? []).map((failure) => failure.symptom),
    requires: [...requiredAccounts, ...requiredEnvironment],
    signals: {
      deployments: record.deploymentsSurviving,
      monthsInService: monthsInService(manifest),
      independentOperators: independentOperators(manifest),
      cleanInstallRate:
        record.installsAttempted > 0 ? record.installsSucceeded / record.installsAttempted : 0,
      breakagesCaught: record.breakagesCaught,
    },
  };
}

/**
 * The seam, bound to the served registry. Requirements are applied here rather
 * than on the server because the numbers behind them live in the manifest and
 * the registry index does not carry them.
 */
export const packDirectory: PackDirectory = {
  async searchPacks(request: PackSearchRequest): Promise<readonly Pack[]> {
    const query = request.query.trim();
    if (query.length === 0) return [];

    const scope = await resolveViewerScope();
    if (!scope) return [];

    const { packs } = await scope.api.packs.search({
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      query,
      limit: SEARCH_CANDIDATE_LIMIT,
    });

    const candidates = await Promise.all(
      packs.map(async (entry) => {
        const found = await scope.api.packs.get({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          packId: entry.packId,
        });
        return toPack(entry, found.manifest);
      }),
    );

    return candidates.filter(
      (pack) =>
        (request.scope === "ecosystem" || pack.scope === "workspace") &&
        packMeetsRequirements(pack, request.requirements),
    );
  },
};
