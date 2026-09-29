import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, beforeAll, describe, expect, vi } from "vitest";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { PromptbarClient } from "../Services/PromptbarClient.ts";
import { PromptbarClientLive } from "./PromptbarClient.ts";

const DECISION_API_URL = "https://openrouter.ai/api/alpha/decisions";

beforeAll(() => {
  // The decision model config reads this via Effect's Config from
  // process.env; every test mocks `fetch` itself, so the key never leaves
  // this process.
  process.env["T3CODE_OPENROUTER_API_KEY"] = "test-key";
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Loads the real `packs/*\/promptbar.json` files from this checkout (no
 * mocking of pack data) and rebuilds `pack_fts` against them; only the
 * external HTTP services (decision model/embedding/Qdrant) are mocked per
 * test.
 */
const TestLayer = PromptbarClientLive.pipe(Layer.provideMerge(SqlitePersistenceMemory));

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function mockExternalServices(options: {
  readonly intent: { choice: string; probabilities: Record<string, number> };
  /** Only present when a stage-3 disambiguation call is expected to run. */
  readonly decisionRelevance?: Record<string, number>;
}) {
  return vi.spyOn(globalThis, "fetch").mockImplementation((input: string | URL | Request, init?: RequestInit) => {
    const url = input.toString();
    if (url === DECISION_API_URL) {
      const body = JSON.parse(String(init?.body ?? "{}")) as { questions: Record<string, unknown> };
      const questionKeys = Object.keys(body.questions);
      // Stage 1 (intent classification) always asks exactly one "intent" question.
      if (questionKeys.length === 1 && questionKeys[0] === "intent") {
        return Promise.resolve(
          jsonResponse({
            answers: { intent: { type: "choice", choice: options.intent.choice, probabilities: options.intent.probabilities } },
          }),
        );
      }
      // Stage 3 (pack disambiguation): one noul question per candidate, keyed "relevant__<packId>".
      const answers: Record<string, { type: "noul"; noul: number }> = {};
      for (const key of questionKeys) {
        const packId = key.replace(/^relevant__/, "");
        const score = options.decisionRelevance?.[packId] ?? 0;
        answers[key] = { type: "noul", noul: score };
      }
      return Promise.resolve(jsonResponse({ answers }));
    }
    if (url.endsWith("/embed")) {
      return Promise.resolve(jsonResponse({ model: "nomic-embed-text", dim: 4, vector: [0.1, 0.2, 0.3, 0.4] }));
    }
    if (url.includes("/points/search")) {
      return Promise.resolve(
        jsonResponse({
          result: [
            {
              id: 1,
              score: 0.98,
              payload: {
                pack_id: "ssh_deploy",
                name: "Deploy over SSH",
                description: "Ship a project to a host over SSH",
                matched_phrasing: "deploy this to the server",
              },
            },
          ],
        }),
      );
    }
    return Promise.reject(new Error(`Unexpected fetch to ${url} in test`));
  });
}

describe("PromptbarClientLive.resolve", () => {
  it.layer(TestLayer)("real pack data, mocked decision model/embedding/Qdrant", (it) => {
    it.effect("ACTION: retrieves candidates and orders ssh_deploy first for a deploy-shaped query", () =>
      Effect.gen(function* () {
        mockExternalServices({
          intent: { choice: "ACTION", probabilities: { ACTION: 0.99, QUESTION: 0.003, STATEMENT: 0.003, CONTINUATION: 0.004 } },
        });

        const promptbar = yield* PromptbarClient;
        const resolution = yield* promptbar.resolve({
          text: "deploy this to the server",
          isFirstMessageInSession: true,
        });

        expect(resolution.intent).toBe("ACTION");
        expect(resolution.zone).toBe("attach");
        expect(resolution.candidates.length).toBeGreaterThan(0);
        expect(resolution.candidates[0]!.packId).toBe("ssh_deploy");
        expect(resolution.candidates[0]!.retrievalScore).toBeGreaterThan(0);
        // Real pack params come through unmodified from disk.
        expect(resolution.candidates[0]!.params.some((p) => p.name === "project")).toBe(true);
      }),
    );

    it.effect("STATEMENT: always empty candidates and silent zone, never touches embedding/Qdrant", () =>
      Effect.gen(function* () {
        const fetchSpy = mockExternalServices({
          intent: { choice: "STATEMENT", probabilities: { ACTION: 0.01, QUESTION: 0.01, STATEMENT: 0.97, CONTINUATION: 0.01 } },
        });

        const promptbar = yield* PromptbarClient;
        const resolution = yield* promptbar.resolve({ text: "this is annoying", isFirstMessageInSession: false });

        expect(resolution).toMatchObject({ intent: "STATEMENT", zone: "silent", candidates: [], skipAgent: false });
        // Only the stage-1 classification call, never embed/points-search/stage-3.
        expect(fetchSpy.mock.calls.map(([u]) => u.toString()).every((u) => u === DECISION_API_URL)).toBe(true);
        expect(fetchSpy.mock.calls).toHaveLength(1);
      }),
    );

    it.effect("CONTINUATION on a non-first message: passes through untouched with empty candidates", () =>
      Effect.gen(function* () {
        const fetchSpy = mockExternalServices({
          intent: { choice: "CONTINUATION", probabilities: { ACTION: 0.0157, QUESTION: 0.0017, STATEMENT: 0.0031, CONTINUATION: 0.9796 } },
        });

        const promptbar = yield* PromptbarClient;
        const resolution = yield* promptbar.resolve({ text: "also do that", isFirstMessageInSession: false });

        expect(resolution.intent).toBe("CONTINUATION");
        expect(resolution.candidates).toEqual([]);
        expect(fetchSpy.mock.calls).toHaveLength(1);
      }),
    );

    it.effect("CONTINUATION on the first message of a session: hard rule reclassifies and (if ACTION) still retrieves", () =>
      Effect.gen(function* () {
        mockExternalServices({
          intent: { choice: "CONTINUATION", probabilities: { ACTION: 0.9, QUESTION: 0.05, STATEMENT: 0.05, CONTINUATION: 0.9796 } },
        });

        const promptbar = yield* PromptbarClient;
        const resolution = yield* promptbar.resolve({
          text: "deploy this to the server",
          isFirstMessageInSession: true,
        });

        expect(resolution.intent).toBe("ACTION");
        expect(resolution.note).not.toBeNull();
        expect(resolution.candidates.length).toBeGreaterThan(0);
      }),
    );

    it.effect("computes skipAgent per the frozen formula off the fused candidate scores", () =>
      Effect.gen(function* () {
        mockExternalServices({
          intent: { choice: "ACTION", probabilities: { ACTION: 0.99, QUESTION: 0.003, STATEMENT: 0.003, CONTINUATION: 0.004 } },
        });

        const promptbar = yield* PromptbarClient;
        const resolution = yield* promptbar.resolve({
          text: "deploy this to the server",
          isFirstMessageInSession: true,
        });

        const [first, second] = resolution.candidates;
        const expected =
          resolution.candidates.length >= 2 &&
          first!.retrievalScore > 0.85 &&
          first!.retrievalScore - second!.retrievalScore > 0.25;
        expect(resolution.skipAgent).toBe(expected);
      }),
    );
  });
});
