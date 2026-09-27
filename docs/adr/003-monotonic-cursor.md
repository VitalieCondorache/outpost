# ADR 003 — Delta sync with a monotonic sequence cursor

Status: accepted
Date: 2026-01-01
Context: `server/src/db.ts` (`seq` counter), `app/src/sync/engine.ts`

## Context

After pushing its own changes, a client must learn what _other_ devices changed.
The obvious cursor is a timestamp: `GET /api/notes?since=<lastUpdatedAt>`.

Timestamps are a trap:

- Two writes in the same millisecond collapse into one cursor position; the
  second row is never delivered (silent, permanent data loss until a full resync).
- Clock skew and timezone handling make the value meaningless across machines.
- A monotonic clock is not guaranteed (`Date.now()` can jump backwards).

## Decision

The server keeps a `counters` row (`seq`) that is incremented inside the same
transaction as every write, and stamps each note row with it. Clients pull with
`GET /api/notes?since=<seq>` and receive `{ notes, cursor }`, where the cursor is
the highest `seq` they were given. The value is opaque to the client.

Notes are returned in `seq` order, so a client can apply them incrementally
without buffering.

## Consequences

- Delta pulls can neither skip nor duplicate a row, regardless of write timing.
- The cursor is a plain integer with no clock semantics: safe to store, compare
  and log.
- Cost: one extra `UPDATE` + `SELECT` per mutation on the same counter row. That
  serialises writes to a single row — fine for this workload (a personal sync
  server), and the same trade-off SQLite's `AUTOINCREMENT` makes internally.
- The cursor is per server, not per device: it is stored in the client's `meta`
  store and survives reloads.
- Rejected alternative: soft-delete markers plus "return everything every time".
  Correct but wasteful, and it hides the interesting part of the problem.
