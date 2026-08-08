import type { PackKnowledge } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import type { PackRelease } from "./packDetailSource";
import {
  PACK_VISIBILITY_DESCRIPTIONS,
  countKnowledgeIntroducedIn,
  formatObservedDate,
  pluralize,
} from "./packDetail.logic";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

/**
 * Releases read as what each one learned, because a version here is a promise
 * about behaviour rather than a diff. The count is taken from the manifest in
 * front of the reader, so a release newer than the one being read shows nothing
 * rather than borrowing knowledge it had not been taught yet.
 */
export function PackReleaseHistory({
  packId,
  releases,
  currentVersion,
  knowledge,
}: {
  packId: string;
  releases: readonly PackRelease[];
  currentVersion: string;
  knowledge: PackKnowledge;
}) {
  return (
    <section className="rounded-lg border border-border p-4" data-testid="pack-detail-releases">
      <h2 className="text-sm font-medium text-foreground">Releases</h2>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Each release is a promise about behaviour, so what matters about one is what it had learned
        by then. Open an older release to read it as it stood.
      </p>

      <div className="mt-3 grid">
        {releases.map((release) => {
          const isCurrent = release.version === currentVersion;
          const introduced = countKnowledgeIntroducedIn(knowledge, release.version);

          return (
            <div
              key={release.version}
              className={cn(
                "flex flex-wrap items-start gap-2 border-t border-border py-2.5 first:border-t-0 first:pt-0",
                isCurrent && "bg-muted/30",
              )}
              data-testid="pack-detail-release"
              data-version={release.version}
              data-current={isCurrent}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-foreground">{release.version}</span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatObservedDate(release.publishedAt)}
                  </span>
                  <Badge size="sm" variant="outline">
                    {PACK_VISIBILITY_DESCRIPTIONS[release.visibilityScope].label}
                  </Badge>
                  {isCurrent ? (
                    <Badge size="sm" variant="secondary">
                      You are reading this one
                    </Badge>
                  ) : null}
                </div>
                <div className="mt-0.5 text-xs leading-5 text-muted-foreground">{release.note}</div>
                {introduced > 0 ? (
                  <div
                    className="mt-0.5 text-[11px] leading-4 text-muted-foreground"
                    data-testid="pack-detail-release-knowledge"
                  >
                    Brought {pluralize(introduced, "piece")} of knowledge with it.
                  </div>
                ) : null}
              </div>

              {isCurrent ? null : (
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="pack-detail-release-open"
                  render={
                    <Link
                      params={{ packId }}
                      search={{ version: release.version }}
                      to="/pack/$packId"
                    />
                  }
                >
                  Read {release.version}
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
