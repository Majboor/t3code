# Spec: syncing a project to the cloud

The contract every wave of this feature implements against. Where the code and this
file disagree, this file wins — say so rather than inventing a variant.

## The one rule

**A sync never destroys work.** Every ambiguous case resolves by keeping more, not less.
That is the whole design, and every decision below falls out of it. A sync that loses a
morning's work is not a sync feature with a bug; it is a data-loss incident that happens
to have a progress bar.

Corollaries, in force everywhere:

1. **Nothing local is deleted by a sync.** Not on handoff, not on conflict, not on
   "the server says it's gone". The only thing that deletes a user's files is the user.
2. **A conflict is never resolved by choosing.** Both versions survive; the person decides
   later, with both in front of them.
3. **An edit beats a delete.** Redoing a delete costs a keystroke; recovering an edit that
   was deleted costs the work.
4. **A file the server has never seen is never removed**, whatever the server's index says.

## The two modes

The user is asked once, when they first share a project, and the wording matters as much
as the mechanism.

### `handoff` — "Move it to the cloud, work there"

A one-shot upload. After it completes the cloud copy is canonical and the app follows it.

- **The local directory is left exactly as it is.** "Move" is a product word, not a `mv`.
  The local copy becomes a dormant snapshot; the app stops writing to it and says so.
- Nothing watches the local tree afterwards. Edits made there later are invisible to the
  cloud, and the UI must say that plainly rather than letting someone discover it.
- Reversible: the person can pull the cloud copy back down into a directory of their
  choosing. That path must exist before this mode ships, or "move" is a trap.

### `mirror` — "Keep both in sync"

Continuous replication, local ↔ cloud, until switched off.

- A watcher on the local tree, a change feed from the server.
- Both directions. A change made by a collaborator in the browser reaches the laptop, and
  vice versa.
- Switching it off leaves both copies intact and diverging. That is fine and must be said.

## What wins when both sides changed

Not last-writer-wins. Clock skew between a laptop and a server makes "last" a guess, and a
wrong guess silently deletes the loser's work.

The unit of agreement is the **base revision**: the content hash both sides last agreed on
for a path. For every path, compare `local`, `remote` and `base`:

| local vs base | remote vs base | outcome |
|---|---|---|
| same | same | nothing to do |
| changed | same | upload local |
| same | changed | download remote |
| changed | changed, **same content** | agree; just advance the base — a coincidence, not a conflict |
| changed | changed, different content | **conflict** |
| deleted | same | delete remote, keep the local absence |
| same | deleted | **keep local**, restore remote from it (rule 3) |
| deleted | changed | **keep remote**, restore local from it (rule 3) |
| changed | deleted | **keep local**, restore remote from it (rule 3) |
| absent, no base | present | download |
| present, no base | absent | upload |

Rows the first table did not cover, settled while building `reconcile.ts` and now binding:

| case | outcome |
|---|---|
| base present, both sides absent | advance the base to a tombstone, so a stale base stops being reconsidered every pass |
| no base, both sides present, identical bytes | advance the base — same coincidence rule as above |
| no base, both sides present, different bytes | **conflict** |
| a base tombstone | counts as "no base": nothing was agreed, so nothing can be deleted against it |

`deleted` and `null` mean the same thing on the local and remote sides. Whether a path is
*gone* or *never existed* is derived from the base, not from a tombstone the scanner would
otherwise have to invent.

**A conflict keeps both.** The remote version takes the path (so collaborators in the
browser stay consistent with each other), and the local divergent copy is written beside it
as `<name> (conflicted copy <ISO date>)<ext>` — never overwritten, never cleaned up
automatically. The UI lists conflicts until the person deals with them.

### What the reconciler cannot enforce, and callers must

The decision function is pure and total, and four things still have to be true around it.
They are listed here because a later wave will be the one that gets them wrong:

1. **Never hand it a partial local scan.** An interrupted walk, a permission error, or an
   exclusion rule that changed between passes makes every unreported path look deleted —
   and every one of those whose remote is unchanged becomes a remote delete. A `Map` cannot
   say "this scan was complete". A pass must refuse to execute, and ask, when the number of
   remote deletions is implausible against the size of the tree.
2. **On a conflict, move the local file aside before writing the remote content.** The
   action names both paths but cannot order the two writes; the wrong order destroys exactly
   the work the conflict exists to save.
3. **A conflicted-copy name is a name, not a reservation.** Two conflicts on one path on the
   same UTC day produce the same name. The writer detects the collision and disambiguates —
   "never overwritten" is a promise only the thing touching the disk can keep.
4. **`handoff` does not run this.** These are mirror semantics; a remote delete has no
   meaning during a one-shot upload.

Hashes are content hashes. Modification times are used only as a cheap "might have
changed" filter before hashing, never as a tiebreak — a file whose mtime moved but whose
hash did not has not changed.

## Not everything syncs

Refuse by default, because the failure is expensive and silent:

- `.git/` — a repository half-replicated between two machines is worse than no repository.
  Sync the working tree; leave version control to version control.
- `node_modules/`, and anything in the project's `.gitignore`.
- Anything the OS writes and nobody edits: `.DS_Store`, `Thumbs.db`.
- Files above a size ceiling, and binaries the person did not ask for. Report what was
  skipped; a silent skip is how someone finds out at the worst moment.
- Symlinks are not followed. A link pointing outside the project is a way to exfiltrate a
  home directory into a shared workspace.

## Transport

Through the server's authenticated API — not ssh, not rsync. The person sharing a project
has an account, not necessarily a key to a box, and the cloud copy has to be reachable by
collaborators who have neither.

- Content-addressed by hash: ask what the server is missing, send only that. A re-share of
  a mostly-unchanged tree should move almost nothing.
- Resumable, and idempotent per chunk. A dropped connection mid-upload must not restart a
  gigabyte, and must never leave a half-written file visible as though it were whole.
- A file is only visible at its path once its bytes are complete and its hash verifies.

## Progress, and what "actively changing" means

The sync button reports what a person actually wants to know:

- files and bytes done vs total, for the current pass
- `idle` / `scanning` / `transferring` / `paused` / `error`
- **actively changing** — true when the watcher has seen a write in the last few seconds.
  This is why a sync that "never finishes" is not always broken: someone is typing.
- when the last full agreement completed, in plain words
- how many conflicts are waiting, if any

## The web side waits

A collaborator opening a shared project before the first sync completes must be told to
wait, and **turns must be refused until it does**. An agent let loose on a half-uploaded
tree will read a truncated file, conclude the code is broken, and confidently "fix" it.
That is worse than waiting, and much worse than saying so.

The wait state must distinguish "still uploading, N files left" from "the person who shared
this closed their laptop", because the advice differs.

## Where this can still hurt someone

Written down because whoever builds it should know what they are holding:

- **Two people, one mirrored project, both offline, both editing.** Conflicted copies pile
  up. Correct, and still unpleasant; the UI should make resolving them cheap.
- **A mirror is not a backup.** Deleting a file locally deletes it in the cloud, by design.
  Say so where the mode is chosen.
- **Large trees.** The first pass of a big project over a slow link is long. It must be
  interruptible and resumable, and it must not block the app.
