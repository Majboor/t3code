# publish-workspace-pack

What this does, what was tried, and what is left undone.

## What it does

Gives an agent a repeatable procedure for turning a workspace's Pack Mode
draft — `.t3pack/draft.pack.json`, accumulated turn by turn while Jev
(`typesafe/jev-1.13`) labels each turn's outcome and finding category — into a
real, signable pack under `packs/`, using the existing `packages/pack-cli`
`init`/`validate`/`sign`/`publish` pipeline that every other pack in this
directory already goes through. It is the second half of the Pack Mode
feature: Pack Mode itself only ever produces a draft (labeling is Jev's job,
and Jev can only emit typed classifications, never prose); turning that draft
into `capability.does`, real `knowledge.failureModes`/`knowledge.integration`
entries, and a README a stranger could act on needs a generative pass, which
this pack directs the agent already in the workspace to do.

## What was tried and rejected

**A server-side mechanical converter (draft JSON → pack.json by code, no
agent involved).** Rejected because the two are not the same shape of work:
`TurnLabel`/`PackDraftEntry` (in `apps/server/src/promptbar/TurnLabeling.ts`
and `PackDraft.ts`) carry only what Jev can classify — an outcome, a finding
category, a worth-keeping probability — never the prose a `failureModes[].symptom`
or an `integration[].detail.rationale` needs. A mechanical converter would
either fabricate that prose formulaically (poor packs) or leave it blank
(useless packs). The agent doing the pass already reads the actual prompts,
summaries and changed files in each entry and can write real sentences from
them, the same way it already writes every other pack's knowledge by hand.

**A new CLI subcommand (e.g. `t3-pack from-draft`) instead of a prompt-only
pack.** Rejected for now because the transform is a judgment call — which
entries are the same failure mode restated twice, which are worth an entry at
all versus folding into `capability.does` prose, what severity to assign —
and a fixed subcommand can't make those calls better than the agent already
making them for every hand-authored pack in this directory. If this pack sees
real use and a mechanical pre-pass (e.g., grouping entries by
`findingCategory` before handing them to the agent) turns out to save real
work, that grouping could move into `pack-cli` later; nothing here forecloses
it.

## What was verified, and how

Nothing yet — this pack was written in the same change that built Pack Mode's
draft-writing pipeline (`PackDraftWriter.ts`, the `packModeEnabled` field
threaded through `thread.turn.start`), before any real draft had accumulated
enough entries to run this pack's prompt against. The first real test is: run
a workspace with Pack Mode on for a handful of turns, then ask the agent to
publish, and check the resulting `pack.json` validates and the knowledge
entries it wrote actually match what happened in those turns rather than
paraphrasing the draft's field names back as prose.

## Left undone

- No real run yet (see above) — this handover should be rewritten once one
  happens, the same way `cloudflare-deploy`'s was.
- No guidance for what happens when a draft has very few entries (e.g. one
  or two) — whether the agent should still publish a thin pack or tell the
  person to keep working with Pack Mode on first. Left as a judgment call in
  the integration prompt for now.
- No automatic clearing or archiving of `.t3pack/draft.pack.json` after a
  successful publish — the draft keeps accumulating, and republishing is
  defined as a merge against the existing manifest (see this pack's
  `README.md`), but that merge logic has not been exercised against a draft
  that already has a prior publish behind it.
