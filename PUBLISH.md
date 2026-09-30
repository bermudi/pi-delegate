# Publishing v3 (gated — do not run without bermudi's explicit yes)

v3 ships as `@bermudi/pi-delegate@0.3.0`, displacing v1 (0.1.23) for
every machine on next `pi update` or repin. The minor bump inside the
0.x line continues v1's versioning; the v3 surface is documented in
COMPATIBILITY.md.

Publish runs in CI, not locally: `.github/workflows/publish-npm.yml`
fires on `pi-delegate-v*` tags, verifies the tag equals
`package.json`'s version, gates install/typecheck/test/build, then
`npm publish --access public` via OIDC trusted publishing. Local npm
auth is not needed and `npm publish` should not be run by hand.

## Pre-tag gates (run all, locally, in order)

1. `bun run typecheck && bun test` — full suite green.
2. Live dogfood: `pi -ne -e "$PWD/delegate.ts"` dispatching a real
   multi-task batch with telemetry enabled; read the misfire table.
   (The suite cannot catch host-layer seams.)
3. `npm pack` — inspect the tarball contents by hand once.

## Publish

    git tag pi-delegate-v0.3.0 && git push origin main pi-delegate-v0.3.0

Watch the workflow run; npm lists 0.3.0 when it finishes.

## Post-publish verification

1. `npm view @bermudi/pi-delegate version` → 0.3.0.
2. In a scratch directory (NOT this repo): `pi install
   npm:@bermudi/pi-delegate`, start `pi`, dispatch one single-task and
   one two-task call — verify both return tickets and wake with results.
   Verify `async:false` returns inline, removed aliases reject, compact
   hides and rejects advanced controls, and `"surface":"full"` plus
   reload enables the retained advanced controls.
3. Confirm the OLD v1 behavior is gone in that install (sync-default
   batches and kitchen-sink tool schema) — the displacement worked.

## Rollback

npm cannot unpublish after 72h. Before that window: `npm unpublish
@bermudi/pi-delegate@0.3.0` restores 0.1.23 as latest. The local
rollback is flipping the settings.json pin back to
`npm:@bermudi/pi-delegate@0.1.23`. Document any rollback in
COMPATIBILITY.
