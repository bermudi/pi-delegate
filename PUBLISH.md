# Publishing v3 (gated — do not run without bermudi's explicit yes)

The yes must name the publish/release itself. Approval of a subset of a
bundled ask ("merge", "ship it to main") is NOT release approval —
learned 2026-10-08 when "merge please" was executed as merge + tag +
npm publish. If the operator's reply does not say publish/release/tag,
ask once, plainly, before pushing any `pi-delegate-v*` tag.

v3 ships as `@bermudi/pi-delegate@0.3.1`, displacing v1 (0.1.23) for
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

    git tag pi-delegate-v0.3.1 && git push origin main pi-delegate-v0.3.1

Watch the workflow run; npm lists 0.3.1 when it finishes.

## Post-publish verification

1. `npm view @bermudi/pi-delegate version` → 0.3.1.
2. On the operator machine, `pi update --extensions` picks the release
   up — the `~/.pi/agent/settings.json` entry is the **unversioned**
   `npm:@bermudi/pi-delegate`. An exact `@x.y.z` pin makes `pi update`
   report "Updated" while doing nothing (seen 2026-10-03); only
   `pi install npm:...@x.y.z` moves a pinned entry, and rollback to a
   specific version still uses exactly that form. Keep the normal entry
   unpinned.
3. In a scratch directory (NOT this repo): `pi install
   npm:@bermudi/pi-delegate`, start `pi`, dispatch one single-task and
   one two-task call — verify both return tickets and wake with results.
   Verify `async:false` returns inline, removed aliases reject, compact
   hides and rejects advanced controls, and `"surface":"full"` plus
   reload enables the retained advanced controls.
4. Confirm the OLD v1 behavior is gone in that install (sync-default
   batches and kitchen-sink tool schema) — the displacement worked.

## Rollback

npm cannot unpublish after 72h. Before that window: `npm unpublish
@bermudi/pi-delegate@0.3.1` restores 0.1.23 as latest. The local
rollback is flipping the settings.json pin back to
`npm:@bermudi/pi-delegate@0.1.23`. Document any rollback in
COMPATIBILITY.
