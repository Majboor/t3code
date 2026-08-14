import type {
  EnvironmentId,
  PackReleaseHistory,
  PackVisibility,
  TenantId,
  WorkspaceId,
} from "@t3tools/contracts";

import type {
  PackDetail,
  PackDetailRequest,
  PackDetailSource,
  PackVisibilityChangeRequest,
} from "./packDetailSource";
import { readEnvironmentApi } from "../../environmentApi";

/**
 * The registry is scoped to a workspace, and a pack page opened from a link has
 * no project context to take one from. So the scope is resolved here: the first
 * workspace this session can see, in the environment it is connected to.
 *
 * That is a real limitation rather than a placeholder. Somebody in two
 * workspaces will read a pack against the wrong one, and the fix is a scope in
 * the route — which is a change to every link that points at a pack, not to
 * this file.
 */
async function resolveScope(
  environmentId: EnvironmentId,
): Promise<{ tenantId: TenantId; workspaceId: WorkspaceId } | null> {
  const api = readEnvironmentApi(environmentId);
  if (!api) return null;

  const snapshot = await api.organizations.list();
  const workspace = (snapshot.workspaces ?? [])[0];
  if (!workspace) return null;
  return { tenantId: workspace.tenantId, workspaceId: workspace.id };
}

/** Reads packs from the registry the server actually serves. */
export function createLivePackDetailSource(
  readEnvironmentId: () => EnvironmentId | null,
): PackDetailSource {
  const withScope = async <Value>(
    run: (input: {
      api: NonNullable<ReturnType<typeof readEnvironmentApi>>;
      tenantId: TenantId;
      workspaceId: WorkspaceId;
    }) => Promise<Value>,
  ): Promise<Value> => {
    const environmentId = readEnvironmentId();
    if (!environmentId) throw new Error("This window is not connected to an environment.");
    const api = readEnvironmentApi(environmentId);
    if (!api) throw new Error("This window is not connected to an environment.");
    const scope = await resolveScope(environmentId);
    if (!scope) throw new Error("This session can see no workspace to read packs from.");
    return run({ api, ...scope });
  };

  return {
    async loadPack(request: PackDetailRequest): Promise<PackDetail | null> {
      return withScope(async ({ api, tenantId, workspaceId }) => {
        const [detail, versions] = await Promise.all([
          api.packs.get({
            tenantId,
            workspaceId,
            packId: request.packId as never,
            ...(request.version ? { version: request.version as never } : {}),
          }),
          api.packs.listVersions({ tenantId, workspaceId, packId: request.packId as never }),
        ]);

        // The manifest is the pack; the history is the registry's own record of
        // what it has published, which a manifest cannot know about itself.
        //
        // The registry records when a version was published and nothing about
        // who could see it at the time, so `publications` is left empty rather
        // than invented. An empty one already means "cut and never shown", and
        // saying that wrongly is better than fabricating a visibility history.
        const releases = versions.versions.map((version) => ({
          version: version.version,
          cutAt: version.publishedAt,
          publications: [],
        }));

        const history = {
          packId: detail.pack.packId,
          latestVersion: releases[0]?.version ?? detail.manifest.identity.version,
          releases:
            releases.length > 0
              ? releases
              : [
                  {
                    version: detail.manifest.identity.version,
                    cutAt: detail.manifest.provenance.extractedAt,
                    publications: [],
                  },
                ],
        } as unknown as PackReleaseHistory;

        return { manifest: detail.manifest, history };
      });
    },

    async setVisibility(request: PackVisibilityChangeRequest): Promise<PackVisibility> {
      return withScope(async ({ api, tenantId, workspaceId }) => {
        // The page sends a scope; the RPC wants the whole visibility value. The
        // ids for the narrower scopes are the registry's to fill, so anything
        // beyond the scope name is deliberately not guessed here.
        await api.packs.setVisibility({
          tenantId,
          workspaceId,
          packId: request.packId as never,
          visibility: { scope: request.scope } as never,
        });
        // The reply carries the registry entry rather than the visibility, and
        // the call throws if it did not take, so the scope just asked for is
        // what the pack now has.
        return { scope: request.scope } as PackVisibility;
      });
    },
  };
}
