# publish-workspace-pack

Turns a workspace's Pack Mode draft — `.t3pack/draft.pack.json`, built up turn
by turn while the person chats with their agent — into a real, signable
`.pack` under `packs/`. This is the "publish" half of Pack Mode: Pack Mode
only ever produces a draft; a human or agent still has to turn it into
knowledge someone else can read.

## Why this has to be a pack itself, not a server feature

Jev (`typesafe/jev-1.13`, the decision model that labels each turn as it
happens) is a typed classifier — every answer it can give is a probability
over a fixed set of choices, never free text. It can say a turn *succeeded*
and its finding was a *fix*; it cannot write the paragraph that explains
*why*. Turning a pile of labeled turns into a `capability.does`, a set of
`knowledge.failureModes`/`knowledge.integration` entries with real prose, and
a README a stranger could act on needs a generative pass — the same kind of
work a coding agent already does on every other pack in this directory. So
this isn't a script; it's a prompt that tells the agent already in the
workspace how to do that pass well, using the draft as its source material
instead of starting from nothing.

## The draft format

`.t3pack/draft.pack.json` (written by `PackDraftWriter.ts`, only while Pack
Mode is on) looks like:

```json
{
  "projectId": "...",
  "createdAt": "2026-09-19T03:00:00.000Z",
  "updatedAt": "2026-09-19T05:40:00.000Z",
  "entries": [
    {
      "turnId": "...",
      "labeledAt": "2026-09-19T03:12:00.000Z",
      "outcome": "succeeded" | "partial" | "failed",
      "findingCategory": "fix" | "gotcha" | "config" | "error_resolution" | "none",
      "worthKeeping": true,
      "userPrompt": "...",
      "assistantSummary": "...",
      "activitySummaries": ["..."],
      "changedFiles": ["apps/server/src/....ts"],
      "workspaceCwd": "/root/t3code-src"
    }
  ]
}
```

Every entry already cleared `WORTH_KEEPING_THRESHOLD` (0.5 on Jev's
`worth_keeping` noul question) before it was written — the file only holds
turns Jev itself judged were worth carrying forward, so there's no need to
re-filter for signal before reading it.

## What "publish" actually means here

There's a real `pack.json` format (2.0), documented by every sibling pack in
this directory, and a real CLI for it — `packages/pack-cli/src/bin.ts`
(`init`, `validate`, `sign`, `publish`, `version`). Publishing a workspace's
draft means going through that same pipeline, with the draft's entries as the
evidence behind the manifest instead of a person's own memory of what
happened. See `pack.json`'s `integration.prompt` for the exact steps.

## Re-publishing / improving

The draft file keeps accumulating as long as Pack Mode stays on — it is never
cleared by publishing. Asking the agent to "improve" or "add more to" a pack
built this way needs nothing new: `packs/<name>/pack.json`, `README.md` and
`handover.md` are ordinary files the agent already has read/write access to,
same as any other file in the workspace. Re-running this pack's prompt after
more turns have accumulated is a merge, not a fresh write: read the existing
manifest first, keep what's already there, and only add entries for turns
that aren't reflected yet.
