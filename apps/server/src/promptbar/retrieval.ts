/**
 * Pure retrieval-fusion helpers for Promptbar's hybrid search: turning a BM25
 * hit list and a dense hit list (each already ranked, each possibly
 * containing the same pack more than once via different phrasings) into a
 * single Reciprocal-Rank-Fused ranking over packs.
 *
 * Kept dependency-free (no SqlClient, no fetch) so the fusion math itself is
 * unit-testable without a database or the live classifier/embedding/Qdrant
 * services — see `retrieval.test.ts`.
 *
 * @module retrieval
 */

/** One phrasing-level hit from either retrieval leg, already ordered best-first. */
export interface RetrievalHit {
  readonly packId: string;
}

/** Reciprocal Rank Fusion's constant — the standard choice, per the spec. */
export const RRF_K = 60;

/**
 * Collapses a phrasing-level hit list (which can repeat a pack across several
 * matching phrasings) into that pack's best (lowest) 1-indexed rank within
 * the list. A pack's first, best-scoring appearance is what counts — later
 * repeats of the same pack are not a second, weaker vote.
 */
export function bestRankPerPack(hits: ReadonlyArray<RetrievalHit>): Map<string, number> {
  const ranks = new Map<string, number>();
  let rank = 0;
  for (const hit of hits) {
    if (ranks.has(hit.packId)) continue;
    rank += 1;
    ranks.set(hit.packId, rank);
  }
  return ranks;
}

/**
 * `score = Σ 1/(60 + rank_i)` over every ranked list a pack appears in. A
 * pack absent from a list simply contributes nothing from that list, rather
 * than being penalised with a worst-case rank — being found by only one leg
 * of the hybrid search is still real signal, per "tune for recall@5".
 */
export function reciprocalRankFusion(
  rankedLists: ReadonlyArray<ReadonlyMap<string, number>>,
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const ranks of rankedLists) {
    for (const [packId, rank] of ranks) {
      scores.set(packId, (scores.get(packId) ?? 0) + 1 / (RRF_K + rank));
    }
  }
  return scores;
}

/**
 * Rescales raw RRF scores onto 0..1 by dividing by the best score a pack
 * could possibly get: ranked #1 in every one of `numLists` lists, i.e.
 * `numLists / (RRF_K + 1)`. Raw RRF scores top out around 0.033 for two
 * lists (`2/61`), which is nowhere near the 0.85/0.25 thresholds
 * `PromptbarResolution.skipAgent`'s frozen doc comment is written against —
 * without this rescale, `retrievalScore` could never exceed ~0.033 and
 * `skipAgent` would be permanently `false` no matter how unambiguous a
 * match was. This keeps "not a probability" true (per `PromptbarCandidate`'s
 * doc comment) while making the score comparable to a 0..1 confidence.
 */
export function normalizeRrfScores(scores: ReadonlyMap<string, number>, numLists: number): Map<string, number> {
  const bestPossible = numLists / (RRF_K + 1);
  const normalized = new Map<string, number>();
  for (const [packId, score] of scores) {
    normalized.set(packId, bestPossible > 0 ? score / bestPossible : score);
  }
  return normalized;
}

/** The fused ranking's best `limit` packs, highest score first. */
export function topFusedPackIds(
  scores: ReadonlyMap<string, number>,
  limit: number,
): ReadonlyArray<{ readonly packId: string; readonly score: number }> {
  return [...scores.entries()]
    .map(([packId, score]) => ({ packId, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * The stage-3-skip shortcut from `PromptbarResolution`'s frozen doc comment:
 * confident enough (top score > 0.85, and a > 0.25 gap to the runner-up) to
 * hand `candidates[0]` straight to the caller without an agent call choosing
 * among them. `candidates` must already be sorted best-first.
 */
export function computeSkipAgent(candidates: ReadonlyArray<{ readonly retrievalScore: number }>): boolean {
  if (candidates.length < 2) return false;
  const first = candidates[0]!;
  const second = candidates[1]!;
  return first.retrievalScore > 0.85 && first.retrievalScore - second.retrievalScore > 0.25;
}

/**
 * Turns free text into an FTS5 `MATCH` query that is permissive (OR across
 * tokens, per "tune for recall@5, be permissive") and safe against FTS5's
 * query-syntax operators (`-`, `"`, `*`, `:`, `NEAR`, ...) which raw user text
 * can trip over and turn into a query *syntax* error rather than a search
 * with zero results. Each token is quoted as an FTS5 string literal so its
 * contents are never parsed as an operator; a literal `"` inside a token is
 * escaped by doubling, FTS5's own escape rule for a `"..."` string.
 *
 * Returns `null` for text with no indexable tokens (e.g. all punctuation),
 * which callers should treat as "skip the BM25 leg" rather than run a
 * `MATCH ""` that SQLite would reject.
 */
export function buildFtsMatchQuery(text: string): string | null {
  const tokens = text.match(/[\p{L}\p{N}]+/gu);
  if (tokens === null || tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
}
