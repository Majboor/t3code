/**
 * Deciding, from what somebody is typing, whether a pack is worth mentioning.
 *
 * The agent already looks packs up for itself, and mostly does — but "mostly"
 * is the problem: across nine measured runs it searched every time only after
 * the instruction was sharpened, and it still sometimes read a pack and went
 * ahead anyway. A suggestion above the prompt bar does not replace that. It
 * makes the same knowledge visible to the person before they hit send, which
 * is the one moment they can cheaply say "yes, use that" or ignore it.
 *
 * Matching is deliberately boring. An intent that fires on a word nobody
 * typed is worse than no suggestion at all, because it teaches people to stop
 * reading the bar. So: whole words only, drawn from what the pack itself
 * declares, with a threshold that keeps a passing mention from triggering.
 */

/** What a suggestion needs to know about a pack, and nothing more. */
export interface SuggestablePack {
  readonly id: string;
  readonly name: string;
  readonly qualified: string;
  readonly summary: string;
  /** Capability words the pack declares — "deploy", "email", "analytics". */
  readonly capabilities: ReadonlyArray<string>;
}

export interface PackSuggestion {
  readonly pack: SuggestablePack;
  readonly score: number;
  /** The words in the prompt that matched, for showing why it appeared. */
  readonly matched: ReadonlyArray<string>;
}

/**
 * Words that mean "I am about to do the kind of thing packs exist for".
 *
 * Kept here rather than in a pack because it is about English, not about any
 * one pack: a pack declaring the capability "deploy" should still be found by
 * somebody who wrote "ship" or "put it live".
 */
const INTENT_SYNONYMS: Readonly<Record<string, ReadonlyArray<string>>> = {
  deploy: ["deploy", "deployment", "ship", "publish", "host", "hosting", "live", "server", "vps"],
  analytics: ["analytics", "metrics", "tracking", "events", "chart", "charts", "dashboard"],
  email: ["email", "mail", "smtp", "inbox", "send"],
  document: ["pdf", "document", "report", "handout", "slides"],
};

/** Anything shorter is noise: "a", "to", "it" match everything. */
const MIN_WORD_LENGTH = 3;

/**
 * A single synonym is not enough, which a test caught: "the shipment tracking
 * number is wrong" matched the analytics pack, because "tracking" is a synonym
 * for it and one synonym cleared the old threshold. Three means a pack has to
 * be named outright, declare the capability, or be reached by two words at
 * once — an accident has to happen twice.
 */
const MIN_SCORE = 3;

export function tokenize(prompt: string): ReadonlyArray<string> {
  return prompt
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= MIN_WORD_LENGTH);
}

/**
 * Scores one pack against the words somebody typed.
 *
 * A capability the pack declares is worth more than a synonym, because the
 * pack said it about itself. Summary words count least — they are prose, and
 * prose shares words with everything.
 */
export function scorePack(
  pack: SuggestablePack,
  words: ReadonlySet<string>,
): { score: number; matched: ReadonlyArray<string> } {
  const matched = new Set<string>();
  let score = 0;

  for (const capability of pack.capabilities) {
    const term = capability.toLowerCase();
    if (words.has(term)) {
      score += 3;
      matched.add(term);
    }
    for (const synonym of INTENT_SYNONYMS[term] ?? []) {
      if (words.has(synonym)) {
        score += 2;
        matched.add(synonym);
      }
    }
  }

  // The pack's own name, when somebody types it, is as explicit as it gets.
  for (const part of tokenize(pack.name)) {
    if (words.has(part)) {
      score += 3;
      matched.add(part);
    }
  }

  for (const word of tokenize(pack.summary)) {
    if (words.has(word)) {
      score += 1;
      matched.add(word);
    }
  }

  return { score, matched: [...matched] };
}

/**
 * The packs worth putting above the prompt bar, best first.
 *
 * Returns nothing rather than a weak guess when nothing clears the threshold:
 * a bar that always shows something is a bar people stop looking at.
 */
export function suggestPacks(
  prompt: string,
  packs: ReadonlyArray<SuggestablePack>,
  options: { readonly limit?: number; readonly minScore?: number } = {},
): ReadonlyArray<PackSuggestion> {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return [];
  }

  const words = new Set(tokenize(trimmed));
  const minScore = options.minScore ?? MIN_SCORE;

  const scored: PackSuggestion[] = [];
  for (const pack of packs) {
    const { score, matched } = scorePack(pack, words);
    if (score >= minScore) {
      scored.push({ pack, score, matched });
    }
  }

  return scored
    .toSorted((left, right) =>
      right.score === left.score
        ? left.pack.name.localeCompare(right.pack.name)
        : right.score - left.score,
    )
    .slice(0, options.limit ?? 3);
}

/**
 * The line added to the prompt when somebody picks a suggestion.
 *
 * Names the pack and tells the agent to read it, rather than pasting the
 * pack's contents in. The person is pointing, not quoting — and a pasted copy
 * would be stale the moment the pack changed.
 */
export function promptMentionFor(pack: SuggestablePack): string {
  return `Use the ${pack.qualified} pack for this — run \`t3 pack show ${pack.name}\` and follow its failure modes and integration notes.`;
}

/** Appends the mention, leaving what somebody already wrote untouched. */
export function withPackMention(prompt: string, pack: SuggestablePack): string {
  const mention = promptMentionFor(pack);
  if (prompt.includes(mention)) {
    return prompt;
  }
  const trimmed = prompt.trimEnd();
  return trimmed.length === 0 ? mention : `${trimmed}\n\n${mention}`;
}
