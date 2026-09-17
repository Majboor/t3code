/**
 * Best-effort "which registrar is this domain on" detection, from a plain NS
 * lookup — no WHOIS dependency, no API key, just DNS. Read before a domain's
 * zone is created in Cloudflare, because that is the only moment the domain's
 * *current* nameservers (the ones that name its registrar) are still live;
 * once the user has switched nameservers to Cloudflare's, this signal is gone.
 *
 * A miss (unknown pattern, or the lookup fails outright — an unregistered
 * domain, a typo, a registrar mid-migration) returns `null` rather than
 * throwing: this hint only ever makes the follow-up instructions friendlier,
 * it is never on the critical path of connecting the domain.
 */
import { resolveNs } from "node:dns/promises";

/**
 * Nameserver hostname substrings mapped to the registrar/DNS provider that
 * issues them. Ordered by how distinctive the substring is, not by market
 * share — a short, common substring earlier in the list would shadow a more
 * specific one later.
 */
const NAMESERVER_PATTERNS: ReadonlyArray<{ readonly pattern: string; readonly registrar: string }> = [
  { pattern: "domaincontrol.com", registrar: "GoDaddy" },
  { pattern: "registrar-servers.com", registrar: "Namecheap" },
  { pattern: "googledomains.com", registrar: "Google Domains" },
  { pattern: "google.com", registrar: "Google Domains" },
  { pattern: "dns.squarespace.com", registrar: "Squarespace Domains" },
  { pattern: "name-services.com", registrar: "Network Solutions" },
  { pattern: "dynadot.com", registrar: "Dynadot" },
  { pattern: "porkbun.com", registrar: "Porkbun" },
  { pattern: "hover.com", registrar: "Hover" },
  { pattern: "gandi.net", registrar: "Gandi" },
  { pattern: "ovh.net", registrar: "OVH" },
  { pattern: "cloudflare.com", registrar: "Cloudflare (already there)" },
  { pattern: "awsdns", registrar: "Amazon Route 53" },
  { pattern: "azure-dns", registrar: "Azure DNS" },
  { pattern: "digitalocean.com", registrar: "DigitalOcean" },
];

export interface RegistrarHintResult {
  readonly registrar: string | null;
  /** The nameservers actually observed, for a caller that wants to show them. */
  readonly currentNameServers: ReadonlyArray<string>;
}

export async function detectRegistrarHint(domain: string): Promise<RegistrarHintResult> {
  let currentNameServers: ReadonlyArray<string> = [];
  try {
    currentNameServers = await resolveNs(domain);
  } catch {
    // Unregistered, a typo, or a resolver hiccup — an honest "we don't know",
    // not a reason to fail the domain-connect request that asked for this.
    return { registrar: null, currentNameServers: [] };
  }

  for (const ns of currentNameServers) {
    const lowerNs = ns.toLowerCase();
    for (const { pattern, registrar } of NAMESERVER_PATTERNS) {
      if (lowerNs.includes(pattern)) {
        return { registrar, currentNameServers };
      }
    }
  }
  return { registrar: null, currentNameServers };
}
