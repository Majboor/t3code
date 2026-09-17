/**
 * Hand-written seed rows for `promptbar_test_set` (source: "manual"), so the
 * eval harness (`eval.ts` / `scripts/promptbar-eval.ts`) is runnable
 * standalone without waiting on real usage data to sample from.
 *
 * These are deliberately NOT near-duplicates of the phrasings indexed in
 * `packs/*\/promptbar.json` -- e.g. `ssh-deploy`'s indexed phrasing is
 * "deploy this to the server"; the entry below for it is "the client wants
 * this live tonight, can you get it up on the box", a genuinely different
 * way of asking for the same pack. Scoring retrieval against the phrasings
 * it was indexed from would be training on the test set (see the spec this
 * harness implements).
 *
 * The four `correctPackId: null` rows are deliberate: they have no matching
 * pack and exist to exercise the abstention-rate metric (was abstaining the
 * right call here or not).
 */
export interface PromptbarTestSetSeedRow {
  readonly phrasing: string;
  readonly correctPackId: string | null;
}

export const PROMPTBAR_TEST_SET_SEED: ReadonlyArray<PromptbarTestSetSeedRow> = [
  // gmail_apps_script_mail
  { phrasing: "the client is waiting, can you fire off a note to them", correctPackId: "gmail_apps_script_mail" },
  { phrasing: "let ops know the deploy finished, drop them a line", correctPackId: "gmail_apps_script_mail" },
  { phrasing: "can you get a heads-up to the team's inbox about this", correctPackId: "gmail_apps_script_mail" },
  { phrasing: "ijazat mil gayi, unhe inform kar do email pe", correctPackId: "gmail_apps_script_mail" },

  // pdf_delivery
  { phrasing: "can you package this up as something they can print", correctPackId: "pdf_delivery" },
  { phrasing: "give me a downloadable version of this writeup", correctPackId: "pdf_delivery" },
  { phrasing: "put this invoice into a file the client can save", correctPackId: "pdf_delivery" },
  { phrasing: "is there a way to see how far people actually read this doc", correctPackId: "pdf_delivery" },

  // analytics_core
  { phrasing: "I want to know if anyone is even using this feature", correctPackId: "analytics_core" },
  { phrasing: "can we get a number on how many signups came in today", correctPackId: "analytics_core" },
  { phrasing: "set up something so we're not flying blind on usage", correctPackId: "analytics_core" },
  { phrasing: "kitne log is endpoint ko hit kar rahe hain, pata karo", correctPackId: "analytics_core" },

  // ssh_deploy
  { phrasing: "the client wants this live tonight, can you get it up on the box", correctPackId: "ssh_deploy" },
  { phrasing: "take what we have and put it somewhere people can actually reach it", correctPackId: "ssh_deploy" },
  { phrasing: "our remote machine needs this project running on it", correctPackId: "ssh_deploy" },
  { phrasing: "yeh project production server pe chalao", correctPackId: "ssh_deploy" },

  // genuine abstention cases: real composer-shaped requests with no matching pack
  { phrasing: "the api server died again, can you bring it back", correctPackId: null },
  { phrasing: "what's the capital of Australia", correctPackId: null },
  { phrasing: "can you explain what a closure is in javascript", correctPackId: null },
  { phrasing: "yeah that looks good, go ahead", correctPackId: null },
  { phrasing: "remind me what we decided in yesterday's standup", correctPackId: null },
] as const;
