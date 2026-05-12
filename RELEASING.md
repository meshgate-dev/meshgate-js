# Releasing `@meshgate/sdk`

This repository is public, so this checklist describes the release contract without
including private Meshgate Test credentials, tenant IDs, or internal staging setup.

## Release Rule

Do not publish a new SDK version to npm until the packed release candidate has
passed both SDK-local checks and Meshgate application compatibility checks.

The npm package should be the artifact of a verified release, not the first place
we discover app compatibility issues.

This repo uses Changesets. The publish workflow may publish after the generated
version PR is merged to `main`, so do not merge that version PR until internal
Meshgate Test validation is green.

## Release Candidate Flow

1. Prepare the release branch.
   - Confirm the intended semantic version.
   - Update `CHANGELOG.md` or the Changesets-generated release notes.
   - Keep release PRs focused on SDK changes and release metadata.
   - If using Changesets, treat the generated version PR as the final publish
     gate.

2. Run SDK-local checks.

   ```bash
   pnpm install
   pnpm run typecheck
   pnpm run lint
   pnpm run test
   pnpm run build
   npm pack --dry-run
   ```

3. Create a local package artifact.

   ```bash
   npm pack
   ```

   This produces a file like `meshgate-sdk-0.2.3.tgz`. Treat this tarball as the
   release candidate that must be tested by the consuming Meshgate application.

4. Validate the tarball against Meshgate Test.
   - Install the tarball into the private Meshgate application repository.
   - Run the Ratify local E2E suite.
   - Run the Ratify remote E2E suite against Meshgate Test.
   - Confirm the SDK pilot flows pass with the tarball installed.

   The detailed commands and environment setup live in the private Meshgate
   repository because they reference internal test infrastructure.

5. Publish only after compatibility is green.

   ```bash
   npm publish --access public
   ```

6. Verify the published package.

   ```bash
   npm view @meshgate/sdk version
   npm view @meshgate/sdk dist.tarball
   ```

7. Update consuming apps to the published version.
   - Replace any tarball-based test dependency with the published semver.
   - Open a small dependency bump PR in the consuming application repository.
   - Re-run the app-side checks if the published artifact differs from the
     tarball that was validated.

## If Compatibility Fails

Do not publish the SDK.

Fix the SDK, create a new release-candidate tarball, and restart the app-side
validation flow. Do not reuse a failed tarball as release evidence.

## Public Repo Safety

Do not commit, paste, or reference private staging secrets in this repository.
Internal Meshgate Test details belong in the private application repository.
