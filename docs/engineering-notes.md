# Engineering notes

Six bugs that only appeared when the thing was actually run, and what they taught
me — plus an interlude about a suite that was fragile for a different reason.
Every entry has the symptom, the evidence that found it, the cause, the fix and
the test that now prevents it.

This is the part of the project I would talk about in an interview, because none of
it is visible in a feature list.

---

## 1. The shipped server could not start (and every unit test was green)

**Symptom.** `npm test` green, `npm run dev` fine, but the end-to-end suite died
before the first test: `Process from config.webServer was not able to start`.

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'sqlite'
  imported from /…/server/dist/index.js
```

**How it was found.** The E2E suite boots the _built_ artefact (`node
server/dist/index.js`). One `grep` in the output settled it:

```console
$ grep -n sqlite server/dist/index.js
157:import { DatabaseSync } from "sqlite";
```

The source says `node:sqlite`; the bundle said `sqlite`.

**Cause.** tsup bundles with esbuild plus its own `node-protocol-plugin`, which
strips the `node:` prefix from **every** builtin import (a workaround for runtimes
older than Node 14.18). `sqlite` is a new builtin, so the rewrite turned a valid
import into the name of a package that does not exist.

**Fix.** One documented flag in `server/tsup.config.ts`:

```ts
removeNodeProtocol: false, // keep `node:sqlite` intact
```

**Why it cannot come back.** The end-to-end suite starts the built server on every
run, so a broken bundle fails CI. The unit tests could never have caught this: they
import the TypeScript source, not the artefact. _Test the thing you ship._

---

## 2. "Listening on localhost" is not "listening on 127.0.0.1"

**Symptom.** Playwright: `Timed out waiting 60000ms from config.webServer`, with no
other error. The dev API was healthy on the same port.

**How it was found.** Starting the servers by hand and curling them:

```console
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/api/health
200
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4173/
000
```

The API answered on IPv4, the Vite preview server did not — its log said it was
listening, because `localhost` resolved to `::1` on this machine. The health check
probes `127.0.0.1`, so it never connected.

**Fix.** Make the binding explicit instead of relying on name resolution:

```ts
preview: { host: '127.0.0.1', port: 4173, strictPort: true, … }
```

**Why it cannot come back.** The E2E suite (and the same config in CI) fails if the
preview server is unreachable on IPv4. Worth knowing for any container health check:
`localhost` is a promise, an address is a fact.

---

## 3. The editor ate the first keystrokes — and the logs named the culprit

**Symptom.** A screenshot script that created three notes ended up with titles
attached to the _wrong_ notes: the first note went back to "Untitled note", the
second title landed on the first note, and the server agreed (rev 1, empty payload).

**How it was found.** Guessing was going nowhere, so I added two temporary structured
logs — one in the mutation builder, one at the push/pull boundary — and captured the
browser console from the driver:

```
[outbox] commit c3b4 ""                  rev=0 op=create (new)
[sync]   pushed create:61dc -> applied rev=1
[outbox] commit c3b4 "Sync engine notes" rev=2 op=update (new)   ← the wrong note id
[outbox] commit 1b18 ""                  rev=0 op=create (new)   ← the new note, empty
```

The commit for the second note's title was logged against the **first** note's id.
That single line localised it: the keystrokes went to a form that was still mounted
for the previously selected note.

**Cause.** `NoteEditor` reset its draft state in a `useEffect` that runs _after_ the
commit, and the App set the new selection after `await createNote()`. Between those
two moments the old form was still in the DOM, so text typed in that window landed on
the previous note and was then wiped by the reset. A human never hits a ~5 ms window
behind a click; a driver does, every time.

**Fix.** Delete the timing dependency instead of tightening the wait: the form is
remounted per note (`key={note.id}`), so the draft is initialised _during render_, and
pending keystrokes are flushed on unmount.

**Why it cannot come back.** A regression test asserts the input value synchronously
right after typing, which fails on any implementation that resets the draft
post-commit.

**Bonus, on purpose.** The temporary debug logs were too useful to throw away, so
they became a feature: `localStorage.setItem('outpost:debug', '1')` prints the whole
mutation lifecycle (`app/src/lib/debug.ts`).

---

## 4. The badge said "Synced" while a change was stuck in retry

**Symptom.** A flaky unit test: after a failed push, the engine sometimes reported
`phase: 'idle', failures: 0` while the mutation was still in the outbox.

**How it was found.** Reasoning about the state machine rather than about the test: a
sync pass does push → pull, and the pull can succeed _after_ the push failed. Success
reset the failure counter unconditionally, so any pass that had nothing to send
(everything was waiting for its retry delay) looked like a healthy sync.

**Cause.** "The pass completed" was conflated with "the outbox drained".

**Fix.** A pass only clears the failure state when it actually pushed something:

```ts
if (pushed > 0) this.failures = 0;
this.patch({ phase: this.failures > 0 ? 'error' : 'idle', … });
```

**Why it matters.** Otherwise the UI lies by omission: a green badge while a note has
not left the device. Tests now assert `pending` _and_ `phase` together after a
failure, and that a retry that succeeds clears both.

---

## 5. Interlude: the test suite was time-fragile

Not a product bug, but a design mistake worth writing down. UI tests here drive
several interactions against a real IndexedDB (via `fake-indexeddb`), which on a
loaded machine exceeded Vitest's 5 s per-test default — and was then reported as a
timeout instead of the assertion that actually failed.

The fix is a budget hierarchy, not a sleep:

- `testTimeout: 15_000` — how long a whole scenario may take;
- `asyncUtilTimeout: 3_000` — how long one `waitFor` may poll, deliberately lower so
  a real failure surfaces as an assertion, not as a timeout;
- tests that wait for a scheduled retry **poll for the state** instead of sleeping a
  hard-coded 700 ms.

Four consecutive full runs green afterwards — and the reasoning lives next to the
numbers instead of in someone's head.

---

## 6. The test double disagreed with the server about tombstones

**Symptom.** A UI test failed about once every five full runs, always in the same
place: `moves a note to the trash and restores it from there` →
`AssertionError: expected 1790526667718 to be null`. The note visibly left the
trash and then went back in. A rerun passed, so it looked like timing.

**How it was found.** Retrying the test destroys the evidence, so the scenario was
moved into a loop that ran it thirty times inside one process, recording every
`deletedAt` the store published and dumping the local note, the outbox and the
server state whenever it ended wrong. Eleven of the thirty runs failed, all with
the same trace:

```
PUSH [create base=0 del=null]           -> [applied rev=1]
PUSH [delete base=1 del=1790526855621]  -> [applied rev=2]
PUSH [update base=2 del=null]           -> [applied rev=3]
  local  rev=3 deletedAt=1790526855609   ← the tombstone came back
  server rev=3 deletedAt=1790526855609
