# Security

Outpost is a personal, single-user sync server. It does not try to be a hardened
multi-tenant service, and the honest version of that sentence is the most useful
thing this document can say.

## The threat model, in one paragraph

There are no accounts, no sessions and no tokens. Every request to `/api` is
trusted: `GET /api/notes?since=0` returns **every note in the database**, and
`POST /api/sync` writes whatever a well-formed batch says. The API also answers
`Access-Control-Allow-Origin: *`, so any page you happen to have open can talk to it
if it can reach it. Notes are stored unencrypted in a plain SQLite file
(`server/data/outpost.db`, or the `outpost-data` volume under Compose), and the
reference setup serves the app over plain HTTP.

**Run it on localhost, on your own LAN, or behind a proxy that adds authentication
and TLS. Do not put it on the public internet as it is.**

## What is protected anyway

- **Request validation.** `POST /api/sync` is rejected with `400` before anything is
  written when a batch is malformed: at most 200 mutations, `deviceId` and mutation
  ids up to 128 characters, note text up to 20 000 characters, at most 32 tags of 64
  characters each. A rejected request writes nothing.
- **Idempotency.** Mutation ids are recorded in an `applied_mutations` ledger, so a
  replayed batch cannot apply the same change twice.
- **Optimistic revision checks.** A mutation based on a stale `rev` is answered with
  `conflict` instead of overwriting a version it never saw.
- **Note content is text, not markup.** Titles, bodies and tags are rendered as
  text; note content never reaches an HTML sink.

## Known gaps (deliberate, roughly in the order they are likely to bite)

1. **No authentication or authorisation** — see the threat model above.
2. **No rate limiting**, and the JSON body is parsed before it is validated, so a
   large request is read into memory first. Do not expose the port to a network you
   do not trust.
3. **`POST /api/dev/reset` wipes the database.** It is disabled when
   `NODE_ENV=production` unless `ALLOW_RESET=true`, and `docker-compose.yml` sets
   that flag so the demo's inspector button works. Set it to `false` (or drop the
   variable) for anything that is not a demo.
4. **Tombstones expire** after 30 days (`OUTPOST_TOMBSTONE_TTL_MS`). That is a data
   lifecycle decision rather than a security one: an expired tombstone lets a device
   that has been offline for months resurrect a note somebody deleted.
5. **The service worker caches the app shell.** The API is deliberately never
   cached, so a worker cannot serve stale notes, but a cached shell survives until
   the next update.

## Reporting a vulnerability

Report privately — **not** in a public issue:

- GitHub → **Security** → **Report a vulnerability** on
  <https://github.com/VitalieCondorache/outpost>.

Include the commit or version, what you did, what happened and what you expected. A
reproduction against a fresh database is worth more than a scan report. There is no
bug bounty and no SLA — this is a single-maintainer project — but reports are read
and answered as soon as possible, and you will be credited in the advisory unless
you would rather not be.

## Supported versions

There are no tagged releases yet; only the tip of `main`.
