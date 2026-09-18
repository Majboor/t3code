import { BadgeCheckIcon } from "lucide-react";

import { isVerifiedPackId } from "@t3tools/contracts";

import { Badge } from "../ui/badge";

/**
 * The blue tick: this pack shipped with the product rather than having been
 * published by a tenant. `isVerifiedPackId` is the real, existing concept
 * behind it (`apps/server/src/packs/verifiedPacks.ts`), not a new tier
 * invented for this badge — a shipped pack's id is prefixed `verified:` by
 * the registry itself, and this component only reads that prefix back off.
 *
 * Deliberately a different claim from `PackSignatureBadge`, which says the
 * bytes were not tampered with after a specific key signed them. This says
 * "the product bundles and stands behind this one"; that one says nothing
 * about who wrote it. A pack can be one, the other, both, or neither.
 */
export function VerifiedPackBadge({ packId }: { packId: string }) {
  if (!isVerifiedPackId(packId)) {
    return null;
  }

  return (
    <Badge
      variant="info"
      size="sm"
      className="gap-0.5 text-info"
      title="Ships with the product and is maintained by its publisher — not a claim that a tenant's own pack is any less trustworthy."
      data-testid="pack-verified-badge"
    >
      <BadgeCheckIcon className="size-3 fill-info text-info-foreground" />
      Verified
    </Badge>
  );
}
