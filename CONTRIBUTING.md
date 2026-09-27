# Contributing

Small project, few rules, all of them about keeping the sync engine honest.

## Getting set up

```bash
npm install
npm run dev          # API on :8787, app on :5173
```

Node **22.5+** is required: the API uses `node:sqlite`, which is bundled with the
runtime (no native module to compile).

## Before you open a pull request

```bash
npm run format:check
npm run typecheck
npm run lint
npm test
npm run build && npm run size
npm run e2e          # builds first; needs `npx playwright install chromium` once
```

CI runs exactly these steps.

## Conventions

- **TypeScript strict.** No `any`, no non-null assertions. `noUncheckedIndexedAccess`
  is on, so array access is `T | undefined` — handle it.
- **Tests are part of the change.** Behaviour of the sync engine (coalescing,
  retries, conflicts, tombstones) must be covered in
  `app/src/sync/engine.test.ts` or `app/src/db/repo.test.ts`; server rules go in
  `server/test/`.
- **Comments explain _why_, not _what_.** The interesting parts of this codebase
  are decisions: read `docs/adr/` before changing the sync semantics.
- **Commits** follow Conventional Commits (`feat:`, `fix:`, `refactor:`,
  `docs:`, `test:`, `chore:`).
- **The protocol is shared.** Anything that travels between client and server is
  typed in `packages/shared/src/index.ts` — update it once, never duplicate it.

## Changing the sync protocol

The protocol has three invariants. Breaking one of them is a data-loss bug:

1. A mutation `id` never changes across retries (idempotency).
2. `baseRev` is the revision the change was **based on**, not the revision it
   expects to produce.
3. Deletions are tombstones, never row removals, until the retention window
   expires.

If a change touches any of them, add an ADR next to the existing ones.

## Reporting a sync bug

Please include:

- the sync inspector contents (phase, pending, cursor, outbox rows),
- whether it reproduced offline, after a reload, or with two tabs/devices,
- the server log lines around `POST /api/sync` (start the API with the default
  logger enabled).
