# Releasing

Releases are built and published by GitHub Actions (`.github/workflows/release.yml`)
when a version tag is pushed.

## Prerequisites

Repository secrets `AMO_API_KEY` and `AMO_API_SECRET`: AMO API access credentials
(JWT issuer and secret) from the
[AMO key page](https://addons.mozilla.org/developers/addon/api/key/).
`pnpm sign:firefox` uses them to produce a signed Firefox build.

## Steps

1. Update `CHANGELOG.md`: move the `[Unreleased]` entries into a new
   `## [X.Y.Z] - YYYY-MM-DD` section and leave `[Unreleased]` empty.
2. Bump `version` in `package.json` and commit: `chore(release): bump version to X.Y.Z`
3. Tag the commit and push both:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

4. The `Release` workflow runs the CI suite, builds every target, signs the
   Firefox build, and publishes a GitHub Release titled `Translaneur vX.Y.Z`.

The release description has three parts: a **What's New** section taken from
the tag version's CHANGELOG entry, a fixed Installation section (the template
in `scripts/release-body.ts`), and GitHub's auto-generated changelog link
appended at the end.

The tag must match `package.json` (`vX.Y.Z` against `X.Y.Z`) and CHANGELOG.md
must contain a `## [X.Y.Z]` entry; the workflow fails otherwise.

## Assets

| File | Notes |
| --- | --- |
| `translaneur-X.Y.Z-chrome.zip` | Chrome / Edge |
| `translaneur-X.Y.Z-firefox.xpi` | AMO-signed via `web-ext sign --channel unlisted` (self-distribution) |
| `translaneur-X.Y.Z-thunderbird.xpi` | Unsigned; Thunderbird installs it from file |

No Safari build is attached — it needs macOS, Xcode, and an Apple signing
team (see the README).

## Notes

- AMO refuses to sign a version it already has, so re-running the workflow for
  the same tag fails at the signing step. Bump the version and tag again.
- Signing waits for AMO's automated approval, which can take up to 15 minutes.
- `pnpm sign:firefox` also works locally with `WEB_EXT_API_KEY` and
  `WEB_EXT_API_SECRET` set in the environment.
