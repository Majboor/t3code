/**
 * "Browse all packs", opened from the pack-mode popover's expand affordance.
 *
 * The popover is a quick settings surface anchored to a composer button; this
 * is the room to actually look around in — a real search box, the same
 * filters as the actual production signals, and a whole grid instead of one
 * suggested card. It stays a `Dialog` layered on top of the still-open
 * popover rather than a navigation to the standalone `/packs` page, because
 * the point is to keep the composer and the draft in front of someone while
 * they look: see `ShareProjectButton.tsx` for the same "small popover stays
 * open, a `Dialog`-family popup opens on top of it and dims it via its own
 * backdrop" pattern already used elsewhere in this codebase.
 */
import { useDebouncedValue } from "@tanstack/react-pacer";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CompassIcon, PackageSearchIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Badge } from "../ui/badge";
import { Card, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";

import { packDirectory } from "./packDirectory";
import { PackFilterOptionRow } from "./PackFilterOptionRow";
import {
  PACK_DEPLOYMENT_OPTIONS,
  PACK_SCOPE_OPTIONS,
  PACK_TIME_IN_SERVICE_OPTIONS,
  formatPackSignals,
  type Pack,
  type PackModeSettings,
} from "./packMode.logic";
import {
  PACK_BROWSE_MODAL_DEBOUNCE_MS,
  PACK_BROWSE_MODAL_LIMIT,
  describeBrowseResultCount,
  filterPacksForBrowse,
  sortPacksForBrowse,
} from "./packBrowseModal.logic";
import { VerifiedPackBadge } from "./VerifiedPackBadge";

function PackGridCard({ pack }: { pack: Pack }) {
  return (
    <Link
      to="/pack/$packId"
      params={{ packId: pack.id }}
      className="block focus-visible:outline-none"
      data-testid="pack-browse-modal-card-link"
    >
      <Card
        className="h-full p-4 transition-colors hover:border-ring/60 hover:bg-accent/40"
        render={<article />}
        data-testid="pack-browse-modal-card"
        data-pack-id={pack.id}
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <CardTitle className="text-sm">{pack.name}</CardTitle>
          <span className="font-mono text-[11px] text-muted-foreground">{pack.version}</span>
        </div>

        <p className="mt-1.5 line-clamp-2 text-xs leading-5 text-foreground">{pack.summary}</p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1">
          <VerifiedPackBadge packId={pack.id} />
          <Badge size="sm" variant="outline">
            {pack.scope === "workspace" ? "This workspace" : "Everywhere"}
          </Badge>
        </div>

        <p className="mt-2 border-t border-border pt-2 text-[11px] leading-4 text-muted-foreground">
          {formatPackSignals(pack.signals)}
        </p>
      </Card>
    </Link>
  );
}

export function PackBrowseModal({
  open,
  onOpenChange,
  settings,
  onSettingsChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: PackModeSettings;
  readonly onSettingsChange: (update: (previous: PackModeSettings) => PackModeSettings) => void;
}) {
  const [rawQuery, setRawQuery] = useState("");
  const [debouncedQuery] = useDebouncedValue(rawQuery, { wait: PACK_BROWSE_MODAL_DEBOUNCE_MS });
  const { scope, requirements } = settings;

  const candidates = useQuery({
    enabled: open,
    queryKey: ["packBrowseModal", debouncedQuery],
    queryFn: () => packDirectory.browsePacks({ query: debouncedQuery, limit: PACK_BROWSE_MODAL_LIMIT }),
  });

  const packs = useMemo(() => {
    const found = candidates.data ?? [];
    return sortPacksForBrowse(filterPacksForBrowse(found, scope, requirements));
  }, [candidates.data, scope, requirements]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-4xl w-[min(64rem,calc(100vw-2rem))]" data-testid="pack-browse-modal">
        <DialogHeader>
          <div className="flex items-center gap-1.5">
            <CompassIcon className="size-4 text-muted-foreground" aria-hidden />
            <DialogTitle>Browse packs</DialogTitle>
          </div>
          <DialogDescription>
            Everything the workspace can see in the registry, filtered by the same production
            signals pack mode suggests from.
          </DialogDescription>
        </DialogHeader>

        <DialogPanel className="grid gap-4">
          <label className="relative block">
            <span className="sr-only">Search packs</span>
            <SearchIcon className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground/60" />
            <Input
              type="search"
              autoFocus
              value={rawQuery}
              onChange={(event) => setRawQuery(event.currentTarget.value)}
              placeholder="Search by name, tag, or what it does…"
              className="pl-8"
              data-testid="pack-browse-modal-search-input"
            />
          </label>

          <div className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-3">
            <PackFilterOptionRow
              label="Where to look"
              options={PACK_SCOPE_OPTIONS}
              value={scope}
              testId="pack-browse-modal-scope"
              onChange={(next) => {
                onSettingsChange((previous) => ({ ...previous, scope: next }));
              }}
            />

            <PackFilterOptionRow
              label="Minimum deployments"
              options={PACK_DEPLOYMENT_OPTIONS}
              value={requirements.minDeployments}
              testId="pack-browse-modal-min-deployments"
              onChange={(next) => {
                onSettingsChange((previous) => ({
                  ...previous,
                  requirements: { ...previous.requirements, minDeployments: next },
                }));
              }}
            />

            <PackFilterOptionRow
              label="Minimum time in service"
              options={PACK_TIME_IN_SERVICE_OPTIONS}
              value={requirements.minMonthsInService}
              testId="pack-browse-modal-min-time-in-service"
              onChange={(next) => {
                onSettingsChange((previous) => ({
                  ...previous,
                  requirements: { ...previous.requirements, minMonthsInService: next },
                }));
              }}
            />

            <div className="flex items-center justify-between gap-2 sm:col-span-3">
              <div className="min-w-0 text-[11px] leading-4 text-muted-foreground">
                Include packs nobody outside the author has run
              </div>
              <Switch
                checked={requirements.includeAuthorOnly}
                aria-label="Include packs nobody outside the author has run"
                data-testid="pack-browse-modal-author-only-switch"
                onCheckedChange={(checked) => {
                  onSettingsChange((previous) => ({
                    ...previous,
                    requirements: { ...previous.requirements, includeAuthorOnly: checked },
                  }));
                }}
              />
            </div>
          </div>

          {candidates.error ? (
            <Card className="p-6 text-center" render={<section />} data-testid="pack-browse-modal-error">
              <CardTitle className="text-base">Could not load packs</CardTitle>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                {candidates.error instanceof Error ? candidates.error.message : "Something went wrong."}
              </p>
            </Card>
          ) : candidates.isPending ? (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              data-testid="pack-browse-modal-loading"
            >
              <Spinner className="size-4" />
              Loading packs…
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground" data-testid="pack-browse-modal-count">
                {describeBrowseResultCount(packs.length, debouncedQuery)}
              </p>

              {packs.length === 0 ? (
                <Card className="p-6 text-center" render={<section />} data-testid="pack-browse-modal-empty">
                  <PackageSearchIcon className="mx-auto size-6 text-muted-foreground" />
                  <CardTitle className="mt-2 text-base">Nothing matches that</CardTitle>
                  <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                    Try a different word, loosen a filter, or widen "Where to look" to everywhere.
                  </p>
                </Card>
              ) : (
                <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                  {packs.map((pack) => (
                    <PackGridCard key={pack.id} pack={pack} />
                  ))}
                </div>
              )}
            </>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
