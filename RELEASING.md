# Releasing FluxCache

Publishing is a manual, reviewed step. This checklist does not change the
version or publish by itself; the maintainer must complete the version and
publication steps deliberately.

## Before changing the version

1. Start from a clean `main` checkout with the release commit reviewed and
   merged.
2. Install exactly the lockfile and run the complete gate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm verify
   pnpm coverage
   pnpm test:e2e
   pnpm bench:ci
   ```

3. Verify the publishable package, not just the source tree:

   ```bash
   pnpm pack --pack-destination /tmp/flux-cache-release
   pnpm pack --pack-destination /tmp/flux-cache-release --json
   ```

   Confirm the tarball contains `dist`, `README.md`, `LICENSE`,
   `CHANGELOG.md`, the linked `docs` files and `bench/README.md`. It must not
   contain tests, coverage, benchmark results, `.env` files or credentials.

4. Install that tarball into a fresh consumer and verify all three entry points:

   ```bash
   node --input-type=module -e "import('flux-cache').then(console.log)"
   node --input-type=module -e "import('flux-cache/react').then(console.log)"
   node -e "require('flux-cache'); require('flux-cache/react')"
   ```

   Also compile a small TypeScript consumer using
   `moduleResolution: NodeNext`, and exercise a React 18 and React 19 install.
   Confirm Node 18, 20 and 22 runtime imports where those runtimes are supported.

5. Review `npm publish --dry-run` output and the generated README links.

## Version and changelog

1. Decide the release version with the maintainers. Follow Semantic
   Versioning; `0.1.0` is the initial release candidate.
2. Move the relevant `[Unreleased]` entries in [CHANGELOG.md](CHANGELOG.md)
   under the release version and leave a new `[Unreleased]` section.
3. Update `version` in `package.json` in a dedicated reviewed commit. Do not
   publish from a branch build.
4. Re-run the full gate above against the versioned commit.

## Repository metadata

`repository`, `homepage` and `bugs` in `package.json` point at the canonical
GitHub project (`iambandirakesh/FluxCache`). If the project moves, update all
three in the same reviewed commit and re-run `pnpm check:package`.

## Publish

1. Create and review an annotated tag matching the package version.
2. Publish with the maintainer’s authenticated npm account:

   ```bash
   npm publish --access public
   ```

3. Verify the published version and tarball:

   ```bash
   npm view flux-cache version dist.tarball
   npm pack flux-cache@<version> --dry-run
   ```

4. Open a follow-up commit for any post-publish corrections; never rewrite a
   published tag.

## Rollback

If a published release is broken, deprecate the version with npm rather than
deleting history:

```bash
npm deprecate flux-cache@<version> "reason and replacement version"
```

Publish a corrected patch release after the fix is verified.
