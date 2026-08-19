/**
 * The pack page links `t3 pack search` and `t3 pack show` print.
 *
 * A link is only worth printing if following it lands on the pack. That had
 * stopped being true: the CLI printed the id the registry serves a pack under
 * — a manifest id, or the `pack:<publisher>/<name>` a contested one falls back
 * to — while the server opens a pack that shipped with the product under
 * `verified:<name>`. Every link the CLI printed on a stock install therefore
 * 404'd, all four shipped packs included, which reads as the pack pages being
 * broken rather than as the address being wrong.
 *
 * Teaching the server the other ids would have been the wider fix and the
 * wrong one: a pack answering to two addresses is a pack with two
 * `pack_enablements` rows, and a workspace that turned it on under one id and
 * sees it off under the other. So the address is corrected on the side that
 * prints it, and this module is the only place that decides one.
 *
 * `t3 pack` reads a directory registry and nothing else — there is no path
 * through it to a pack somebody published to a server — so every pack it can
 * name is a shipped pack, and `verified:<name>` is the address for all of
 * them. A manifest id would still be right for a pack held in the server's own
 * registry; nothing here can return one because nothing here can see one.
 *
 * @module packs/packLinks
 */
import { packPageUrl, type WorkspaceOrigin } from "../deploy/cliOutput.ts";

import { shippedPackAddresses, VERIFIED_PACK_ID_PREFIX } from "./verifiedPacks.ts";

/** One pack as the registry handed it over: its name, and the id it serves it under. */
export interface PackLinkTarget {
  readonly name: string;
  /** `PackRecord.ref.id` — the registry's own answer, not the manifest's. */
  readonly id: string;
  /**
   * `publisher/name@version`, as the result above it is headed. Only needed
   * when there is no link to print: two packs can share a name, and "no page"
   * against a bare name leaves a reader unable to tell which of the two lines
   * above it is talking about.
   */
  readonly qualified: string;
}

/**
 * The link block printed under a pack result, blank line included.
 *
 * A pack with no page gets a line saying so rather than no line at all. The
 * silent version is how the CLI's output goes back to being trusted for the
 * packs it does link and quietly incomplete for the ones it does not, and the
 * reader has no way to tell which they are looking at.
 */
export async function packPageLinks(input: {
  readonly packs: ReadonlyArray<PackLinkTarget>;
  /** The registry the results were read out of, already resolved to a path. */
  readonly registryRoot: string;
  readonly workspace: WorkspaceOrigin;
}): Promise<ReadonlyArray<string>> {
  if (input.packs.length === 0) {
    return [];
  }

  const addressing = await shippedPackAddresses(input.registryRoot);
  if (!addressing.serves) {
    // No per-pack lines: not one of them has a page, and the reason is the
    // same for all of them and has nothing to do with any pack.
    return [
      "",
      addressing.servedRoot === undefined
        ? `No pack pages: this workspace serves no packs of its own, so nothing here opens on the web.`
        : `No pack pages for ${input.registryRoot}: this workspace opens packs from ${addressing.servedRoot}.`,
    ];
  }

  const taken = new Set(addressing.addresses.values());
  return [
    "",
    ...input.packs.map((pack) => {
      const address = addressing.addresses.get(pack.id);
      if (address !== undefined) {
        return `${pack.name}: ${packPageUrl(input.workspace, address)}`;
      }
      // Two packs sharing a name land on one `verified:` id, and the workspace
      // offers whichever the registry sorted first. Saying which of the two
      // this is, and that something else holds the address, is what makes the
      // missing link followable — the loser is not broken, it is shadowed.
      const wanted = `${VERIFIED_PACK_ID_PREFIX}${pack.name}`;
      return taken.has(wanted)
        ? `${pack.name}: no page — ${pack.qualified} is shadowed by another pack in ${input.registryRoot}, which is served as ${wanted}.`
        : `${pack.name}: no page — this workspace does not serve ${pack.qualified} as ${wanted}.`;
    }),
  ];
}
