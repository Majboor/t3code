import { BadgeCheckIcon, ShieldAlertIcon, ShieldOffIcon } from "lucide-react";
import { useEffect, useState } from "react";

import type { PackManifest } from "@t3tools/contracts";
import { verifyManifest } from "@t3tools/shared/packSigning";

/**
 * What a signature does and does not say, in the words the badge uses.
 *
 * The temptation with a green tick is to let people read it as "this pack is
 * good". It is not that and cannot be: it says the release has not been altered
 * since the key named in it signed, which is a statement about tampering and
 * nothing else. The wording here is deliberately about the bytes.
 */
export async function describeSignature(manifest: PackManifest): Promise<{
  readonly tone: "valid" | "unsigned" | "invalid";
  readonly title: string;
  readonly detail: string;
}> {
  const result = await verifyManifest(manifest as unknown as Record<string, unknown>);

  if (result.state === "valid") {
    const key = result.keyId.slice(0, 12);
    return {
      tone: "valid",
      title: "Signature checks out",
      detail: `Unchanged since key ${key} signed it${result.signedAt ? ` on ${result.signedAt.slice(0, 10)}` : ""}. That is a statement about tampering, not about whether the pack is any good.`,
    };
  }

  if (result.state === "unsigned") {
    return {
      tone: "unsigned",
      title: "Not signed",
      detail:
        "Nothing here proves this release came from the publisher it names, or that it has not been edited since. Sign it with `t3-pack sign`.",
    };
  }

  return {
    tone: "invalid",
    title: "Signature does not check out",
    detail: `${result.why}. Treat everything this pack claims as unverified until that is explained.`,
  };
}

const TONE_STYLES = {
  valid: "border-emerald-500/40 bg-emerald-500/5",
  unsigned: "border-border bg-background",
  invalid: "border-destructive/50 bg-destructive/5",
} as const;

export function PackSignatureBadge({ manifest }: { manifest: PackManifest }) {
  // Verification is asynchronous because it runs on WebCrypto, which is what
  // lets this work in a browser at all.
  const [described, setDescribed] = useState<Awaited<ReturnType<typeof describeSignature>> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    void describeSignature(manifest).then((result) => {
      if (!cancelled) setDescribed(result);
    });
    return () => {
      cancelled = true;
    };
  }, [manifest]);

  if (!described) {
    return (
      <section
        className="rounded-lg border border-border p-4"
        data-testid="pack-detail-signature"
        data-state="checking"
      >
        <div className="text-xs text-muted-foreground">Checking the signature…</div>
      </section>
    );
  }

  const Icon =
    described.tone === "valid"
      ? BadgeCheckIcon
      : described.tone === "invalid"
        ? ShieldAlertIcon
        : ShieldOffIcon;

  return (
    <section
      className={`rounded-lg border p-4 ${TONE_STYLES[described.tone]}`}
      data-testid="pack-detail-signature"
      data-state={described.tone}
    >
      <div className="flex items-start gap-2">
        <Icon
          className={`mt-0.5 size-4 shrink-0 ${
            described.tone === "valid"
              ? "text-emerald-500"
              : described.tone === "invalid"
                ? "text-destructive"
                : "text-muted-foreground"
          }`}
        />
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{described.title}</div>
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground">{described.detail}</p>
        </div>
      </div>
    </section>
  );
}