```

The restore really was pushed. The answer to it still carried a tombstone, and by
design the client adopts what the server says is authoritative. One `grep` for the
field on both sides named the culprit:

```console
$ grep -n 'deletedAt' app/src/test/fake-server.ts server/src/db.ts
fake-server.ts:120:  deletedAt: payload?.deletedAt ?? existing?.deletedAt ?? null,
db.ts:230:           const deletedAt =
db.ts:231:             mutation.kind === 'create' || payload.deletedAt === null ? null : …
```

**Cause.** `null` is a value in this protocol — it means "restore" — and `??`
treats it as an absent field, so the double kept a tombstone the real server
clears. Every unit test stayed green because the wrong object was the only server
those tests ever talked to.

**Fix.** The double implements the rule instead of the shortcut:

```ts
const deletedAt =
  mutation.kind === 'create' || payload?.deletedAt === null
    ? null
    : (payload?.deletedAt ?? existing?.deletedAt ?? null);
```

**Why it cannot come back.** `app/src/test/fake-server.test.ts` pins the rules the
two implementations share (an explicit `null` clears a tombstone, silence keeps
it, a second delete of the same note is a no-op, a stale `baseRev` is a conflict)
and `app/src/sync/engine.test.ts` replays the exact interleaving — trash, let the
`delete` reach the server on its own, then restore. Both fail on the old
behaviour. Same lesson as §1, one layer up: _a double is an assertion about
somebody else's code, so it needs its own tests._

---

## 7. The GIF encoder's code width grew one code too early

**Symptom.** `node --test tools/lib/gif.test.mjs` failed on the one test that
matters: the round trip in which a second, independently written decoder reads the
encoder's own bytes back. Five of six tests passed.

**How it was found.** A failing round trip proves that two implementations
disagree, not which one is wrong, so the file went to a decoder that shares no
code with either of them — Chromium, through a canvas. The probe bitmap (flat
bands plus a checkerboard, chosen so that corruption cannot look like noise) came
back **99.9% wrong pixels**, worst channel error 251 of 255. The encoder was the
one that lied.

**Cause.** GIF's LZW grows its code width as the table fills, and the two sides do
not count at the same moment: a decoder only learns an entry when it reads the
_next_ code, so its table is always one code behind the encoder's. Growing on
`nextCode === 1 << codeSize` writes the first wider code while the decoder is still
reading the old width — and every code after that is misaligned.

**Fix.** Count from the decoder's side, and handle the 12-bit ceiling explicitly
(4095 is the last legal code):

```ts
if (codeSize === 12) {
  if (nextCode === 1 << 12) {
    emit(clearCode);
    resetDictionary();
  }
} else if (nextCode - 1 === 1 << codeSize) {
  codeSize += 1;
}
```

**Why it cannot come back.** Those tests now run in CI (`npm run test:tools`), so
the encoder can no longer rot in an unreferenced file, and they were checked
against a real decoder: the probe comes back pixel-exact in Chromium, and so does
a 512×512, 256-colour image — the size that crosses the 12-bit ceiling and forces
a Clear code, a path no unit test reached.

---

## The pattern

1. **Reproduce where it actually runs.** Four of the six were invisible to the unit
   suite — a bundler artefact, a real socket, an event loop and a rendering
   lifecycle. The other two were only found by asking something _outside_ the repo
   for an opinion: a decoder that shares no code with ours, and a loop that ran the
   flaky scenario thirty times instead of retrying it once.
2. **Add a log that answers the question you are asking**, then delete it — or, if it
   was useful, promote it into the product.
3. **Fix the design, not the timing.** Every wait I shortened made the _test_ pass;
   every wait I deleted made the _code_ correct.
4. **Leave a test that fails for the old behaviour.** A bug you cannot reproduce in a
   test is a bug you will meet again.
