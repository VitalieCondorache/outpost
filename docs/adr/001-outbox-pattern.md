# ADR 001 — Outbox pattern with mutation coalescing

Status: accepted
Date: 2026-01-01
Context: `app/src/db/repo.ts`, `app/src/sync/engine.ts`

## Context

A local-first client must be able to edit data with no network and reconcile
later. The naive approach — keep a queue of every edit and push them in order —
breaks in two ways:

1. **Self-conflicts.** Typing in a note produces dozens of edits. If each one
   becomes a mutation that carries the revision it was based on, the first
   mutation advances the server revision and every following mutation in the same
   queue becomes stale, i.e. the client fights itself.
2. **Unbounded growth.** The queue grows with keystrokes, and so does the work
   needed on reconnect.

## Decision

Each local write is stored **together with its mutation** in a single IndexedDB
transaction (`notes` + `outbox` stores), so a crash can never separate them.
On top of that:

1. **Coalescing.** While a mutation for a note is still _unsent_ and _not in
   flight_, a new edit replaces its payload instead of appending a mutation. The
   effective queue is therefore "the current state of each dirty note", not the
   history of keystrokes.
2. **Claiming.** `takeBatch` marks mutations `inFlight` so they cannot be picked
   up twice, and hands out **at most one mutation per note per batch**.
3. **Chaining.** A mutation written while a previous one for the same note is in
   flight becomes a second mutation, and after the first one is acknowledged,
   `bumpChainBaseRev` moves the second one's `baseRev` to the revision the first
   one produced. The chain is legitimate: mutation #2 _is_ based on mutation #1.
4. **Retry anchoring.** Failed mutations store `nextAttemptAt` instead of an
   absolute timer, so a reload, a closed tab or a long offline period cannot lose
   or double-fire the retry schedule.

`kind` is recomputed when mutations merge, because a pending `delete` that turns
into a restore (or into an edit inside the trash) must be sent as an `update` —
otherwise the server would discard the payload.

## Consequences

- The outbox is small (one mutation per dirty note) and the reconnect burst is
  bounded by the number of notes touched, not by the number of keystrokes.
- Mutations are idempotent by construction: their `id` never changes, so the
  server can deduplicate a retry after a lost response.
- Cost: the coalescing rule is stateful and needs the tests in
  `app/src/db/repo.test.ts` to stay honest.
- Rejected alternative: CRDTs (Yjs/Automerge). They remove conflicts entirely but
  make the payload opaque and the server trivial; the explicit protocol here is
  smaller, inspectable in the UI, and demonstrates the reasoning behind the
  conflict UI instead of hiding it behind a library.
