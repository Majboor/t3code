/**
 * The machines enrolled to this account, as the portal sees them.
 *
 * Read from `GET /api/environments/relay/links` on the portal: one row per
 * environment a machine has claimed by dialling in, with the live state of that
 * link. A row whose machine is closed is reported `offline` rather than left
 * out, so a person can see the laptop they enrolled yesterday and know why it is
 * not answering today.
 *
 * @module Environments
 */
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";

export const RELAY_LINKS_PATH = "/api/environments/relay/links";

export type RelayLinkState = "offline" | "connecting" | "connected" | "unhealthy" | "revoked";

export interface RelayLink {
  readonly environmentId: string;
  readonly label: string;
  readonly machineId: string;
  readonly firstBoundAt: string | null;
  readonly lastConnectedAt: string | null;
  readonly state: RelayLinkState;
  readonly detail: string | null;
}

const STATES: ReadonlySet<string> = new Set([
  "offline",
  "connecting",
  "connected",
  "unhealthy",
  "revoked",
]);

export function parseRelayLinks(value: unknown): ReadonlyArray<RelayLink> {
  if (typeof value !== "object" || value === null) return [];
  const rows = (value as { environments?: unknown }).environments;
  if (!Array.isArray(rows)) return [];
  const links: RelayLink[] = [];
  for (const row of rows) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    if (typeof record["environmentId"] !== "string" || typeof record["machineId"] !== "string")
      continue;
    const state =
      typeof record["state"] === "string" && STATES.has(record["state"])
        ? record["state"]
        : "offline";
    links.push({
      environmentId: record["environmentId"],
      label:
        typeof record["label"] === "string" && record["label"].length > 0
          ? record["label"]
          : record["environmentId"],
      machineId: record["machineId"],
      firstBoundAt: typeof record["firstBoundAt"] === "string" ? record["firstBoundAt"] : null,
      lastConnectedAt:
        typeof record["lastConnectedAt"] === "string" ? record["lastConnectedAt"] : null,
      state: state as RelayLinkState,
      detail: typeof record["detail"] === "string" ? record["detail"] : null,
    });
  }
  return links;
}

/** Signed out, or a portal without the relay, reads as "no machines" rather than an error. */
export async function fetchRelayLinks(): Promise<ReadonlyArray<RelayLink>> {
  const response = await fetch(resolvePrimaryEnvironmentHttpUrl(RELAY_LINKS_PATH), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) return [];
  return parseRelayLinks(await response.json().catch(() => null));
}

export function describeRelayLinkState(state: RelayLinkState): {
  readonly label: string;
  readonly tone: "good" | "warn" | "muted";
} {
  switch (state) {
    case "connected":
      return { label: "Online", tone: "good" };
    case "connecting":
      return { label: "Connecting", tone: "warn" };
    case "unhealthy":
      return { label: "Not responding", tone: "warn" };
    case "revoked":
      return { label: "Revoked", tone: "muted" };
    default:
      return { label: "Offline — open the app on that machine", tone: "muted" };
  }
}
