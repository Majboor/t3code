import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export interface OpenProjectInBrowserOutcome {
  readonly copied: boolean;
}

/**
 * The address a browser needs is the app's own HTTP base URL, not a guess: the
 * desktop app starts its server on whatever port was free, so anything
 * hand-built from `localhost` is wrong the first time that port moves.
 */
export function buildProjectBrowserUrl(input: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  resolveHttpUrl: (pathname: string) => string;
}): string {
  const pathname = `/project/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(
    input.projectId,
  )}`;
  return input.resolveHttpUrl(pathname);
}

/**
 * Copy before opening: handing focus to the browser first is enough to make a
 * clipboard write fail. A failed copy still opens, because the browser is the
 * part the user asked for and the toast can own the difference.
 */
export async function copyLinkAndOpen(input: {
  url: string;
  copyToClipboard: (text: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
}): Promise<OpenProjectInBrowserOutcome> {
  let copied = false;
  try {
    copied = await input.copyToClipboard(input.url);
  } catch {
    copied = false;
  }

  await input.openExternal(input.url);
  return { copied };
}
