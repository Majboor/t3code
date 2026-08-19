import type { PackKnowledge, PackRelease } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import {
  PACK_VISIBILITY_DESCRIPTIONS,
  describePublication,
  describeReleaseLearning,
  describeReleaseSignals,
} from "./packDetail.logic";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Card, CardTitle } from "../ui/card";

/**
 * Releases read as what each one learned and what each one has survived, both
 * taken from the format rather than from a note. The learning is counted
 * against the manifest in front of the reader, so a release newer than the one
 * being read shows nothing rather than borrowing knowledge it had not been
 * taught yet.
 */
export function PackReleaseHistory({
  packId,
  releases,
  latestVersion,
  currentVersion,
  knowledge,
}: {
  packId: string;
  releases: readonly PackRelease[];
  latestVersion: string;
  currentVersion: string;
  knowledge: PackKnowledge;
}) {
  return (
    <Card className="p-4" render={<section />} data-testid="pack-detail-releases">
      <CardTitle className="text-sm">Releases</CardTitle>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">
        Each release is a promise about behaviour, so what matters about one is what it had learned
        by then and what it has since survived on its own. Open an older release to read it as it
        stood.
      </p>

      <div className="mt-3 grid">
        {releases.map((release) => {
          const isCurrent = release.version === currentVersion;
          const publication = describePublication(release);
          const learning = describeReleaseLearning(knowledge, release.version);

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
              data-scope={publication.scope ?? "unpublished"}
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-xs text-foreground">{release.version}</span>
                  {publication.scope === null ? (
                    <Badge size="sm" variant="outline">
                      Never published
                    </Badge>
                  ) : (
                    <Badge size="sm" variant="outline">
                      {PACK_VISIBILITY_DESCRIPTIONS[publication.scope].label}
                    </Badge>
                  )}
                  {release.version === latestVersion ? (
                    <Badge size="sm" variant="outline">
                      Newest
                    </Badge>
                  ) : null}
                  {isCurrent ? (
                    <Badge size="sm" variant="secondary">
                      You are reading this one
                    </Badge>
                  ) : null}
                </div>

                <div
                  className="mt-0.5 text-[11px] leading-4 text-muted-foreground"
                  data-testid="pack-detail-release-published"
                >
                  {publication.line}
                  {publication.narrowed === null ? "" : ` ${publication.narrowed}`}
                </div>

                {learning === null ? null : (
                  <div
                    className="mt-0.5 text-xs leading-5 text-muted-foreground"
                    data-testid="pack-detail-release-knowledge"
                  >
                    {learning}
                  </div>
                )}

                {release.signals === undefined ? null : (
                  <div
                    className="mt-0.5 text-[11px] leading-4 text-muted-foreground"
                    data-testid="pack-detail-release-signals"
                  >
                    {describeReleaseSignals(release.signals)}
                  </div>
                )}
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
    </Card>
  );
}
