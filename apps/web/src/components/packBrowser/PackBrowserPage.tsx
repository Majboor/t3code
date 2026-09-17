/**
 * The pack marketplace: every pack this session may see, searchable, with a
 * card per pack that opens onto the existing detail page.
 *
 * There was a per-pack detail page and a composer-time suggestion strip
 * already, but nothing to browse from — the only way to find a pack you did
 * not already know the name of was to type something the suggestion matcher
 * happened to score. This is the page that answers "what packs are there".
 *
 * Scope is resolved the same way the pack detail page resolves it: the first
 * workspace this session can see. A route that opened from a project would
 * know which workspace to ask; one reached from a sidebar link does not, and
 * guessing the first workspace is the same limitation the detail page already
 * lives with rather than a new one invented here.
 */
import { CompassIcon, PackageSearchIcon, SearchIcon } from "lucide-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";

import type { PackRegistryEntry } from "@t3tools/contracts";

import {
  PACK_BROWSE_SEARCH_LIMIT,
  PACK_SEARCH_DEBOUNCE_MS,
  describePackResultCount,
  normalizePackSearchQuery,
  sortPackResultsByName,
  splitPackCardTags,
} from "./packBrowser.logic";
import { PACK_VISIBILITY_DESCRIPTIONS } from "../packDashboard/packDetail.logic";
import { readEnvironmentApi } from "../../environmentApi";
import { usePrimaryEnvironmentId } from "../../environments/primary/context";
import { Badge } from "../ui/badge";
import { Card, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { WorkspaceSubPage } from "../WorkspaceSubPage";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <WorkspaceSubPage title="Packs" contentClassName="gap-4 py-4 sm:py-6">
      {children}
    </WorkspaceSubPage>
  );
}

function PackCard({ pack }: { pack: PackRegistryEntry }) {
  const { visible, overflow } = splitPackCardTags(pack.tags);
  const visibility = PACK_VISIBILITY_DESCRIPTIONS[pack.visibility.scope];

  return (
    <Link
      to="/pack/$packId"
      params={{ packId: pack.packId }}
      className="block focus-visible:outline-none"
      data-testid="pack-browser-card-link"
    >
      <Card
        className="h-full p-4 transition-colors hover:border-ring/60 hover:bg-accent/40"
        render={<article />}
        data-testid="pack-browser-card"
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <CardTitle className="text-sm">{pack.displayName}</CardTitle>
          <span className="font-mono text-[11px] text-muted-foreground">
            {pack.publisherHandle}/{pack.name}@{pack.latestVersion}
          </span>
        </div>

        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-foreground">{pack.summary}</p>

        <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">
          {pack.capabilitySummary}
        </p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <Badge size="sm" variant="outline">
            {visibility.label}
          </Badge>
          {visible.map((tag) => (
            <Badge key={tag} size="sm" variant="secondary">
              {tag}
            </Badge>
          ))}
          {overflow > 0 ? (
            <Badge size="sm" variant="outline">
              +{overflow}
            </Badge>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}

function EmptyState({ query }: { query: string | undefined }) {
  return (
    <Card className="p-6 text-center" render={<section />} data-testid="pack-browser-empty">
      <PackageSearchIcon className="mx-auto size-6 text-muted-foreground" />
      <CardTitle className="mt-2 text-base">
        {query === undefined ? "No packs here yet" : "Nothing matches that"}
      </CardTitle>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
        {query === undefined
          ? "Publish a project as a pack, or wait for one to be shared with this workspace."
          : "Try a different word, or clear the search to see everything this workspace can reach."}
      </p>
    </Card>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Card className="p-6 text-center" render={<section />} data-testid="pack-browser-error">
      <CardTitle className="text-base">Could not load packs</CardTitle>
      <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{message}</p>
    </Card>
  );
}

export function PackBrowserPage() {
  const environmentId = usePrimaryEnvironmentId();
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(rawQuery, { wait: PACK_SEARCH_DEBOUNCE_MS });
  const query = normalizePackSearchQuery(debouncedQuery);

  const scope = useQuery({
    enabled: environmentId !== null,
    queryKey: ["packBrowser", "scope", environmentId],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api) throw new Error("This window is not connected to an environment.");
      const snapshot = await api.organizations.list();
      const workspace = (snapshot.workspaces ?? [])[0];
      if (!workspace) throw new Error("This session can see no workspace to read packs from.");
      return { tenantId: workspace.tenantId, workspaceId: workspace.id };
    },
  });

  const results = useQuery({
    enabled: scope.data !== undefined && environmentId !== null,
    queryKey: ["packBrowser", "search", environmentId, scope.data, query],
    queryFn: async () => {
      const api = environmentId === null ? undefined : readEnvironmentApi(environmentId);
      if (!api || !scope.data) throw new Error("This window is not connected to an environment.");
      return api.packs.search({
        tenantId: scope.data.tenantId,
        workspaceId: scope.data.workspaceId,
        limit: PACK_BROWSE_SEARCH_LIMIT,
        ...(query === undefined ? {} : { query }),
      });
    },
  });

  const packs = useMemo(
    () => (results.data ? sortPackResultsByName(results.data.packs) : []),
    [results.data],
  );

  const failure = scope.error ?? results.error;

  return (
    <Shell>
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-1.5 text-sm font-medium text-foreground">
          <CompassIcon className="size-4 text-muted-foreground" />
          Browse packs
        </div>
        <p className="text-xs text-muted-foreground">
          Everything this workspace can see in the registry — its own packs, and anything shared
          more widely than that.
        </p>
      </div>

      <label className="relative block">
        <span className="sr-only">Search packs</span>
        <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
        <Input
          type="search"
          value={rawQuery}
          onChange={(event) => setRawQuery(event.currentTarget.value)}
          placeholder="Search by name, tag, or what it does…"
          className="pl-8"
          data-testid="pack-browser-search-input"
        />
      </label>

      {failure ? (
        <ErrorState
          message={failure instanceof Error ? failure.message : "Something went wrong."}
        />
      ) : scope.isPending || (results.isPending && results.fetchStatus !== "idle") ? (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground"
          data-testid="pack-browser-loading"
        >
          <Spinner className="size-4" />
          Loading packs…
        </div>
      ) : (
        <>
          <p className="text-xs text-muted-foreground" data-testid="pack-browser-count">
            {describePackResultCount(packs.length, query)}
          </p>

          {packs.length === 0 ? (
            <EmptyState query={query} />
          ) : (
            <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
              {packs.map((pack) => (
                <PackCard key={pack.packId} pack={pack} />
              ))}
            </div>
          )}
        </>
      )}
    </Shell>
  );
}
