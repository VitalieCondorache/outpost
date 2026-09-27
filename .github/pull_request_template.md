## What changed

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `npm run format:check && npm run typecheck && npm run lint && npm test` is green
- [ ] `npm run e2e` is green (or the change cannot affect it, say why)
- [ ] New behaviour has a test — sync behaviour in `app/src/sync/engine.test.ts`
      or `app/src/db/repo.test.ts`, server rules in `server/test/`
- [ ] No new runtime dependency unless it is justified in the description
- [ ] `npm run size` still fits the bundle budget

## Sync protocol checklist

Skip if the change does not touch the client/server contract.

- [ ] Mutation ids stay stable across retries (idempotency)
- [ ] `baseRev` is still the revision the change was _based on_
- [ ] Deletions are still tombstones, not row removals
- [ ] `docs/adr/` has been updated if one of the invariants changed
