# ADR 002 — Conflicts are resolved by the user, not by a policy

Status: accepted
Date: 2026-01-01
Context: `packages/shared/src/index.ts`, `server/src/db.ts`, `app/src/features/sync/ConflictPanel.tsx`

## Context

Two devices can edit the same note while one of them is offline. Something has to
decide what the note looks like afterwards. The usual answers are:

- **Last write wins (blind overwrite).** Cheap, but data disappears silently. For
  a notes app that is a data-loss bug, not a feature.
- **Field-level merge.** Better, but with free text there is no meaningful merge
  of two different paragraphs — only a guess about intent.
- **CRDT.** Correct and automatic, at the cost of a much larger surface (payload
  format, server model, debugging story).

## Decision

The server exposes **optimistic concurrency** and refuses to guess:

1. Every note has a server-assigned, monotonically increasing `rev`.
2. Every mutation declares the `rev` it was based on (`baseRev`).
3. If `baseRev` no longer matches, the mutation is **not applied**. The response
   carries the current server state (`status: 'conflict'`).
4. The client **parks** the mutation (`blocked: true`, excluded from the outbox
   scan) and records a conflict — persisted in IndexedDB, so a reload does not
   silently drop the decision.
5. The user chooses: _Keep mine_ (rebases the parked mutation on the server
   revision), _Keep theirs_ (drops the local edits for that note), or _Keep both_
   (the local version becomes a new note, the server version keeps its id).

The UI shows both versions side by side and says explicitly that nothing has been
overwritten.

## Consequences

- No silent data loss: the only way to lose a version is an explicit user action.
- The server stays dumb and fast: one integer comparison per mutation, no merge
  logic, no operation history.
- Cost: the user can be interrupted by a modal decision. In this app that is
  acceptable and arguably desirable — it is the moment where data would otherwise
  disappear.
- The same mechanism covers deletions: `deletedAt` is a normal synced field, so a
  "trash here, edit there" conflict goes through the same panel.
- Rejected alternative: silent field-level merging of `title`/`body`. It looks
  magic until the day it merges two paragraphs nobody wanted merged, and then the
  user cannot tell what happened.
