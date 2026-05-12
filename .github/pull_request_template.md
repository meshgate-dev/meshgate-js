## Summary

<!-- What changed, and why? -->

## Testing

<!-- Mark every check that applies. Explain any skipped check. -->

- [ ] `pnpm run typecheck`
- [ ] `pnpm run lint`
- [ ] `pnpm run test`
- [ ] `pnpm run build`

## Release Impact

- [ ] This PR does not require an npm release.
- [ ] This PR is a release candidate for npm.

If this PR is a release candidate:

- [ ] `npm pack --dry-run` passed.
- [ ] A release-candidate tarball was produced with `npm pack`.
- [ ] The tarball was validated against the private Meshgate application.
- [ ] Meshgate Test remote E2E passed before npm publish.
- [ ] No private staging secrets, tenant IDs, or internal env values are included in this PR.

## Notes

<!-- Reviewer context, follow-ups, or known limitations. -->
