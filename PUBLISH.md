# Publishing v3 (gated — do not run without bermudi's explicit yes)

v3 ships as `@bermudi/pi-delegate@0.2.0`, displacing v1 (0.1.22) for
every machine on next `pi update`. The 0.x major bump signals the
breaking surface (background defaults, compact/full exposure, removed
compatibility synonyms) per semver 0.x convention. Package metadata is staged
(name/version/description/files, private removed); recheck the current tarball
under the gates below (delegate.ts, src/, README, COMPATIBILITY).

## Pre-publish gates (run all, in order)

1. `bun run typecheck && bun test` — full suite green.
2. Live dogfood: `pi -ne -e "$PWD/delegate.ts"` dispatching a real
   multi-task batch with telemetry enabled; read the misfire table.
   (The suite cannot catch host-layer seams.)
3. `npm pack` — inspect the tarball contents by hand once.
4. `sleep 60` before verifying anything below (house rule).

## Publish

    npm publish           # writes to the public registry — irreversible

## Post-publish verification

1. `sleep 60`, then `npm view @bermudi/pi-delegate version` → 0.2.0.
2. In a scratch directory (NOT this repo): `pi install
   npm:@bermudi/pi-delegate`, start `pi`, dispatch one single-task and
   one two-task call — verify both return tickets and wake with results.
   Verify `async:false` returns inline, removed aliases reject, compact hides
   and rejects advanced controls, and `"surface":"full"` plus reload enables
   the retained advanced controls.
3. Confirm the OLD v1 behavior is gone in that install (sync-default
   batches and kitchen-sink tool schema) — the displacement worked.

## Rollback

npm cannot unpublish after 72h. Before that window: `npm unpublish
@bermudi/pi-delegate@0.2.0` restores 0.1.22 as latest. Document any
rollback in COMPATIBILITY.
